const crypto = require('node:crypto');
const { getReply } = require('../services/reply.service');
const {
  parseHipotekarnaStatement,
  StatementError,
  BANK,
} = require('../importers/hipotekarna');
const {
  processStatement, learnCategory, listCategories, addCategory, CategoryNameError,
} = require('../services/transaction-store');
const { categoryButtonLabel } = require('../constants/categories');

const MAX_STATEMENT_SIZE = 10 * 1024 * 1024;
const addStatementButton = {
  reply_markup: { inline_keyboard: [[{ text: 'Добавить выписку', callback_data: 'statement:add' }]] },
};
const bankButtons = {
  reply_markup: { inline_keyboard: [[
    { text: 'Hipotekarna', callback_data: 'statement:hipotekarna' },
    { text: 'Payoneer', callback_data: 'statement:payoneer' },
  ]] },
};
function categoryButtons(token, categories) {
  const buttons = categories.map((category, index) => ({
    text: categoryButtonLabel(category),
    callback_data: `statement:category:${token}:${index}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  rows.push([{ text: '➕ Новая категория', callback_data: `statement:new-category:${token}` }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function downloadStatement(context, document) {
  if (document.file_size > MAX_STATEMENT_SIZE) {
    throw new StatementError('Файл слишком большой: максимум 10 МБ.');
  }
  const url = await context.telegram.getFileLink(document.file_id);
  const response = await fetch(url);
  if (!response.ok) throw new Error('Telegram download failed');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_STATEMENT_SIZE) {
    throw new StatementError('Файл слишком большой: максимум 10 МБ.');
  }
  return buffer;
}

async function replyImportError(context, error) {
  const detail = error instanceof StatementError ? error.message : 'ошибка чтения или сохранения файла.';
  await context.reply(`Не удалось импортировать выписку: ${detail}`);
}

function registerMessageController(bot, {
  download = downloadStatement,
  process = processStatement,
  learn = learnCategory,
  categories = listCategories,
  createCategory = addCategory,
} = {}) {
  const state = new Map();

  async function continueImport(context, session) {
    const result = await process(BANK, session.transactions);
    session.added += result.added;
    if (result.pending) {
      const token = crypto.randomBytes(4).toString('hex');
      const options = await categories();
      state.set(context.chat.id, {
        ...session, step: 'category', pending: result.pending, token, categories: options,
      });
      const transaction = result.pending;
      await context.reply(
        `Выберите категорию для операции ${transaction.date}: ${transaction.description} — ${transaction.amount} ${transaction.currency}.`,
        categoryButtons(token, options),
      );
      return;
    }
    state.delete(context.chat.id);
    await context.reply(
      `Hipotekarna: обработано списаний ${result.total}, новых ${session.added}, поступлений пропущено ${session.skippedIncoming}.`,
      addStatementButton,
    );
  }

  async function startImport(context, buffer) {
    const { transactions, skippedIncoming } = parseHipotekarnaStatement(buffer);
    await continueImport(context, { transactions, skippedIncoming, added: 0 });
  }

  bot.on('callback_query', async (context) => {
    const action = context.callbackQuery.data;
    if (!action?.startsWith('statement:')) return;
    await context.answerCbQuery();
    try {
      await context.editMessageReplyMarkup();
    } catch {
      // A stale or already edited message must not block the selected action.
    }
    const chatId = context.chat.id;

    if (action === 'statement:add') {
      state.delete(chatId);
      await context.reply('Для какого банка добавить выписку?', bankButtons);
    } else if (action === 'statement:payoneer') {
      state.delete(chatId);
      await context.reply('Импорт выписок Payoneer пока в разработке.', addStatementButton);
    } else if (action === 'statement:hipotekarna') {
      state.set(chatId, { step: 'file' });
      await context.reply('Пришлите выписку Hipotekarna файлом .xls.');
    } else if (action.startsWith('statement:new-category:')) {
      const token = action.split(':')[2];
      const pending = state.get(chatId);
      if (pending?.step !== 'category' || pending.token !== token) return;
      state.set(chatId, { ...pending, step: 'new-category' });
      await context.reply('Напишите название новой категории одним сообщением. Для отмены отправьте /cancel.');
    } else if (action.startsWith('statement:category:')) {
      const [, , token, indexText] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'category' || pending.token !== token) return;
      const category = pending.categories[Number(indexText)];
      if (!category) return;
      try {
        await learn(BANK, pending.pending.description, category);
        await continueImport(context, pending);
      } catch (error) {
        await replyImportError(context, error);
        await context.reply('Выберите категорию ещё раз.', categoryButtons(pending.token, pending.categories));
      }
    }
  });

  bot.on('message', async (context) => {
    const chatId = context.chat.id;
    const pending = state.get(chatId);
    const document = context.message.document;

    if (pending?.step === 'file') {
      if (!document || !/\.xls$/i.test(document.file_name || '')) {
        await context.reply('Пришлите выписку Hipotekarna файлом .xls.');
        return;
      }
      try {
        const buffer = await download(context, document);
        await startImport(context, buffer);
      } catch (error) {
        await replyImportError(context, error);
      }
      return;
    }

    if (pending?.step === 'category') {
      await context.reply('Выберите категорию операции кнопкой ниже.',
        categoryButtons(pending.token, pending.categories));
      return;
    }

    if (pending?.step === 'new-category') {
      const name = context.message.text?.trim();
      if (name === '/cancel') {
        state.set(chatId, { ...pending, step: 'category' });
        await context.reply('Выберите категорию операции.',
          categoryButtons(pending.token, pending.categories));
        return;
      }
      if (!name) {
        await context.reply('Пришлите название новой категории текстом.');
        return;
      }
      try {
        const result = await createCategory(name);
        await learn(BANK, pending.pending.description, result.category);
        await context.reply(result.added
          ? `Категория «${result.category}» добавлена.`
          : `Использую существующую категорию «${result.category}».`);
        await continueImport(context, pending);
      } catch (error) {
        if (error instanceof CategoryNameError) {
          await context.reply(error.message);
        } else {
          await replyImportError(context, error);
        }
      }
      return;
    }

    if (document) {
      await context.reply('Чтобы добавить выписку, нажмите кнопку «Добавить выписку».', addStatementButton);
      return;
    }
    await context.reply(getReply(), addStatementButton);
  });
}

module.exports = { registerMessageController };

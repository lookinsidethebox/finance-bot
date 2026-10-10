const crypto = require('node:crypto');
const { getReply } = require('../services/reply.service');
const {
  parseHipotekarnaStatement,
  StatementError,
  BANK: HIPOTEKARNA_BANK,
} = require('../importers/hipotekarna');
const {
  parsePayoneerStatement, PayoneerStatementError, BANK: PAYONEER_BANK,
} = require('../importers/payoneer');
const {
  processStatement, learnCategory, listCategories, addCategory, addCashExpense, CategoryNameError,
  listCurrencies, getCashCurrency, setCashCurrency, addCustomCurrency, CurrencyCodeError,
  excludeDescription,
} = require('../services/transaction-store');
const { categoryButtonLabel } = require('../constants/categories');

const MAX_STATEMENT_SIZE = 10 * 1024 * 1024;
const statementFormats = {
  [HIPOTEKARNA_BANK]: { name: 'Hipotekarna', extension: '.xls', parse: parseHipotekarnaStatement },
  [PAYONEER_BANK]: { name: 'Payoneer', extension: '.csv', parse: parsePayoneerStatement },
};
const mainButtons = {
  reply_markup: { inline_keyboard: [
    [{ text: 'Добавить выписку', callback_data: 'statement:add' }],
    [{ text: 'Внести наличные траты', callback_data: 'cash:add' }],
  ] },
};
const bankButtons = {
  reply_markup: { inline_keyboard: [[
    { text: 'Hipotekarna', callback_data: 'statement:hipotekarna' },
    { text: 'Payoneer', callback_data: 'statement:payoneer' },
  ]] },
};
function categoryButtons(token, categories, kind = 'statement') {
  const buttons = categories.map((category, index) => ({
    text: categoryButtonLabel(category),
    callback_data: `${kind}:category:${token}:${index}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  rows.push([{ text: '➕ Новая категория', callback_data: `${kind}:new-category:${token}` }]);
  if (kind === 'statement') {
    rows.push([{ text: '🚫 Не учитывать', callback_data: `statement:exclude:${token}` }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function currencyButtons(token, currencies) {
  const buttons = currencies.map((currency, index) => ({
    text: `${currency.name} (${currency.code})`,
    callback_data: `currency:select:${token}:${index}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  rows.push([{ text: '➕ Другая валюта', callback_data: `currency:custom:${token}` }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function parseCashAmount(text) {
  const match = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(text || '');
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : null;
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
  const detail = error instanceof StatementError || error instanceof PayoneerStatementError
    ? error.message : 'ошибка чтения или сохранения файла.';
  await context.reply(`Не удалось импортировать выписку: ${detail}`);
}

function registerMessageController(bot, {
  download = downloadStatement,
  process = processStatement,
  learn = learnCategory,
  categories = listCategories,
  createCategory = addCategory,
  exclude = excludeDescription,
  saveCash = addCashExpense,
  currencies = listCurrencies,
  cashCurrency = getCashCurrency,
  selectCurrency = setCashCurrency,
  createCurrency = addCustomCurrency,
} = {}) {
  const state = new Map();

  async function askCashCategory(context, amount) {
    const token = crypto.randomBytes(4).toString('hex');
    const [options, currency] = await Promise.all([categories(), cashCurrency()]);
    state.set(context.chat.id, { step: 'cash-category', amount, token, categories: options });
    await context.reply(`Выберите категорию для наличной траты ${amount.toFixed(2)} ${currency}.`,
      categoryButtons(token, options, 'cash'));
  }

  async function saveCashCategory(context, pending, category) {
    const transaction = await saveCash(pending.amount, category, { owner: context.from.id });
    state.delete(context.chat.id);
    await context.reply(`Записала наличную трату ${transaction.amount.toFixed(2)} ${transaction.currency} в «${category}».`,
      mainButtons);
  }

  async function askCurrency(context) {
    const token = crypto.randomBytes(4).toString('hex');
    const [options, current] = await Promise.all([currencies(), cashCurrency()]);
    state.set(context.chat.id, { step: 'currency-select', token, currencies: options });
    await context.reply(`Текущая валюта наличных трат: ${current}. Выберите новую:`,
      currencyButtons(token, options));
  }

  async function continueImport(context, session) {
    const result = await process(session.bank, session.transactions, { owner: context.from.id });
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
    const skipped = session.bank === PAYONEER_BANK
      ? `, поступлений пропущено ${session.skippedIncoming}, переводов между балансами ${session.skippedTransfers}, других операций ${session.skippedOther}`
      : `, поступлений пропущено ${session.skippedIncoming}`;
    await context.reply(
      `${statementFormats[session.bank].name}: обработано списаний ${result.total}, новых ${session.added}, исключено ${result.skippedExcluded || 0}${skipped}.`,
      mainButtons,
    );
  }

  async function startImport(context, buffer, bank) {
    const parsed = statementFormats[bank].parse(buffer);
    await continueImport(context, { ...parsed, bank, added: 0 });
  }

  bot.on('callback_query', async (context) => {
    const action = context.callbackQuery.data;
    if (!action?.startsWith('statement:') && !action?.startsWith('cash:')
      && !action?.startsWith('currency:')) return;
    await context.answerCbQuery();
    try {
      await context.editMessageReplyMarkup();
    } catch {
      // A stale or already edited message must not block the selected action.
    }
    const chatId = context.chat.id;

    if (action === 'cash:add') {
      state.set(chatId, { step: 'cash-amount' });
      try {
        const currency = await cashCurrency();
        await context.reply(`Напишите сумму наличной траты в ${currency}, например 12,50. Для отмены отправьте /cancel.`);
      } catch {
        state.delete(chatId);
        await context.reply('Не удалось прочитать валюту наличных трат.');
      }
    } else if (action === 'statement:add') {
      state.delete(chatId);
      await context.reply('Для какого банка добавить выписку?', bankButtons);
    } else if (action === 'statement:payoneer' || action === 'statement:hipotekarna') {
      const bank = action.slice('statement:'.length);
      const format = statementFormats[bank];
      state.set(chatId, { step: 'file', bank });
      await context.reply(`Пришлите выписку ${format.name} файлом ${format.extension}.`);
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
        await learn(pending.bank, pending.pending.description, category);
        await continueImport(context, pending);
      } catch (error) {
        await replyImportError(context, error);
        await context.reply('Выберите категорию ещё раз.', categoryButtons(pending.token, pending.categories));
      }
    } else if (action.startsWith('statement:exclude:')) {
      const token = action.split(':')[2];
      const pending = state.get(chatId);
      if (pending?.step !== 'category' || pending.token !== token) return;
      try {
        await exclude(pending.bank, pending.pending.description);
        await continueImport(context, pending);
      } catch (error) {
        await replyImportError(context, error);
        await context.reply('Выберите действие для операции ещё раз.',
          categoryButtons(pending.token, pending.categories));
      }
    } else if (action.startsWith('cash:new-category:')) {
      const token = action.split(':')[2];
      const pending = state.get(chatId);
      if (pending?.step !== 'cash-category' || pending.token !== token) return;
      state.set(chatId, { ...pending, step: 'cash-new-category' });
      await context.reply('Напишите название новой категории одним сообщением. Для отмены отправьте /cancel.');
    } else if (action.startsWith('cash:category:')) {
      const [, , token, indexText] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'cash-category' || pending.token !== token) return;
      const category = pending.categories[Number(indexText)];
      if (!category) return;
      try {
        await saveCashCategory(context, pending, category);
      } catch (error) {
        await context.reply('Не удалось сохранить наличную трату. Выберите категорию ещё раз.',
          categoryButtons(pending.token, pending.categories, 'cash'));
      }
    } else if (action.startsWith('currency:custom:')) {
      const token = action.split(':')[2];
      const pending = state.get(chatId);
      if (pending?.step !== 'currency-select' || pending.token !== token) return;
      state.set(chatId, { ...pending, step: 'currency-custom' });
      await context.reply('Напишите код валюты из трёх латинских букв, например GBP. Для отмены отправьте /cancel.');
    } else if (action.startsWith('currency:select:')) {
      const [, , token, indexText] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'currency-select' || pending.token !== token) return;
      const currency = pending.currencies[Number(indexText)];
      if (!currency) return;
      try {
        await selectCurrency(currency.code);
        state.delete(chatId);
        await context.reply(`Валюта наличных трат: ${currency.code}.`, mainButtons);
      } catch {
        await context.reply('Не удалось сохранить валюту. Выберите её ещё раз.',
          currencyButtons(pending.token, pending.currencies));
      }
    }
  });

  bot.on('message', async (context) => {
    const chatId = context.chat.id;
    if (/^\/currency(?:@\w+)?$/i.test(context.message.text?.trim() || '')) {
      try {
        await askCurrency(context);
      } catch {
        await context.reply('Не удалось прочитать настройки валюты.');
      }
      return;
    }
    const pending = state.get(chatId);
    const document = context.message.document;

    if (pending?.step === 'currency-select') {
      await context.reply('Выберите валюту кнопкой ниже.',
        currencyButtons(pending.token, pending.currencies));
      return;
    }

    if (pending?.step === 'currency-custom') {
      const code = context.message.text?.trim();
      if (code === '/cancel') {
        state.set(chatId, { ...pending, step: 'currency-select' });
        await context.reply('Выберите валюту.', currencyButtons(pending.token, pending.currencies));
        return;
      }
      try {
        const result = await createCurrency(code);
        state.delete(chatId);
        await context.reply(`Валюта наличных трат: ${result.code}.`, mainButtons);
      } catch (error) {
        await context.reply(error instanceof CurrencyCodeError
          ? error.message : 'Не удалось сохранить валюту. Попробуйте ещё раз.');
      }
      return;
    }

    if (pending?.step === 'cash-amount') {
      if (context.message.text?.trim() === '/cancel') {
        state.delete(chatId);
        await context.reply('Внесение наличных отменено.', mainButtons);
        return;
      }
      const amount = parseCashAmount(context.message.text);
      if (amount === null) {
        await context.reply('Напишите положительную сумму, например 12,50. Можно указать не больше двух знаков после запятой.');
        return;
      }
      try {
        await askCashCategory(context, amount);
      } catch {
        await context.reply('Не удалось загрузить категории. Попробуйте отправить сумму ещё раз.');
      }
      return;
    }

    if (pending?.step === 'cash-category') {
      await context.reply('Выберите категорию наличной траты кнопкой ниже.',
        categoryButtons(pending.token, pending.categories, 'cash'));
      return;
    }

    if (pending?.step === 'cash-new-category') {
      const name = context.message.text;
      if (name?.trim() === '/cancel') {
        state.set(chatId, { ...pending, step: 'cash-category' });
        await context.reply('Выберите категорию наличной траты.',
          categoryButtons(pending.token, pending.categories, 'cash'));
        return;
      }
      if (!name?.trim()) {
        await context.reply('Пришлите название новой категории текстом.');
        return;
      }
      try {
        const result = await createCategory(name);
        await saveCashCategory(context, pending, result.category);
      } catch (error) {
        if (error instanceof CategoryNameError) await context.reply(error.message);
        else await context.reply('Не удалось сохранить наличную трату. Попробуйте ещё раз.');
      }
      return;
    }

    if (pending?.step === 'file') {
      const format = statementFormats[pending.bank];
      if (!document || !(document.file_name || '').toLowerCase().endsWith(format.extension)) {
        await context.reply(`Пришлите выписку ${format.name} файлом ${format.extension}.`);
        return;
      }
      try {
        const buffer = await download(context, document);
        await startImport(context, buffer, pending.bank);
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
      const name = context.message.text;
      if (name?.trim() === '/cancel') {
        state.set(chatId, { ...pending, step: 'category' });
        await context.reply('Выберите категорию операции.',
          categoryButtons(pending.token, pending.categories));
        return;
      }
      if (!name?.trim()) {
        await context.reply('Пришлите название новой категории текстом.');
        return;
      }
      try {
        const result = await createCategory(name);
        await learn(pending.bank, pending.pending.description, result.category);
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
      await context.reply('Чтобы добавить выписку, нажмите кнопку «Добавить выписку».', mainButtons);
      return;
    }
    await context.reply(getReply(), mainButtons);
  });
}

module.exports = { registerMessageController };

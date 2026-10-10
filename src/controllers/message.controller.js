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
  excludeDescription, descriptionKey, parseAppStoreItems, appStoreCategories,
  saveAppStoreReceipt, AppStoreInputError,
} = require('../services/transaction-store');
const { categoryButtonLabel } = require('../constants/categories');
const {
  loadTransactions, availableYears, availableMonths, monthlyStatistics,
  formatMonthlyStatistics, parseReportDate, categoryExpenses, formatCategoryExpenses, MONTH_NAMES,
} = require('../services/statistics.service');

const MAX_STATEMENT_SIZE = 10 * 1024 * 1024;
const MAX_REPORT_MESSAGE_LENGTH = 3900;
const podgoricaDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Podgorica', day: '2-digit', month: '2-digit', year: 'numeric',
});
const statisticsReplyOptions = {
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
};
const statementFormats = {
  [HIPOTEKARNA_BANK]: { name: 'Hipotekarna', extension: '.xls', parse: parseHipotekarnaStatement },
  [PAYONEER_BANK]: { name: 'Payoneer', extension: '.csv', parse: parsePayoneerStatement },
};
const mainButtons = {
  reply_markup: { inline_keyboard: [
    [{ text: '🏦 Добавить выписку', callback_data: 'statement:add' }],
    [{ text: '💰 Внести наличные траты', callback_data: 'cash:add' }],
    [{ text: '🍎 Внести траты на App Store', callback_data: 'app-store:add' }],
    [{ text: '📊 Вывести мою статистику', callback_data: 'stats:mine' }],
    [{ text: '📈 Вывести общую статистику', callback_data: 'stats:all' }],
    [{ text: '🗂 Мои траты по категории', callback_data: 'category-report:mine' }],
    [{ text: '👥 Общие траты по категории', callback_data: 'category-report:all' }],
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

function appStoreCategoryButtons(token, index) {
  return { reply_markup: { inline_keyboard: [[
    { text: categoryButtonLabel('Подписки'), callback_data: `app-store:category:${token}:${index}:s` },
    { text: categoryButtonLabel('Игры'), callback_data: `app-store:category:${token}:${index}:g` },
  ]] } };
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

function choiceButtons(token, values, labels, kind) {
  const buttons = values.map((value) => ({
    text: labels(value), callback_data: `stats:${kind}:${token}:${value}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
  return { reply_markup: { inline_keyboard: rows } };
}

function reportCategoryButtons(token, categories) {
  const buttons = categories.map((category, index) => ({
    text: categoryButtonLabel(category), callback_data: `category-report:select:${token}:${index}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return { reply_markup: { inline_keyboard: rows } };
}

function parseCashAmount(text) {
  const match = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(text || '');
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : null;
}

function reportDateExamples(date) {
  const parts = Object.fromEntries(podgoricaDateFormatter.formatToParts(date)
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return { start: `01.${parts.month}.${parts.year}`,
    end: `${parts.day}.${parts.month}.${parts.year}` };
}

const htmlPromptOptions = { parse_mode: 'HTML' };

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
  saveAppStore = saveAppStoreReceipt,
  lookupAppStoreCategories = appStoreCategories,
  currencies = listCurrencies,
  cashCurrency = getCashCurrency,
  selectCurrency = setCashCurrency,
  createCurrency = addCustomCurrency,
  readTransactions = loadTransactions,
  now = () => new Date(),
} = {}) {
  const state = new Map();

  async function completeAppStore(context, pending) {
    let result;
    try {
      const items = pending.items.map((item, index) => ({ ...item,
        category: pending.categories[index] }));
      result = await saveAppStore(pending.date, items, { owner: context.from.id });
    } catch {
      state.set(context.chat.id, { step: 'app-store-items', date: pending.date });
      await context.reply('Не удалось сохранить чек App Store. Пришлите весь список приложений ещё раз.');
      return;
    }
    state.delete(context.chat.id);
    const message = result.duplicate
      ? `Этот чек App Store уже внесён.${result.removedApple ? ' Списание Apple заменено.' : ''}`
      : `Внесено приложений: ${result.added}. Сумма чека: ${result.total.toFixed(2)} USD.${result.removedApple ? ' Списание Apple заменено.' : ' Совпадающее списание Apple пока не найдено.'}`;
    await context.reply(message, { ...mainButtons,
      link_preview_options: { is_disabled: true } });
  }

  async function askNextAppStoreCategory(context, pending) {
    const index = pending.categories.findIndex((category) => category === null);
    if (index === -1) {
      await completeAppStore(context, pending);
      return;
    }
    const next = { ...pending, index };
    state.set(context.chat.id, next);
    await context.reply(`К какой категории отнести «${pending.items[index].name}»?`,
      appStoreCategoryButtons(pending.token, index));
  }

  async function startCategoryReport(context, scope) {
    const options = await categories();
    const token = crypto.randomBytes(4).toString('hex');
    state.set(context.chat.id, { step: 'category-report-category', scope, categories: options, token });
    await context.reply('По какой категории вывести траты?', reportCategoryButtons(token, options));
  }

  async function showCategoryReport(context, pending, end) {
    const transactions = await readTransactions();
    const report = categoryExpenses(transactions, {
      category: pending.category, start: pending.start, end,
      owner: pending.scope === 'mine' ? context.from.id : undefined,
    });
    const messages = formatCategoryExpenses(report,
      { maxLength: MAX_REPORT_MESSAGE_LENGTH, scope: pending.scope });
    for (const [index, message] of messages.entries()) {
      await context.reply(message, {
        ...statisticsReplyOptions,
        ...(index === messages.length - 1 ? mainButtons : {}),
      });
    }
    state.delete(context.chat.id);
  }

  async function showStatistics(context, scope, year, month) {
    const transactions = await readTransactions();
    const owner = scope === 'mine' ? context.from.id : undefined;
    const report = monthlyStatistics(transactions, { year, month, owner });
    state.delete(context.chat.id);
    if (!report) {
      await context.reply('За выбранный месяц транзакций пока нет.', mainButtons);
      return;
    }
    const messages = formatMonthlyStatistics(report, scope);
    const combined = `${messages.summary}\n\n${messages.top}`;
    if (combined.length <= MAX_REPORT_MESSAGE_LENGTH) {
      await context.reply(combined, { ...mainButtons, ...statisticsReplyOptions });
    } else {
      await context.reply(messages.summary, statisticsReplyOptions);
      await context.reply(messages.top, { ...mainButtons, ...statisticsReplyOptions });
    }
  }

  async function chooseStatisticsYear(context, scope, year) {
    const transactions = await readTransactions();
    const owner = scope === 'mine' ? context.from.id : undefined;
    const months = availableMonths(transactions, year, owner);
    if (!months.length) {
      state.delete(context.chat.id);
      await context.reply('За выбранный год транзакций пока нет.', mainButtons);
    } else if (months.length === 1) {
      await showStatistics(context, scope, year, months[0]);
    } else {
      const token = crypto.randomBytes(4).toString('hex');
      state.set(context.chat.id, { step: 'stats-month', scope, year, months, token });
      await context.reply(`За какой месяц ${year} года вывести статистику?`,
        choiceButtons(token, months, (month) => MONTH_NAMES[Number(month) - 1], 'month'));
    }
  }

  async function startStatistics(context, scope) {
    const transactions = await readTransactions();
    const owner = scope === 'mine' ? context.from.id : undefined;
    const years = availableYears(transactions, owner);
    if (!years.length) {
      state.delete(context.chat.id);
      await context.reply('Транзакций для статистики пока нет.', mainButtons);
    } else if (years.length === 1) {
      await chooseStatisticsYear(context, scope, years[0]);
    } else {
      const token = crypto.randomBytes(4).toString('hex');
      state.set(context.chat.id, { step: 'stats-year', scope, years, token });
      await context.reply('За какой год вывести статистику?',
        choiceButtons(token, years, (year) => year, 'year'));
    }
  }

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
      ? `, поступлений пропущено ${session.skippedIncoming}, переводов между балансами ${session.skippedTransfers}, чеков App Store ${result.skippedAppStore || 0}, других операций ${session.skippedOther}`
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
      && !action?.startsWith('currency:') && !action?.startsWith('stats:')
      && !action?.startsWith('category-report:') && !action?.startsWith('app-store:')) return;
    await context.answerCbQuery();
    try {
      await context.editMessageReplyMarkup();
    } catch {
      // A stale or already edited message must not block the selected action.
    }
    const chatId = context.chat.id;

    if (action === 'category-report:mine' || action === 'category-report:all') {
      try {
        await startCategoryReport(context, action.slice('category-report:'.length));
      } catch {
        state.delete(chatId);
        await context.reply('Не удалось загрузить категории.', mainButtons);
      }
    } else if (action.startsWith('category-report:select:')) {
      const [, , token, indexText] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'category-report-category' || pending.token !== token) return;
      const category = pending.categories[Number(indexText)];
      if (!category) return;
      state.set(chatId, { step: 'category-report-start', category, scope: pending.scope });
      const example = reportDateExamples(now()).start;
      await context.reply(`С какой даты показать траты в категории «${escapeHtml(category)}»? Напишите дату в формате ДД.ММ.ГГГГ, например <code>${example}</code>. Для отмены отправьте /cancel.`,
        htmlPromptOptions);
    } else if (action === 'stats:mine' || action === 'stats:all') {
      try {
        await startStatistics(context, action.slice('stats:'.length));
      } catch {
        state.delete(chatId);
        await context.reply('Не удалось прочитать транзакции для статистики.', mainButtons);
      }
    } else if (action.startsWith('stats:year:')) {
      const [, , token, year] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'stats-year' || pending.token !== token || !pending.years.includes(year)) return;
      try {
        await chooseStatisticsYear(context, pending.scope, year);
      } catch {
        state.delete(chatId);
        await context.reply('Не удалось прочитать транзакции для статистики.', mainButtons);
      }
    } else if (action.startsWith('stats:month:')) {
      const [, , token, month] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'stats-month' || pending.token !== token || !pending.months.includes(month)) return;
      try {
        await showStatistics(context, pending.scope, pending.year, month);
      } catch {
        state.delete(chatId);
        await context.reply('Не удалось вывести статистику.', mainButtons);
      }
    } else if (action === 'app-store:add') {
      state.set(chatId, { step: 'app-store-date' });
      const example = reportDateExamples(now()).end;
      await context.reply(`Напишите дату чека App Store в формате ДД.ММ.ГГГГ, например <code>${example}</code>. Для отмены отправьте /cancel.`,
        htmlPromptOptions);
    } else if (action.startsWith('app-store:category:')) {
      const [, , token, indexText, code] = action.split(':');
      const pending = state.get(chatId);
      if (pending?.step !== 'app-store-category' || pending.token !== token
        || pending.index !== Number(indexText) || !['s', 'g'].includes(code)) return;
      const category = code === 's' ? 'Подписки' : 'Игры';
      const key = descriptionKey(pending.items[pending.index].name);
      const categories = pending.categories.map((value, index) =>
        descriptionKey(pending.items[index].name) === key ? category : value);
      await askNextAppStoreCategory(context, { ...pending, categories });
    } else if (action === 'cash:add') {
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

    if (pending?.step === 'app-store-date' || pending?.step === 'app-store-items'
      || pending?.step === 'app-store-category') {
      const input = context.message.text?.trim();
      if (input === '/cancel') {
        state.delete(chatId);
        await context.reply('Внесение трат App Store отменено.', mainButtons);
      } else if (pending.step === 'app-store-category') {
        await context.reply('Выберите категорию приложения кнопкой.',
          appStoreCategoryButtons(pending.token, pending.index));
      } else if (pending.step === 'app-store-date') {
        const date = parseReportDate(input);
        if (!date) {
          const example = reportDateExamples(now()).end;
          await context.reply(`Напишите существующую дату в формате ДД.ММ.ГГГГ, например <code>${example}</code>.`,
            htmlPromptOptions);
        } else {
          state.set(chatId, { step: 'app-store-items', date });
          const example = 'Приложение – $0';
          await context.reply(`Напишите приложения из чека: каждое с новой строки в формате <code>${example}</code>. Замените 0 на фактическую сумму в USD для каждого приложения. Для отмены отправьте /cancel.`,
            htmlPromptOptions);
        }
      } else {
        let items;
        try {
          items = parseAppStoreItems(input);
        } catch (error) {
          await context.reply(error instanceof AppStoreInputError
            ? `${error.message} Пришлите весь список приложений ещё раз.`
            : 'Напишите приложения списком, по одному на строку.');
          return;
        }
        let learned;
        try {
          learned = await lookupAppStoreCategories(items);
          if (!Array.isArray(learned) || learned.length !== items.length) {
            throw new Error('Некорректные категории приложений.');
          }
        } catch {
          await context.reply('Не удалось прочитать категории App Store. Пришлите список ещё раз.');
          return;
        }
        await askNextAppStoreCategory(context, {
          step: 'app-store-category', date: pending.date, items, categories: learned,
          token: crypto.randomBytes(4).toString('hex'),
        });
      }
      return;
    }

    if (pending?.step?.startsWith('category-report-')) {
      const input = context.message.text?.trim();
      if (input === '/cancel') {
        state.delete(chatId);
        await context.reply('Просмотр трат по категории отменён.', mainButtons);
      } else if (pending.step === 'category-report-category') {
        await context.reply('Выберите категорию кнопкой ниже.',
          reportCategoryButtons(pending.token, pending.categories));
      } else {
        const date = parseReportDate(input);
        if (!date) {
          const example = reportDateExamples(now())[pending.step === 'category-report-start' ? 'start' : 'end'];
          await context.reply(`Напишите существующую дату в формате ДД.ММ.ГГГГ, например <code>${example}</code>.`,
            htmlPromptOptions);
        } else if (pending.step === 'category-report-start') {
          state.set(chatId, { ...pending, step: 'category-report-end', start: date });
          const example = reportDateExamples(now()).end;
          await context.reply(`По какую дату включительно показать траты? Напишите дату в формате ДД.ММ.ГГГГ, например <code>${example}</code>.`,
            htmlPromptOptions);
        } else if (date < pending.start) {
          await context.reply('Дата окончания должна быть не раньше даты начала. Напишите дату окончания ещё раз.');
        } else {
          try {
            await showCategoryReport(context, pending, date);
          } catch {
            await context.reply('Не удалось вывести траты. Напишите дату окончания ещё раз.');
          }
        }
      }
      return;
    }

    if (pending?.step === 'stats-year' || pending?.step === 'stats-month') {
      if (context.message.text?.trim() === '/cancel') {
        state.delete(chatId);
        await context.reply('Выбор статистики отменён.', mainButtons);
      } else if (pending.step === 'stats-year') {
        await context.reply('Выберите год кнопкой ниже.',
          choiceButtons(pending.token, pending.years, (year) => year, 'year'));
      } else {
        await context.reply('Выберите месяц кнопкой ниже.',
          choiceButtons(pending.token, pending.months,
            (month) => MONTH_NAMES[Number(month) - 1], 'month'));
      }
      return;
    }

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

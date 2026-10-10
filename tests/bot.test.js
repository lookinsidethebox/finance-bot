const assert = require('node:assert/strict');
const test = require('node:test');
const XLSX = require('xlsx');
const { createBot } = require('../src/bot');
const { CATEGORIES } = require('../src/constants/categories');
const { CURRENCIES } = require('../src/services/transaction-store');

const ownerId = 123;

function createHarness(services, ownerIds = [String(ownerId)]) {
  const sent = [];
  const edited = [];
  const bot = createBot({ token: 'test-token', ownerIds }, {
    categories: async () => CATEGORIES,
    currencies: async () => CURRENCIES,
    cashCurrency: async () => 'EUR',
    ...services,
  });
  bot.botInfo = { id: 999, username: 'finance_test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = {
    sendMessage: async (...args) => { sent.push(args); },
    answerCbQuery: async () => {},
    editMessageReplyMarkup: async (...args) => { edited.push(args); },
  };
  return { bot, sent, edited };
}

function statementBuffer() {
  const headers = [
    'Valuta', 'Svrha', 'Reklamacija', 'Vrsta transakcije', 'Primaoc',
    'Račun primaoca', 'Pošiljalac', 'Račun pošiljaoca',
    'Model i poziv na broj', 'Poziv odobrenja', 'Odliv', 'Priliv', 'Iznos',
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Kartica računa: TEST USER 123456789012345678'],
    headers,
    [46267, 'Shop', 'ref-1', 'M02', '', '', '', '', '', '', 10, 0, -10],
  ]), 'Stanje');
  return XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' });
}

function payoneerBuffer() {
  return Buffer.from([
    'Transaction Date,Transaction Time,Time Zone,Debit Amount,Credit Amount,Currency,Status,Source,Target',
    '09/15/2026,14:03:05,UTC,12.50,,USD,Completed,USD balance,APPLE.COM/BILL',
  ].join('\n'));
}

function callbackUpdate(data, updateId = 100, fromId = ownerId) {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      message: {
        message_id: 1,
        date: 1_780_000_000,
        chat: { id: fromId, type: 'private' },
      },
      chat_instance: 'test',
      data,
    },
  };
}

function messageUpdate({ fromId = ownerId, chatId = fromId, chatType = 'private', content = { text: 'Привет' }, updateId = 1 } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_780_000_000,
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      chat: { id: chatId, type: chatType },
      ...content,
    },
  };
}

test('replies to each owner message type with the exact confirmation', async () => {
  const { bot, sent } = createHarness();
  const contents = [
    { text: 'Привет' },
    { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] },
    { photo: [{ file_id: 'photo-id', file_unique_id: 'unique-id', width: 1, height: 1 }] },
    { sticker: { file_id: 'sticker-id', file_unique_id: 'unique-id', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } },
  ];
  for (const [index, content] of contents.entries()) {
    await bot.handleUpdate(messageUpdate({ content, updateId: index + 1 }));
  }
  assert.deepEqual(sent.map(([chatId, text]) => [chatId, text]),
    contents.map(() => [ownerId, '✅ Бот работает']));
});

test('silently ignores other users, groups, and messages without a sender', async () => {
  const { bot, sent } = createHarness();
  await bot.handleUpdate(messageUpdate({ fromId: 456 }));
  await bot.handleUpdate(messageUpdate({ chatId: -100123, chatType: 'supergroup' }));
  const noSender = messageUpdate();
  delete noSender.message.from;
  await bot.handleUpdate(noSender);
  assert.deepEqual(sent, []);
});

test('accepts a second owner and records their Telegram ID on expenses', async () => {
  const saved = [];
  const { bot, sent } = createHarness({
    saveCash: async (amount, category, options) => {
      saved.push({ amount, category, owner: options.owner });
      return { amount, category, currency: 'EUR' };
    },
  }, ['123', '456']);
  await bot.handleUpdate(messageUpdate({ fromId: 456 }));
  assert.equal(sent.at(-1)[0], 456);
  await bot.handleUpdate(callbackUpdate('cash:add', 101, 456));
  await bot.handleUpdate(messageUpdate({ fromId: 456, content: { text: '5' }, updateId: 102 }));
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat()
    .find((item) => item.text === '🛍️ Продуктовые магазины');
  await bot.handleUpdate(callbackUpdate(button.callback_data, 103, 456));
  assert.deepEqual(saved, [{ amount: 5, category: 'Продуктовые магазины', owner: 456 }]);
  const count = sent.length;
  await bot.handleUpdate(messageUpdate({ fromId: 789, updateId: 104 }));
  await bot.handleUpdate(messageUpdate({ fromId: 456, chatId: -100123, chatType: 'supergroup', updateId: 105 }));
  assert.equal(sent.length, count);
});

test('statement button opens bank selection and Hipotekarna asks for a file', async () => {
  const { bot, sent, edited } = createHarness();
  await bot.handleUpdate(messageUpdate());
  assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].callback_data, 'statement:add');
  assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].text, '🏦 Добавить выписку');
  assert.equal(sent[0][2].reply_markup.inline_keyboard[1][0].text, '💰 Внести наличные траты');

  await bot.handleUpdate(callbackUpdate('statement:add'));
  assert.deepEqual(edited[0], [ownerId, 1, undefined, undefined]);
  assert.equal(sent[1][1], 'Для какого банка добавить выписку?');
  assert.deepEqual(sent[1][2].reply_markup.inline_keyboard[0].map((button) => button.text),
    ['Hipotekarna', 'Payoneer']);

  await bot.handleUpdate(callbackUpdate('statement:hipotekarna', 101));
  assert.deepEqual(edited[1], [ownerId, 1, undefined, undefined]);
  assert.match(sent[2][1], /Пришлите выписку Hipotekarna/);

  await bot.handleUpdate(messageUpdate({ content: { text: 'не файл' }, updateId: 102 }));
  assert.match(sent[3][1], /Пришлите выписку Hipotekarna/);
});

test('personal and shared statistics use different owners and offer only populated months', async () => {
  const transactions = [
    { date: '2026-09-10', amount: 12, currency: 'EUR', category: 'Аптека', description: 'Mine September', owner: 123 },
    { date: '2026-10-10', amount: 5, currency: 'USD', category: 'Игры', description: 'Mine October', owner: 123 },
    { date: '2026-10-11', amount: 20, currency: 'EUR', category: 'Подарки', description: 'Other October', owner: 456 },
    { date: '2026-11-11', amount: 8, currency: 'EUR', category: 'Подарки', description: 'Other November', owner: 456 },
  ];
  const { bot, sent } = createHarness({ readTransactions: async () => transactions }, ['123', '456']);
  await bot.handleUpdate(messageUpdate());
  assert.deepEqual(sent[0][2].reply_markup.inline_keyboard.slice(2, 4).map((row) => row[0].text),
    ['📊 Вывести мою статистику', '📈 Вывести общую статистику']);

  await bot.handleUpdate(callbackUpdate('stats:mine', 101));
  assert.match(sent.at(-1)[1], /За какой месяц 2026 года/);
  const mineMonths = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.deepEqual(mineMonths.map((button) => button.text), ['сентябрь', 'октябрь']);
  await bot.handleUpdate(callbackUpdate(mineMonths[0].callback_data, 102));
  assert.match(sent.at(-1)[1], /Мои траты · сентябрь 2026/);
  assert.match(sent.at(-1)[1], /Mine September/);
  assert.doesNotMatch(sent.at(-1)[1], /Other October/);

  await bot.handleUpdate(callbackUpdate('stats:all', 103));
  const allMonths = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.deepEqual(allMonths.map((button) => button.text), ['сентябрь', 'октябрь', 'ноябрь']);
  await bot.handleUpdate(callbackUpdate(allMonths[1].callback_data, 104));
  assert.match(sent.at(-1)[1], /Общие траты · октябрь 2026/);
  assert.match(sent.at(-1)[1], /USD: <b>5,00 \$<\/b>/);
  assert.match(sent.at(-1)[1], /EUR: <b>20,00 €<\/b>/);
  assert.equal(sent.at(-1)[2].parse_mode, 'HTML');
  assert.deepEqual(sent.at(-1)[2].link_preview_options, { is_disabled: true });
  assert.match(sent.at(-1)[1], /Mine October/);
  assert.match(sent.at(-1)[1], /Other October/);
});

test('statistics asks for a year only when multiple years have transactions', async () => {
  const transactions = [
    { date: '2026-09-10', amount: 12, currency: 'EUR', category: 'Аптека', description: 'Old', owner: 123 },
    { date: '2027-01-10', amount: 15, currency: 'EUR', category: 'Игры', description: 'New', owner: 123 },
  ];
  const { bot, sent } = createHarness({ readTransactions: async () => transactions });
  await bot.handleUpdate(callbackUpdate('stats:mine'));
  assert.equal(sent.at(-1)[1], 'За какой год вывести статистику?');
  const years = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.deepEqual(years.map((button) => button.text), ['2026', '2027']);
  await bot.handleUpdate(callbackUpdate(years[0].callback_data, 101));
  assert.match(sent.at(-1)[1], /Мои траты · сентябрь 2026/);
  assert.match(sent.at(-1)[1], /Old/);
  assert.doesNotMatch(sent.at(-1)[1], /New/);
});

test('statistics reports an empty personal history', async () => {
  const transactions = [
    { date: '2026-09-10', amount: 12, currency: 'EUR', category: 'Аптека', description: 'Other', owner: 456 },
  ];
  const { bot, sent } = createHarness({ readTransactions: async () => transactions }, ['123', '456']);
  await bot.handleUpdate(callbackUpdate('stats:mine'));
  assert.match(sent.at(-1)[1], /Транзакций для статистики пока нет/);
});

test('statistics opens the report immediately when only one year and month exist', async () => {
  const transactions = [
    { date: '2026-09-10', amount: 12, currency: 'EUR', category: 'Аптека', description: 'Medicine', owner: 123 },
  ];
  const { bot, sent } = createHarness({ readTransactions: async () => transactions });
  await bot.handleUpdate(callbackUpdate('stats:mine'));
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /Мои траты · сентябрь 2026/);
  assert.match(sent[0][1], /Medicine/);
  assert.equal(sent[0][2].reply_markup.inline_keyboard[2][0].callback_data, 'stats:mine');
});

test('statistics splits a report only if it exceeds the Telegram message limit', async () => {
  const transactions = Array.from({ length: 10 }, (_, index) => ({
    date: '2026-09-10', amount: index + 1, currency: 'EUR', category: 'Прочее',
    description: `Item ${index} ${'X'.repeat(320)}`, owner: 123,
  }));
  const { bot, sent } = createHarness({ readTransactions: async () => transactions });
  await bot.handleUpdate(callbackUpdate('stats:mine'));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(([, text]) => text.length < 3900));
  assert.ok(sent.every(([, , options]) => options.link_preview_options?.is_disabled === true));
  assert.match(sent[0][1], /По категориям/);
  assert.match(sent[1][1], /10 крупнейших транзакций/);
});

test('category report asks for a category, then both dates and shows only matching expenses', async () => {
  const transactions = [
    { date: '2026-09-01', amount: 5, currency: 'EUR', category: 'Игры', description: 'First', owner: 123 },
    { date: '2026-09-30T23:59:00.000Z', amount: 10, currency: 'USD', category: 'Игры', description: 'Last', owner: 123 },
    { date: '2026-09-15', amount: 20, currency: 'EUR', category: 'Игры', description: 'Someone else', owner: 456 },
    { date: '2026-09-15', amount: 30, currency: 'EUR', category: 'Аптека', description: 'Other category', owner: 123 },
  ];
  const { bot, sent, edited } = createHarness({
    readTransactions: async () => transactions,
    categories: async () => [...CATEGORIES, 'Крипта'],
  }, ['123', '456']);
  await bot.handleUpdate(messageUpdate());
  assert.deepEqual(sent[0][2].reply_markup.inline_keyboard.slice(4).map((row) => row[0].callback_data),
    ['category-report:mine', 'category-report:all']);
  await bot.handleUpdate(callbackUpdate('category-report:mine', 101));
  assert.match(sent.at(-1)[1], /По какой категории/);
  const buttons = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.ok(buttons.find((button) => button.text === '🏷️ Крипта'));
  const games = buttons.find((button) => button.text === '🎮 Игры');
  await bot.handleUpdate(callbackUpdate(games.callback_data, 102));
  assert.equal(edited.length, 2);
  assert.match(sent.at(-1)[1], /С какой даты/);
  await bot.handleUpdate(messageUpdate({ content: { text: '31.09.2026' }, updateId: 103 }));
  assert.match(sent.at(-1)[1], /существующую дату/);
  await bot.handleUpdate(messageUpdate({ content: { text: '01.09.2026' }, updateId: 104 }));
  assert.match(sent.at(-1)[1], /По какую дату включительно/);
  await bot.handleUpdate(messageUpdate({ content: { text: '31.08.2026' }, updateId: 105 }));
  assert.match(sent.at(-1)[1], /не раньше даты начала/);
  await bot.handleUpdate(messageUpdate({ content: { text: '30.09.2026' }, updateId: 106 }));
  const [text, options] = sent.at(-1).slice(1);
  assert.match(text, /First/);
  assert.match(text, /Last/);
  assert.match(text, /Мои траты/);
  assert.doesNotMatch(text, /Someone else|Other category/);
  assert.match(text, /5,00 €/);
  assert.match(text, /10,00 \$/);
  assert.equal(options.parse_mode, 'HTML');
  assert.deepEqual(options.link_preview_options, { is_disabled: true });
  assert.equal(options.reply_markup.inline_keyboard[4][0].callback_data, 'category-report:mine');
});

test('shared category report includes expenses of every owner', async () => {
  const transactions = [
    { date: '2026-09-01', amount: 5, currency: 'EUR', category: 'Игры', description: 'Mine', owner: 123 },
    { date: '2026-09-02', amount: 7, currency: 'EUR', category: 'Игры', description: 'Partner', owner: 456 },
  ];
  const { bot, sent } = createHarness({ readTransactions: async () => transactions }, ['123', '456']);
  await bot.handleUpdate(callbackUpdate('category-report:all'));
  const games = sent.at(-1)[2].reply_markup.inline_keyboard.flat()
    .find((button) => button.text === '🎮 Игры');
  await bot.handleUpdate(callbackUpdate(games.callback_data, 101));
  await bot.handleUpdate(messageUpdate({ content: { text: '01.09.2026' }, updateId: 102 }));
  await bot.handleUpdate(messageUpdate({ content: { text: '30.09.2026' }, updateId: 103 }));
  const text = sent.at(-1)[1];
  assert.match(text, /Общие траты/);
  assert.match(text, /Mine/);
  assert.match(text, /Partner/);
  assert.match(text, /12,00 €/);
});

test('category report shows an empty range and can be cancelled', async () => {
  const { bot, sent } = createHarness({ readTransactions: async () => [] });
  await bot.handleUpdate(callbackUpdate('category-report:mine'));
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat()[0];
  await bot.handleUpdate(callbackUpdate(button.callback_data, 101));
  await bot.handleUpdate(messageUpdate({ content: { text: '01.01.2026' }, updateId: 102 }));
  await bot.handleUpdate(messageUpdate({ content: { text: '31.01.2026' }, updateId: 103 }));
  assert.match(sent.at(-1)[1], /За этот период трат нет/);
  await bot.handleUpdate(callbackUpdate('category-report:mine', 104));
  await bot.handleUpdate(messageUpdate({ content: { text: '/cancel' }, updateId: 105 }));
  assert.match(sent.at(-1)[1], /отменён/);
});

test('cash expense asks for an amount and category, then saves EUR expense', async () => {
  const saved = [];
  const { bot, sent } = createHarness({
    saveCash: async (amount, category, options) => {
      saved.push({ amount, category, owner: options.owner });
      return { amount, category, currency: 'EUR' };
    },
  });
  await bot.handleUpdate(callbackUpdate('cash:add'));
  assert.match(sent.at(-1)[1], /сумму наличной траты в EUR/);
  await bot.handleUpdate(messageUpdate({ content: { text: '-5' }, updateId: 101 }));
  assert.match(sent.at(-1)[1], /положительную сумму/);
  await bot.handleUpdate(messageUpdate({ content: { text: '12,50' }, updateId: 102 }));
  assert.match(sent.at(-1)[1], /12\.50 EUR/);
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat()
    .find((item) => item.text === '🛍️ Продуктовые магазины');
  await bot.handleUpdate(callbackUpdate(button.callback_data, 103));
  assert.deepEqual(saved, [{ amount: 12.5, category: 'Продуктовые магазины', owner: ownerId }]);
  assert.match(sent.at(-1)[1], /Записала наличную трату 12\.50 EUR/);
  assert.equal(sent.at(-1)[2].reply_markup.inline_keyboard[1][0].text, '💰 Внести наличные траты');
});

test('cash expense can use a category created during entry', async () => {
  const saved = [];
  const { bot, sent } = createHarness({
    createCategory: async (name) => {
      assert.equal(name, 'хобби');
      return { category: 'Хобби', added: true };
    },
    saveCash: async (amount, category) => {
      saved.push({ amount, category });
      return { amount, category, currency: 'EUR' };
    },
  });
  await bot.handleUpdate(callbackUpdate('cash:add'));
  await bot.handleUpdate(messageUpdate({ content: { text: '8.25' }, updateId: 101 }));
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat().at(-1);
  await bot.handleUpdate(callbackUpdate(button.callback_data, 102));
  await bot.handleUpdate(messageUpdate({ content: { text: 'хобби' }, updateId: 103 }));
  assert.deepEqual(saved, [{ amount: 8.25, category: 'Хобби' }]);
});

test('/currency changes the currency used for the next cash expense', async () => {
  let current = 'EUR';
  const saved = [];
  const { bot, sent } = createHarness({
    cashCurrency: async () => current,
    selectCurrency: async (code) => { current = code; },
    saveCash: async (amount, category) => {
      saved.push({ amount, category, currency: current });
      return { amount, category, currency: current };
    },
  });
  await bot.handleUpdate(messageUpdate({ content: { text: '/currency' } }));
  assert.match(sent.at(-1)[1], /Текущая валюта наличных трат: EUR/);
  const buttons = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((button) => button.text), [
    'Евро (EUR)', 'Доллары (USD)', 'Рубли (RUB)',
    'Турецкие лиры (TRY)', 'Сербские динары (RSD)', '➕ Другая валюта',
  ]);
  await bot.handleUpdate(callbackUpdate(buttons[1].callback_data, 101));
  await bot.handleUpdate(callbackUpdate('cash:add', 102));
  assert.match(sent.at(-1)[1], /сумму наличной траты в USD/);
  await bot.handleUpdate(messageUpdate({ content: { text: '5' }, updateId: 103 }));
  const category = sent.at(-1)[2].reply_markup.inline_keyboard.flat()[0];
  await bot.handleUpdate(callbackUpdate(category.callback_data, 104));
  assert.deepEqual(saved, [{ amount: 5, category: 'Продуктовые магазины', currency: 'USD' }]);
  assert.match(sent.at(-1)[1], /5\.00 USD/);
});

test('/currency accepts a custom three-letter currency code', async () => {
  let chosen;
  const { bot, sent } = createHarness({
    createCurrency: async (code) => { chosen = code; return { code: 'GBP', added: true }; },
  });
  await bot.handleUpdate(messageUpdate({ content: { text: '/currency' } }));
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat().at(-1);
  await bot.handleUpdate(callbackUpdate(button.callback_data, 101));
  await bot.handleUpdate(messageUpdate({ content: { text: 'gbp' }, updateId: 102 }));
  assert.equal(chosen, 'gbp');
  assert.match(sent.at(-1)[1], /Валюта наличных трат: GBP/);
});

test('Payoneer CSV asks for a category and learns Target under its own bank', async () => {
  const processed = [];
  const learned = [];
  let calls = 0;
  const { bot, sent, edited } = createHarness({
    download: async () => payoneerBuffer(),
    process: async (bank, transactions, options) => {
      processed.push({ bank, transactions, owner: options.owner });
      calls++;
      return calls === 1
        ? { pending: transactions[0], added: 0, total: 1 }
        : { pending: null, added: 1, total: 1 };
    },
    learn: async (bank, description, category) => { learned.push({ bank, description, category }); },
  });
  await bot.handleUpdate(callbackUpdate('statement:payoneer'));
  assert.equal(edited.length, 1);
  assert.match(sent[0][1], /Пришлите выписку Payoneer файлом \.csv/);
  await bot.handleUpdate(messageUpdate({
    content: { document: { file_id: 'file-1', file_name: 'wrong.xls', file_size: 100 } },
    updateId: 101,
  }));
  assert.match(sent.at(-1)[1], /файлом \.csv/);
  assert.equal(processed.length, 0);
  await bot.handleUpdate(messageUpdate({
    content: { document: { file_id: 'file-2', file_name: 'statement.csv', file_size: 100 } },
    updateId: 102,
  }));
  assert.deepEqual(processed[0], {
    bank: 'payoneer', owner: ownerId,
    transactions: [{
      date: '2026-09-15T14:03:05.000Z', amount: 12.5,
      currency: 'USD', description: 'APPLE.COM/BILL',
    }],
  });
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat()
    .find((item) => item.text === '🎮 Игры');
  await bot.handleUpdate(callbackUpdate(button.callback_data, 103));
  assert.deepEqual(learned, [{ bank: 'payoneer', description: 'APPLE.COM/BILL', category: 'Игры' }]);
  assert.match(sent.at(-1)[1], /Payoneer: обработано списаний 1, новых 1/);
});

test('Hipotekarna file asks for a category and learns the answer', async () => {
  let learned;
  let calls = 0;
  const { bot, sent } = createHarness({
    download: async () => statementBuffer(),
    process: async (_bank, transactions, options) => {
      assert.equal(options.owner, ownerId);
      calls++;
      return calls === 1
        ? { pending: transactions[0], added: 0, total: 1 }
        : { pending: null, added: 1, total: 1 };
    },
    learn: async (bank, description, category) => { learned = { bank, description, category }; },
  });
  await bot.handleUpdate(callbackUpdate('statement:hipotekarna'));
  await bot.handleUpdate(messageUpdate({
    content: {
      document: { file_id: 'file-1', file_name: 'statement.xls', file_size: 1234 },
    },
    updateId: 101,
  }));
  assert.match(sent.at(-1)[1], /Выберите категорию для операции/);
  const buttons = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, CATEGORIES.length + 2);
  assert.equal(buttons.at(-2).text, '➕ Новая категория');
  assert.equal(buttons.at(-1).text, '🚫 Не учитывать');
  assert.equal(buttons.find((button) => button.text === '🛍️ Продуктовые магазины') !== undefined, true);
  assert.equal(buttons.find((button) => button.text === '🏠 Коммуналка и т.п.') !== undefined, true);
  await bot.handleUpdate(callbackUpdate(buttons.find((button) => button.text === '🛍️ Продуктовые магазины').callback_data, 102));
  assert.deepEqual(learned, { bank: 'hipotekarna', description: 'Shop', category: 'Продуктовые магазины' });
  assert.match(sent.at(-1)[1], /новых 1/);
});

test('custom categories receive a label icon', async () => {
  const { bot, sent } = createHarness({
    download: async () => statementBuffer(),
    categories: async () => [...CATEGORIES, 'Хобби'],
    process: async (_bank, transactions) => ({ pending: transactions[0], added: 0, total: 1 }),
  });
  await bot.handleUpdate(callbackUpdate('statement:hipotekarna'));
  await bot.handleUpdate(messageUpdate({
    content: { document: { file_id: 'file-1', file_name: 'statement.xls', file_size: 1234 } },
    updateId: 101,
  }));
  const buttons = sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  assert.equal(buttons.find((button) => button.text === '🏷️ Хобби') !== undefined, true);
});

test('new category is created during classification and applied to the transaction', async () => {
  let learned;
  let calls = 0;
  const { bot, sent } = createHarness({
    download: async () => statementBuffer(),
    process: async (_bank, transactions) => {
      calls++;
      return calls === 1
        ? { pending: transactions[0], added: 0, total: 1 }
        : { pending: null, added: 1, total: 1 };
    },
    createCategory: async (name) => {
      assert.equal(name, 'хобби');
      return { category: 'Хобби', added: true };
    },
    learn: async (bank, description, category) => { learned = { bank, description, category }; },
  });
  await bot.handleUpdate(callbackUpdate('statement:hipotekarna'));
  await bot.handleUpdate(messageUpdate({
    content: { document: { file_id: 'file-1', file_name: 'statement.xls', file_size: 1234 } },
    updateId: 101,
  }));
  const newButton = sent.at(-1)[2].reply_markup.inline_keyboard.flat()
    .find((button) => button.text === '➕ Новая категория');
  await bot.handleUpdate(callbackUpdate(newButton.callback_data, 102));
  assert.match(sent.at(-1)[1], /Напишите название новой категории/);
  await bot.handleUpdate(messageUpdate({ content: { text: 'хобби' }, updateId: 103 }));
  assert.deepEqual(learned, { bank: 'hipotekarna', description: 'Shop', category: 'Хобби' });
  assert.match(sent.at(-2)[1], /Категория «Хобби» добавлена/);
  assert.match(sent.at(-1)[1], /новых 1/);
});

test('statement operation can be excluded and the description is learned', async () => {
  let excluded;
  let calls = 0;
  const { bot, sent } = createHarness({
    download: async () => statementBuffer(),
    process: async (_bank, transactions) => {
      calls++;
      return calls === 1
        ? { pending: transactions[0], added: 0, total: 1, skippedExcluded: 0 }
        : { pending: null, added: 0, total: 1, skippedExcluded: 1 };
    },
    exclude: async (bank, description) => { excluded = { bank, description }; },
  });
  await bot.handleUpdate(callbackUpdate('statement:hipotekarna'));
  await bot.handleUpdate(messageUpdate({
    content: { document: { file_id: 'file-1', file_name: 'statement.xls', file_size: 1234 } },
    updateId: 101,
  }));
  const button = sent.at(-1)[2].reply_markup.inline_keyboard.flat()
    .find((item) => item.text === '🚫 Не учитывать');
  await bot.handleUpdate(callbackUpdate(button.callback_data, 102));
  assert.deepEqual(excluded, { bank: 'hipotekarna', description: 'Shop' });
  assert.match(sent.at(-1)[1], /новых 0, исключено 1/);
});

test('Hipotekarna file is processed as EUR without a currency question', async () => {
  let processed;
  const { bot, sent } = createHarness({
    download: async () => statementBuffer(),
    process: async (_bank, transactions) => {
      processed = transactions;
      return { pending: null, added: 1, total: 1 };
    },
  });
  await bot.handleUpdate(callbackUpdate('statement:hipotekarna'));
  await bot.handleUpdate(messageUpdate({
    content: { document: { file_id: 'file-1', file_name: 'statement.xls', file_size: 1234 } },
    updateId: 101,
  }));
  assert.equal(processed[0].currency, 'EUR');
  assert.match(sent.at(-1)[1], /обработано списаний 1/);
  assert.equal(sent.some(([, text]) => text.includes('Какая валюта')), false);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const XLSX = require('xlsx');
const { createBot } = require('../src/bot');
const { CATEGORIES } = require('../src/constants/categories');
const { CURRENCIES } = require('../src/services/transaction-store');

const ownerId = 123;

function createHarness(services) {
  const sent = [];
  const edited = [];
  const bot = createBot({ token: 'test-token', ownerId: String(ownerId) }, {
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

function callbackUpdate(data, updateId = 100) {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: ownerId, is_bot: false, first_name: 'Test' },
      message: {
        message_id: 1,
        date: 1_780_000_000,
        chat: { id: ownerId, type: 'private' },
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

test('statement button opens bank selection and Hipotekarna asks for a file', async () => {
  const { bot, sent, edited } = createHarness();
  await bot.handleUpdate(messageUpdate());
  assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].callback_data, 'statement:add');
  assert.equal(sent[0][2].reply_markup.inline_keyboard[1][0].text, 'Внести наличные траты');

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
    .find((item) => item.text === '🛍️ Магазины');
  await bot.handleUpdate(callbackUpdate(button.callback_data, 103));
  assert.deepEqual(saved, [{ amount: 12.5, category: 'Магазины', owner: ownerId }]);
  assert.match(sent.at(-1)[1], /Записала наличную трату 12\.50 EUR/);
  assert.equal(sent.at(-1)[2].reply_markup.inline_keyboard[1][0].text, 'Внести наличные траты');
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
  assert.deepEqual(saved, [{ amount: 5, category: 'Магазины', currency: 'USD' }]);
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

test('Payoneer reports that import is in development', async () => {
  const { bot, sent, edited } = createHarness();
  await bot.handleUpdate(callbackUpdate('statement:payoneer'));
  assert.equal(edited.length, 1);
  assert.match(sent[0][1], /Payoneer пока в разработке/);
  assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].text, 'Добавить выписку');
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
  assert.equal(buttons.length, 21);
  assert.equal(buttons.at(-2).text, '➕ Новая категория');
  assert.equal(buttons.at(-1).text, '🚫 Не учитывать');
  assert.equal(buttons.find((button) => button.text === '🛍️ Магазины') !== undefined, true);
  assert.equal(buttons.find((button) => button.text === '🏠 Коммуналка и т.п.') !== undefined, true);
  await bot.handleUpdate(callbackUpdate(buttons.find((button) => button.text === '🛍️ Магазины').callback_data, 102));
  assert.deepEqual(learned, { bank: 'hipotekarna', description: 'Shop', category: 'Магазины' });
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

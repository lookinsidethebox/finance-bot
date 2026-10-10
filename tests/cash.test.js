const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  addCashExpense, getCashCurrency, listCurrencies, setCashCurrency, addCustomCurrency,
  CurrencyCodeError,
} = require('../src/services/transaction-store');

test('cash expenses keep their entry time and the selected currency in transactions.json', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-bot-cash-'));
  try {
    const options = {
      file: path.join(directory, 'transactions.json'),
      categoriesFile: path.join(directory, 'custom-categories.json'),
      settingsFile: path.join(directory, 'settings.json'),
      owner: 123,
      now: () => new Date('2026-10-10T15:42:19.000Z'),
    };
    assert.equal(await getCashCurrency(options), 'EUR');
    const first = await addCashExpense(12.5, 'Магазины', options);
    assert.deepEqual(first, {
      date: '2026-10-10T15:42:19.000Z', amount: 12.5, currency: 'EUR',
      description: 'Наличные траты', category: 'Магазины',
      owner: 123,
    });

    await setCashCurrency('USD', options);
    await addCashExpense(8.25, 'Аптека', options);
    assert.deepEqual(await addCustomCurrency(' gbp ', options), { code: 'GBP', added: true });
    assert.equal(await getCashCurrency(options), 'GBP');
    assert.equal((await listCurrencies(options)).at(-1).code, 'GBP');
    await addCashExpense(3, 'Спорт', options);

    const saved = JSON.parse(await fs.readFile(options.file, 'utf8')).transactions;
    assert.deepEqual(saved.map((transaction) => transaction.currency), ['EUR', 'USD', 'GBP']);
    assert.deepEqual(saved.map((transaction) => transaction.amount), [12.5, 8.25, 3]);
    assert.deepEqual(JSON.parse(await fs.readFile(options.settingsFile, 'utf8')),
      { cashCurrency: 'GBP', customCurrencies: ['GBP'] });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('invalid cash values and currency codes are not persisted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-bot-cash-'));
  try {
    const options = {
      file: path.join(directory, 'transactions.json'),
      categoriesFile: path.join(directory, 'custom-categories.json'),
      settingsFile: path.join(directory, 'settings.json'),
      owner: 123,
    };
    await assert.rejects(addCashExpense(0, 'Магазины', options), /сумма/);
    await assert.rejects(addCashExpense(1, 'Нет такой категории', options), /категория/);
    assert.throws(() => addCustomCurrency('фунты', options), CurrencyCodeError);
    await assert.rejects(setCashCurrency('GBP', options), CurrencyCodeError);
    await assert.rejects(fs.access(options.file), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

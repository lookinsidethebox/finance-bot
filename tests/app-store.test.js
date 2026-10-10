const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseAppStoreItems, appStoreCategories, saveAppStoreReceipt, processStatement,
  migrateAppStoreReceipts,
  AppStoreInputError,
} = require('../src/services/transaction-store');

function appleBill(amount, date = '2026-09-21T00:45:33.000Z') {
  return { date, amount, currency: 'USD', description: 'APPLE.COM/BILL' };
}

async function temporaryStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-app-store-'));
  const options = {
    file: path.join(directory, 'transactions.json'),
    receiptsFile: path.join(directory, 'app-store-receipts.json'),
    rulesFile: path.join(directory, 'category-rules.json'),
    exclusionsFile: path.join(directory, 'exclusion-rules.json'),
    owner: 123,
  };
  try {
    await fs.writeFile(options.rulesFile,
      JSON.stringify({ payoneer: { 'apple.com/bill': 'Подписки' } }));
    await run(options);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('parses one app and USD amount per line and rejects malformed receipts', () => {
  assert.deepEqual(parseAppStoreItems('Music – $10\nCloud — $3.50\nGame - $0,99'), [
    { name: 'Music', amount: 10 }, { name: 'Cloud', amount: 3.5 },
    { name: 'Game', amount: 0.99 },
  ]);
  for (const input of ['Music $10', 'Music – €10', 'Music – $0', 'Music – $1.999', '']) {
    assert.throws(() => parseAppStoreItems(input), AppStoreInputError);
  }
});

test('moves legacy receipts to their own file and can safely repeat the migration', async () => {
  await temporaryStore(async (options) => {
    const receipt = { date: '2026-09-14', owner: 123, total: 23.98,
      items: [{ name: 'Music', amount: 10 }, { name: 'Cloud', amount: 13.98 }] };
    const legacy = { transactions: [], appStoreReceipts: [receipt] };
    await fs.writeFile(options.file, JSON.stringify(legacy));
    assert.equal(await migrateAppStoreReceipts(options), 1);
    assert.deepEqual(JSON.parse(await fs.readFile(options.file)), { transactions: [] });
    assert.deepEqual(JSON.parse(await fs.readFile(options.receiptsFile)), { receipts: [receipt] });
    // Simulate a stop after the separate file was written, before the old field was removed.
    await fs.writeFile(options.file, JSON.stringify(legacy));
    assert.equal(await migrateAppStoreReceipts(options), 1);
    assert.deepEqual(JSON.parse(await fs.readFile(options.file)), { transactions: [] });
    assert.equal(JSON.parse(await fs.readFile(options.receiptsFile)).receipts.length, 1);
  });
});

test('retry completes a receipt saved before its app transactions', async () => {
  await temporaryStore(async (options) => {
    const items = parseAppStoreItems('Music – $10\nMusic – $10');
    await fs.writeFile(options.receiptsFile, JSON.stringify({ receipts: [
      { date: '2026-09-14', owner: 123, total: 20, items },
    ] }));
    const result = await saveAppStoreReceipt('2026-09-14', items, options);
    assert.equal(result.duplicate, true);
    assert.equal(JSON.parse(await fs.readFile(options.file)).transactions.length, 2);
    assert.equal(JSON.parse(await fs.readFile(options.receiptsFile)).receipts.length, 1);
  });
});

test('selected App Store category is saved on the transaction, receipt and rule', async () => {
  await temporaryStore(async (options) => {
    const items = [
      { name: 'Food Hunt', amount: 29.99, category: 'Игры' },
      { name: 'Music', amount: 10, category: 'Подписки' },
    ];
    assert.deepEqual(await appStoreCategories(items, options), [null, null]);
    await saveAppStoreReceipt('2026-10-04', items, options);
    const transactions = JSON.parse(await fs.readFile(options.file)).transactions;
    assert.deepEqual(transactions.map(({ category }) => category), ['Игры', 'Подписки']);
    const receipts = JSON.parse(await fs.readFile(options.receiptsFile)).receipts;
    assert.deepEqual(receipts[0].items, items);
    assert.deepEqual(await appStoreCategories(items, options), ['Игры', 'Подписки']);
    const rules = JSON.parse(await fs.readFile(options.rulesFile));
    assert.equal(rules.appStore['food hunt'], 'Игры');
    await saveAppStoreReceipt('2026-11-04', [{ name: 'Food Hunt', amount: 5 }], options);
    const later = JSON.parse(await fs.readFile(options.file)).transactions.at(-1);
    assert.equal(later.category, 'Игры');
  });
});

test('a receipt replaces one matching Apple charge for the same owner within three days', async () => {
  await temporaryStore(async (options) => {
    const otherOwner = { ...appleBill(44.97), category: 'Подписки', owner: 456 };
    const otherDate = { ...appleBill(44.97, '2026-09-25T10:00:00.000Z'),
      category: 'Подписки', owner: 123 };
    const euroBill = { ...appleBill(44.97), currency: 'EUR', category: 'Подписки', owner: 123 };
    await fs.writeFile(options.file, JSON.stringify({ transactions: [
      { ...appleBill(44.97, '2026-09-24T00:45:33.000Z'), category: 'Подписки', owner: 123 },
      { ...appleBill(66.96, '2026-09-21T00:45:32.000Z'), category: 'Подписки', owner: 123 },
      otherOwner, otherDate, euroBill,
    ] }));
    const items = parseAppStoreItems('Music – $29.98\nCloud – $14.99');
    const result = await saveAppStoreReceipt('2026-09-21', items, options);
    assert.deepEqual(result, { added: 2, removedApple: 1, duplicate: false, total: 44.97 });
    const stored = JSON.parse(await fs.readFile(options.file));
    assert.equal(stored.transactions.length, 6);
    assert.equal(stored.transactions.filter((item) => item.description === 'APPLE.COM/BILL').length, 4);
    assert.deepEqual(stored.transactions.slice(-2), [
      { date: '2026-09-21', amount: 29.98, currency: 'USD',
        description: 'App Store: Music', category: 'Подписки', owner: 123 },
      { date: '2026-09-21', amount: 14.99, currency: 'USD',
        description: 'App Store: Cloud', category: 'Подписки', owner: 123 },
    ]);
    assert.equal(Object.hasOwn(stored, 'appStoreReceipts'), false);
    const receipts = JSON.parse(await fs.readFile(options.receiptsFile));
    assert.equal(receipts.receipts.length, 1);
    const rules = JSON.parse(await fs.readFile(options.rulesFile));
    assert.deepEqual(rules.appStore, { music: 'Подписки', cloud: 'Подписки' });
    assert.equal(rules.payoneer['apple.com/bill'], 'Подписки');
    const duplicate = await saveAppStoreReceipt('2026-09-21', [...items].reverse(), options);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.added, 0);
    assert.equal(duplicate.removedApple, 0);
    assert.equal(JSON.parse(await fs.readFile(options.file)).transactions.length, 6);
  });
});

test('resending a saved receipt removes a delayed Apple charge without duplicating apps', async () => {
  await temporaryStore(async (options) => {
    const items = parseAppStoreItems('Music – $10\nCloud – $13.98');
    const first = await saveAppStoreReceipt('2026-09-12', items, options);
    assert.equal(first.removedApple, 0);
    const stored = JSON.parse(await fs.readFile(options.file));
    stored.transactions.push({ ...appleBill(23.98, '2026-09-15T00:39:44.000Z'),
      category: 'Подписки', owner: 123 });
    await fs.writeFile(options.file, JSON.stringify(stored));
    const retry = await saveAppStoreReceipt('2026-09-12', items, options);
    assert.deepEqual(retry, { added: 0, removedApple: 1, duplicate: true, total: 23.98 });
    const after = JSON.parse(await fs.readFile(options.file));
    assert.equal(after.transactions.length, 2);
    assert.equal(Object.hasOwn(after, 'appStoreReceipts'), false);
    assert.equal(JSON.parse(await fs.readFile(options.receiptsFile)).receipts.length, 1);
    assert.equal(after.transactions.filter((item) => item.description === 'APPLE.COM/BILL').length, 0);
  });
});

test('a later Payoneer statement skips one Apple charge per saved receipt and remains idempotent', async () => {
  await temporaryStore(async (options) => {
    const items = parseAppStoreItems('Music – $10\nCloud – $10');
    await saveAppStoreReceipt('2026-09-21', items, options);
    const statement = [appleBill(20), appleBill(20, '2026-09-21T00:45:34.000Z')];
    const first = await processStatement('payoneer', statement, options);
    assert.equal(first.skippedAppStore, 1);
    assert.equal(first.added, 1);
    assert.equal(first.pending, null);
    const second = await processStatement('payoneer', statement, options);
    assert.equal(second.skippedAppStore, 1);
    assert.equal(second.added, 0);
    const transactions = JSON.parse(await fs.readFile(options.file)).transactions;
    assert.equal(transactions.filter((item) => item.description.startsWith('App Store: ')).length, 2);
    assert.equal(transactions.filter((item) => item.description === 'APPLE.COM/BILL').length, 1);
    const differentOwner = await processStatement('payoneer', [appleBill(20)],
      { ...options, owner: 456 });
    assert.equal(differentOwner.skippedAppStore, 0);
    assert.equal(differentOwner.added, 1);
  });
});

test('Payoneer skips a matching Apple charge up to three days after the receipt', async () => {
  await temporaryStore(async (options) => {
    await saveAppStoreReceipt('2026-09-12', parseAppStoreItems('Music – $23.98'), options);
    const statement = [
      appleBill(23.98, '2026-09-11T23:59:59.000Z'),
      appleBill(23.98, '2026-09-15T00:39:44.000Z'),
      appleBill(23.98, '2026-09-16T00:00:00.000Z'),
    ];
    const result = await processStatement('payoneer', statement, options);
    assert.equal(result.skippedAppStore, 1);
    assert.equal(result.added, 2);
    const stored = JSON.parse(await fs.readFile(options.file));
    assert.deepEqual(stored.transactions.filter((item) => item.description === 'APPLE.COM/BILL')
      .map((item) => item.date), [statement[0].date, statement[2].date]);
  });
});

test('a nonmatching Apple amount remains alongside the split receipt', async () => {
  await temporaryStore(async (options) => {
    await fs.writeFile(options.file, JSON.stringify({ transactions: [
      { ...appleBill(21), category: 'Подписки', owner: 123 },
    ] }));
    const result = await saveAppStoreReceipt('2026-09-21',
      parseAppStoreItems('Music – $10\nCloud – $10'), options);
    assert.equal(result.removedApple, 0);
    const stored = JSON.parse(await fs.readFile(options.file));
    assert.equal(stored.transactions.length, 3);
    assert.equal(stored.transactions[0].description, 'APPLE.COM/BILL');
  });
});

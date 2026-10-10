const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const { parseHipotekarnaStatement } = require('../src/importers/hipotekarna');
const {
  processStatement, learnCategory, descriptionKey, addCategory, listCategories,
} = require('../src/services/transaction-store');

const headers = [
  'Valuta', 'Svrha', 'Reklamacija', 'Vrsta transakcije', 'Primaoc',
  'Račun primaoca', 'Pošiljalac', 'Račun pošiljaoca',
  'Model i poziv na broj', 'Poziv odobrenja', 'Odliv', 'Priliv', 'Iznos',
];

function statement() {
  const rows = [
    ['Kartica računa: TEST USER 123456789012345678 Datum obrade: 01.09.2026. - 30.09.2026.'],
    headers,
    [46267, 'Shop', 'ref-1', 'M02', '', '', '', '123456789012345678', '', '', 10, 0, -10],
    [46267, 'Shop', 'ref-2', 'M02', '', '', '', '123456789012345678', '', '', 10, 0, -10],
    [46268, 'Salary', 'ref-3', 'W02', '', '', '', '', '', '', 0, 100, 100],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Stanje');
  return XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' });
}

test('Hipotekarna importer keeps separate debits and skips credits', () => {
  const result = parseHipotekarnaStatement(statement());
  assert.equal(result.transactions.length, 2);
  assert.equal(result.skippedIncoming, 1);
  assert.deepEqual(result.transactions, [
    { date: '2026-09-02', amount: 10, currency: 'EUR', description: 'Shop' },
    { date: '2026-09-02', amount: 10, currency: 'EUR', description: 'Shop' },
  ]);
});

test('chosen category is learned and duplicate equal expenses remain separate', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-bot-'));
  try {
    const file = path.join(directory, 'transactions.json');
    const rulesFile = path.join(directory, 'category-rules.json');
    const options = { file, rulesFile, categoriesFile: path.join(directory, 'categories.json') };
    const { transactions } = parseHipotekarnaStatement(statement());
    const first = await processStatement('hipotekarna', transactions, options);
    assert.equal(first.pending.description, 'Shop');
    assert.equal(first.added, 0);
    await learnCategory('hipotekarna', 'Shop', 'Магазины', options);
    const second = await processStatement('hipotekarna', transactions, options);
    assert.equal(second.pending, null);
    assert.equal(second.added, 2);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')).transactions;
    assert.equal(saved.length, 2);
    assert.deepEqual(Object.keys(saved[0]), ['date', 'amount', 'currency', 'description', 'category']);
    assert.deepEqual(saved.map((transaction) => transaction.category), ['Магазины', 'Магазины']);
    const repeated = await processStatement('hipotekarna', transactions, options);
    assert.equal(repeated.added, 0);
    assert.equal(repeated.pending, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Spotify changing suffix and close descriptions reuse a learned category', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-bot-'));
  try {
    const options = {
      file: path.join(directory, 'transactions.json'),
      rulesFile: path.join(directory, 'category-rules.json'),
      categoriesFile: path.join(directory, 'categories.json'),
    };
    assert.equal(descriptionKey('SPOTIFY*X123456789'), 'spotify');
    assert.equal(descriptionKey('SPOTIFY*Z999999999'), 'spotify');
    await learnCategory('hipotekarna', 'SPOTIFY*X123456789', 'Подписки', options);
    await learnCategory('hipotekarna', 'Mtel doo SelfCare', 'Связь и интернет', options);
    const result = await processStatement('hipotekarna', [
      { date: '2026-10-01', amount: 10.49, currency: 'EUR', description: 'SPOTIFY*Z999999999' },
      { date: '2026-10-02', amount: 12, currency: 'EUR', description: 'Mtel doo SelfCare2' },
    ], options);
    assert.equal(result.pending, null);
    assert.equal(result.added, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('custom category is persisted, capitalized and usable for learned rules', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-bot-'));
  try {
    const options = {
      file: path.join(directory, 'transactions.json'),
      rulesFile: path.join(directory, 'category-rules.json'),
      categoriesFile: path.join(directory, 'categories.json'),
    };
    assert.deepEqual(await addCategory('  хобби  ', options), { category: 'Хобби', added: true });
    assert.deepEqual(await addCategory('ХОББИ', options), { category: 'Хобби', added: false });
    const categories = await listCategories(options);
    assert.equal(categories.includes('Хобби'), true);
    assert.equal(categories.includes('Коммуналка и т.п.'), true);
    assert.equal(categories.includes('Связь и интернет'), true);
    assert.equal(categories.includes('коммуналка, связь и интернет'), false);
    await learnCategory('hipotekarna', 'Craft Shop', 'Хобби', options);
    const result = await processStatement('hipotekarna', [
      { date: '2026-10-01', amount: 10, currency: 'EUR', description: 'Craft Shop' },
    ], options);
    assert.equal(result.added, 1);
    assert.equal(JSON.parse(await fs.readFile(options.file, 'utf8')).transactions[0].category, 'Хобби');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a different statement layout is rejected', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Amount']]), 'Sheet1');
  const buffer = XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' });
  assert.throws(() => parseHipotekarnaStatement(buffer), /Hipotekarna/);
});

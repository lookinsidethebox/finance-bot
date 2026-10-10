const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  loadTransactions, availableYears, availableMonths, monthlyStatistics, formatMonthlyStatistics,
  parseReportDate, categoryExpenses, formatCategoryExpenses,
} = require('../src/services/statistics.service');

function expense(date, amount, currency, category, description, owner = 123) {
  return { date, amount, currency, category, description, owner };
}

test('validates calendar dates and filters category expenses inclusively by owner', () => {
  assert.equal(parseReportDate('01.09.2026'), '2026-09-01');
  assert.equal(parseReportDate('2026-09-30'), '2026-09-30');
  assert.equal(parseReportDate('29.02.2028'), '2028-02-29');
  assert.equal(parseReportDate('29.02.2027'), null);
  assert.equal(parseReportDate('31.09.2026'), null);
  assert.equal(parseReportDate('1.9.2026'), null);
  const transactions = [
    expense('2026-08-31', 100, 'EUR', 'Крипта', 'Before'),
    expense('2026-09-01', 2.5, 'EUR', 'Крипта', 'First'),
    expense('2026-09-30T23:59:00.000Z', 3, 'USD', 'Крипта', '<Last&>'),
    expense('2026-09-15', 8, 'EUR', 'Крипта', 'Other owner', 456),
    expense('2026-09-15', 20, 'EUR', 'Игры', 'Other category'),
    expense('2026-10-01', 5, 'EUR', 'Крипта', 'After'),
  ];
  const report = categoryExpenses(transactions,
    { category: 'Крипта', start: '2026-09-01', end: '2026-09-30', owner: 123 });
  assert.deepEqual(report.transactions.map((transaction) => transaction.description), ['<Last&>', 'First']);
  assert.deepEqual([...report.totals], [['EUR', 250], ['USD', 300]]);
  const messages = formatCategoryExpenses(report);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Крипта/);
  assert.match(messages[0], /30\.09\.2026/);
  assert.match(messages[0], /2,50 €/);
  assert.match(messages[0], /3,00 \$/);
  assert.match(messages[0], /&lt;Last&amp;&gt;/);
  assert.doesNotMatch(messages[0], /Other owner|Before|After/);
  const empty = categoryExpenses(transactions,
    { category: 'Крипта', start: '2026-11-01', end: '2026-11-30', owner: 123 });
  assert.match(formatCategoryExpenses(empty)[0], /За этот период трат нет/);
});

test('splits a long category report into Telegram sized messages', () => {
  const transactions = Array.from({ length: 12 }, (_, index) =>
    expense('2026-09-10', index + 1, 'EUR', 'Игры', `Entry ${index} ${'&'.repeat(700)}`));
  const report = categoryExpenses(transactions,
    { category: 'Игры', start: '2026-09-01', end: '2026-09-30', owner: 123 });
  const messages = formatCategoryExpenses(report);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 3900));
  assert.match(messages[0], /Операций: 12/);
});

test('finds years and months separately for one owner and everyone', () => {
  const transactions = [
    expense('2026-09-01', 5, 'EUR', 'Аптека', 'A'),
    expense('2026-10-02T09:00:00.000Z', 7, 'USD', 'Игры', 'B', 456),
    expense('2027-01-03', 8, 'EUR', 'Аптека', 'C', 456),
  ];
  assert.deepEqual(availableYears(transactions, 123), ['2026']);
  assert.deepEqual(availableYears(transactions), ['2026', '2027']);
  assert.deepEqual(availableMonths(transactions, '2026', 123), ['09']);
  assert.deepEqual(availableMonths(transactions, '2026'), ['09', '10']);
});

test('sums by currency and category and ranks nominal amounts without conversion', () => {
  const transactions = [
    expense('2026-09-01', 30.1, 'EUR', 'Аптека', 'Medicine'),
    expense('2026-09-02', 20.2, 'EUR', 'Аптека', 'Medicine 2'),
    expense('2026-09-03T08:00:00.000Z', 120, 'USD', 'Игры', 'Game'),
    expense('2026-09-04', 10, 'USD', 'Аптека', 'Subscription', 456),
    expense('2026-09-05', 100, 'RUB', 'Подарки', 'Gift'),
    expense('2026-10-01', 999, 'EUR', 'Прочее', 'Later'),
  ];
  const mine = monthlyStatistics(transactions, { year: '2026', month: '09', owner: 123 });
  assert.equal(mine.count, 4);
  assert.deepEqual([...mine.totals], [['EUR', 5030], ['USD', 12000], ['RUB', 10000]]);
  assert.deepEqual(mine.categories.map(([name]) => name), ['Игры', 'Подарки', 'Аптека']);
  assert.deepEqual(mine.top.map((entry) => entry.description),
    ['Game', 'Gift', 'Medicine', 'Medicine 2']);
  const everyone = monthlyStatistics(transactions, { year: '2026', month: '09' });
  assert.equal(everyone.count, 5);
  assert.equal(everyone.totals.get('USD'), 13000);
  assert.equal(monthlyStatistics(transactions, { year: '2025', month: '09' }), null);
  const text = formatMonthlyStatistics(mine, 'mine');
  assert.match(text.summary, /<b>📊 Мои траты · сентябрь 2026<\/b>/);
  assert.match(text.summary, /<b>💰 Всего<\/b>/);
  assert.match(text.summary, /Аптека — <b>50,30 €<\/b>/);
  assert.match(text.summary, /Игры — <b>0,00 €<\/b> \(<b>120,00 \$<\/b>\)/);
  assert.doesNotMatch(text.summary, /Прочее/);
  assert.doesNotMatch(text.summary, /Порядок по суммам/);
  assert.match(text.top, /<b>🏆 10 крупнейших транзакций<\/b>/);
  assert.match(text.top, /<b>1\.<\/b> <b>03\.09\.2026<\/b> · <b>120,00 \$<\/b> · Игры\n   Game/);
});

test('escapes HTML metacharacters in transaction descriptions', () => {
  const report = monthlyStatistics([
    expense('2026-09-03', 5, 'EUR', 'Прочее', 'A < B & C > D'),
  ], { year: '2026', month: '09' });
  const text = formatMonthlyStatistics(report, 'all');
  assert.match(text.top, /A &lt; B &amp; C &gt; D/);
  assert.doesNotMatch(text.top, /A < B & C > D/);
});

test('returns exactly ten largest transactions and reads the JSON without changing it', async () => {
  const transactions = Array.from({ length: 12 }, (_, index) =>
    expense('2026-09-01', index + 1, index % 2 ? 'USD' : 'EUR', 'Прочее', `Item ${index}`));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-stats-'));
  try {
    const file = path.join(directory, 'transactions.json');
    const original = JSON.stringify({ transactions });
    await fs.writeFile(file, original);
    const loaded = await loadTransactions({ file });
    const report = monthlyStatistics(loaded, { year: '2026', month: '09', owner: 123 });
    assert.equal(report.top.length, 10);
    assert.deepEqual(report.top.map((entry) => entry.amount),
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

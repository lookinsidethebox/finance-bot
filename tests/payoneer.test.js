const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePayoneerStatement, PayoneerStatementError } = require('../src/importers/payoneer');

const HEADERS = [
  'Transaction Date', 'Transaction Time', 'Time Zone', 'Transaction ID', 'Description',
  'Credit Amount', 'Debit Amount', 'Currency', 'Transfer Amount',
  'Transfer Amount Currency', 'Status', 'Running Balance', 'Additional Description',
  'Store Name', 'Source', 'Target', 'Reference ID',
];

function csv(records) {
  const lines = [HEADERS, ...records].map((record) => record.map((value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`);
}

function row({ date = '09/15/2026', time = '14:03:05', zone = 'UTC', credit = '',
  debit = '12.50', currency = 'USD', status = 'Completed', source = 'USD balance',
  target = 'APPLE.COM/BILL' } = {}) {
  return [date, time, zone, 'id-1', 'Card purchase', credit, debit, currency, '', '', status,
    '', '', '', source, target, ''];
}

test('imports USD and EUR debits using Source currency and Target description', () => {
  const parsed = parsePayoneerStatement(csv([
    row({ target: 'SHOP, LLC' }),
    row({ source: 'EUR balance', currency: 'EUR', debit: '1,234.56', target: 'Cafe "A"' }),
  ]));
  assert.deepEqual(parsed.transactions, [
    { date: '2026-09-15T14:03:05.000Z', amount: 12.5, currency: 'USD', description: 'SHOP, LLC' },
    { date: '2026-09-15T14:03:05.000Z', amount: 1234.56, currency: 'EUR', description: 'Cafe "A"' },
  ]);
});

test('skips incoming payments, own-balance transfers, and incomplete rows', () => {
  const parsed = parsePayoneerStatement(csv([
    row({ debit: '', credit: '100.00', source: 'CLIENT', target: 'USD balance' }),
    row({ debit: '25.00', target: 'EUR balance' }),
    row({ status: 'Pending' }),
    row({ target: 'SHOP' }),
  ]));
  assert.deepEqual(parsed.transactions.map((transaction) => transaction.description), ['SHOP']);
  assert.equal(parsed.skippedIncoming, 1);
  assert.equal(parsed.skippedTransfers, 1);
  assert.equal(parsed.skippedOther, 1);
});

test('rejects bad format, ambiguous amounts, currencies, and dates', () => {
  const invalid = [
    Buffer.from('Source,Target\nUSD balance,SHOP'),
    csv([row({ debit: '12.345' })]),
    csv([row({ credit: '1.00' })]),
    csv([row({ source: 'EUR balance', currency: 'USD' })]),
    csv([row({ date: '02/30/2026' })]),
    csv([row({ zone: 'PST' })]),
  ];
  for (const buffer of invalid) {
    assert.throws(() => parsePayoneerStatement(buffer), PayoneerStatementError);
  }
});

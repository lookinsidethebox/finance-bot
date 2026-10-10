const BANK = 'payoneer';
class PayoneerStatementError extends Error {}

const REQUIRED_HEADERS = [
  'Transaction Date', 'Transaction Time', 'Time Zone', 'Debit Amount',
  'Credit Amount', 'Currency', 'Status', 'Source', 'Target',
];
const BALANCE_CURRENCIES = new Map([
  ['USD balance', 'USD'],
  ['EUR balance', 'EUR'],
]);

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  function finishField() {
    row.push(field);
    field = '';
    afterQuote = false;
  }

  function finishRow() {
    finishField();
    rows.push(row);
    row = [];
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        field += char;
      }
    } else if (char === ',') {
      finishField();
    } else if (char === '\r' || char === '\n') {
      finishRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (char === '"' && field === '' && !afterQuote) {
      quoted = true;
    } else if (char === '"' || afterQuote) {
      throw new PayoneerStatementError('Некорректный CSV-файл Payoneer.');
    } else {
      field += char;
    }
  }
  if (quoted) throw new PayoneerStatementError('Незакрытые кавычки в CSV-файле Payoneer.');
  if (row.length || field || afterQuote) finishRow();
  return rows;
}

function amountInCents(value, line) {
  const amount = value.trim();
  if (!amount) return 0;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)) {
    throw new PayoneerStatementError(`Некорректная сумма в строке ${line}.`);
  }
  const [whole, fraction = ''] = amount.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new PayoneerStatementError(`Слишком большая сумма в строке ${line}.`);
  }
  return cents;
}

function transactionDate(dateText, timeText, timeZone, line) {
  if (timeZone.trim() !== 'UTC') {
    throw new PayoneerStatementError(`Неизвестный часовой пояс в строке ${line}.`);
  }
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateText.trim());
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timeText.trim());
  if (!dateMatch || !timeMatch) {
    throw new PayoneerStatementError(`Некорректная дата или время в строке ${line}.`);
  }
  const [, month, day, year] = dateMatch.map(Number);
  const [, hour, minute, second] = timeMatch.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new PayoneerStatementError(`Некорректная дата или время в строке ${line}.`);
  }
  return date.toISOString();
}

function parsePayoneerStatement(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new PayoneerStatementError('CSV-файл Payoneer должен быть в кодировке UTF-8.');
  }
  const rows = csvRows(text);
  const headers = rows.shift();
  if (!headers || !REQUIRED_HEADERS.every((header) => headers.includes(header))
    || new Set(headers).size !== headers.length) {
    throw new PayoneerStatementError('Это не поддерживаемый формат выписки Payoneer.');
  }
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const transactions = [];
  let skippedIncoming = 0;
  let skippedTransfers = 0;
  let skippedOther = 0;

  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    if (row.length === 1 && row[0] === '') continue;
    if (row.length !== headers.length) {
      throw new PayoneerStatementError(`Некорректное число колонок в строке ${line}.`);
    }
    const value = (header) => row[columns[header]].trim();
    const debit = amountInCents(value('Debit Amount'), line);
    const credit = amountInCents(value('Credit Amount'), line);
    if (debit > 0 && credit > 0) {
      throw new PayoneerStatementError(`В строке ${line} одновременно указаны списание и поступление.`);
    }
    if (value('Status') !== 'Completed') {
      skippedOther++;
      continue;
    }
    if (debit === 0) {
      if (credit > 0) skippedIncoming++;
      continue;
    }
    const currency = BALANCE_CURRENCIES.get(value('Source'));
    if (!currency) {
      skippedOther++;
      continue;
    }
    const target = value('Target');
    if (BALANCE_CURRENCIES.has(target)) {
      skippedTransfers++;
      continue;
    }
    if (!target) throw new PayoneerStatementError(`Нет Target в строке ${line}.`);
    if (value('Currency') !== currency) {
      throw new PayoneerStatementError(`Валюта суммы не совпадает с Source в строке ${line}.`);
    }
    transactions.push({
      date: transactionDate(value('Transaction Date'), value('Transaction Time'),
        value('Time Zone'), line),
      amount: debit / 100,
      currency,
      description: target,
    });
  }
  return { transactions, skippedIncoming, skippedTransfers, skippedOther };
}

module.exports = { parsePayoneerStatement, PayoneerStatementError, BANK };

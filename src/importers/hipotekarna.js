const XLSX = require('xlsx');

const BANK = 'hipotekarna';
class StatementError extends Error {}
const HEADERS = [
  'Valuta', 'Svrha', 'Reklamacija', 'Vrsta transakcije', 'Primaoc',
  'Račun primaoca', 'Pošiljalac', 'Račun pošiljaoca',
  'Model i poziv na broj', 'Poziv odobrenja', 'Odliv', 'Priliv', 'Iznos',
];

function dateFromExcel(serial) {
  const parts = XLSX.SSF.parse_date_code(serial);
  if (!parts) throw new StatementError('Некорректная дата операции в выписке Hipotekarna.');
  return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

function readHipotekarnaStatement(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    throw new StatementError('Не удалось прочитать XLS-файл.');
  }

  const sheet = workbook.Sheets.Stanje;
  if (!sheet) throw new StatementError('Это не выписка Hipotekarna: лист Stanje не найден.');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  if (!HEADERS.every((header, index) => rows[1]?.[index] === header)) {
    throw new StatementError('Это не поддерживаемый формат выписки Hipotekarna.');
  }

  return rows;
}

function parseHipotekarnaStatement(buffer) {
  const rows = readHipotekarnaStatement(buffer);

  const transactions = [];
  let skippedIncoming = 0;
  for (const [index, row] of rows.entries()) {
    if (index < 2 || row.every((value) => value == null || value === '')) continue;
    const outgoing = Number(row[10] || 0);
    const incoming = Number(row[11] || 0);
    if (!Number.isFinite(outgoing) || !Number.isFinite(incoming) || outgoing < 0 || incoming < 0) {
      throw new StatementError(`Некорректная сумма в строке ${index + 1}.`);
    }
    if (outgoing === 0) {
      if (incoming > 0) skippedIncoming++;
      continue;
    }
    if (Math.abs(outgoing * 100 - Math.round(outgoing * 100)) > 1e-7) {
      throw new StatementError(`Неоднозначная сумма в строке ${index + 1}.`);
    }

    const description = String(row[1] || '').trim();
    if (!description) {
      throw new StatementError(`Нет описания в строке ${index + 1}.`);
    }
    const date = dateFromExcel(row[0]);
    const amount = Math.round(outgoing * 100) / 100;
    transactions.push({ date, amount, currency: 'EUR', description });
  }

  return { transactions, skippedIncoming };
}

module.exports = { parseHipotekarnaStatement, StatementError, BANK };

const fs = require('node:fs/promises');
const path = require('node:path');
const { categoryButtonLabel } = require('../constants/categories');

const DEFAULT_FILE = path.join(__dirname, '../../data/transactions.json');
const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

async function loadTransactions({ file = DEFAULT_FILE } = {}) {
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!Array.isArray(stored?.transactions)) throw new Error('Некорректный файл транзакций.');
  return stored.transactions;
}

function matchesOwner(transaction, owner) {
  return owner === undefined || transaction.owner === owner;
}

function availableYears(transactions, owner) {
  return [...new Set(transactions.filter((transaction) => matchesOwner(transaction, owner))
    .map((transaction) => /^\d{4}-(?:0[1-9]|1[0-2])-\d{2}/.exec(transaction.date)?.[0].slice(0, 4))
    .filter(Boolean))].sort((a, b) => Number(a) - Number(b));
}

function availableMonths(transactions, year, owner) {
  return [...new Set(transactions.filter((transaction) => matchesOwner(transaction, owner)
    && transaction.date?.startsWith(`${year}-`))
    .map((transaction) => /^(?:\d{4})-(0[1-9]|1[0-2])-\d{2}/.exec(transaction.date)?.[1])
    .filter(Boolean))].sort((a, b) => Number(a) - Number(b));
}

function currencyOrder(currency) {
  if (currency === 'EUR') return 0;
  if (currency === 'USD') return 1;
  return 2;
}

function sortedCurrencies(currencies) {
  return [...currencies].sort((a, b) => currencyOrder(a) - currencyOrder(b)
    || a.localeCompare(b));
}

function amountText(cents, currency) {
  const symbol = { EUR: '€', USD: '$', RUB: '₽', TRY: '₺' }[currency] || currency;
  return `${moneyFormatter.format(cents / 100)} ${symbol}`;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function bold(value) {
  return `<b>${escapeHtml(value)}</b>`;
}

function parseReportDate(input) {
  const text = String(input || '').trim();
  const european = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!european && !iso) return null;
  const [year, month, day] = european
    ? [european[3], european[2], european[1]] : [iso[1], iso[2], iso[3]];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function categoryExpenses(transactions, { category, start, end, owner } = {}) {
  const selected = transactions.filter((transaction) => matchesOwner(transaction, owner)
    && transaction.category === category && transaction.date?.slice(0, 10) >= start
    && transaction.date?.slice(0, 10) <= end);
  const totals = new Map();
  for (const transaction of selected) {
    const cents = Math.round(transaction.amount * 100);
    totals.set(transaction.currency, (totals.get(transaction.currency) || 0) + cents);
  }
  selected.sort((a, b) => b.date.localeCompare(a.date)
    || Math.round(b.amount * 100) - Math.round(a.amount * 100));
  return { category, start, end, transactions: selected, totals,
    currencies: sortedCurrencies(totals.keys()) };
}

function readableDate(date) {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}

function formatCategoryExpenses(report, { maxLength = 3900, scope = 'mine' } = {}) {
  const title = scope === 'all' ? 'Общие траты' : 'Мои траты';
  const heading = bold(`${title} · ${categoryButtonLabel(report.category)} · ${readableDate(report.start)}–${readableDate(report.end)}`);
  const totals = report.currencies.map((currency) =>
    `• ${escapeHtml(currency)}: ${bold(amountText(report.totals.get(currency), currency))}`);
  const header = [heading, '', bold(`Операций: ${report.transactions.length}`),
    ...(totals.length ? [bold('💰 Всего'), ...totals] : ['За этот период трат нет.'])].join('\n');
  const messages = [header];
  for (const transaction of report.transactions) {
    const label = `${bold(readableDate(transaction.date))} · ${bold(amountText(Math.round(transaction.amount * 100), transaction.currency))}`;
    const description = Array.from(String(transaction.description));
    const fragments = [];
    for (let index = 0; index < description.length; index += 600) {
      fragments.push(escapeHtml(description.slice(index, index + 600).join('')));
    }
    if (!fragments.length) fragments.push('');
    for (const [index, fragment] of fragments.entries()) {
      const entry = index === 0 ? `${label}\n${fragment}` : `↳ ${fragment}`;
      const last = messages.length - 1;
      if (messages[last].length + entry.length + 2 <= maxLength) {
        messages[last] += `\n\n${entry}`;
      } else {
        messages.push(entry);
      }
    }
  }
  return messages;
}

function monthlyStatistics(transactions, { year, month, owner } = {}) {
  const selected = transactions.filter((transaction) => matchesOwner(transaction, owner)
    && transaction.date?.startsWith(`${year}-${month}-`));
  if (!selected.length) return null;

  const totals = new Map();
  const categories = new Map();
  for (const transaction of selected) {
    const cents = Math.round(transaction.amount * 100);
    totals.set(transaction.currency, (totals.get(transaction.currency) || 0) + cents);
    if (!categories.has(transaction.category)) categories.set(transaction.category, new Map());
    const amounts = categories.get(transaction.category);
    amounts.set(transaction.currency, (amounts.get(transaction.currency) || 0) + cents);
  }
  const currencies = sortedCurrencies(totals.keys());
  const sortedCategories = [...categories].sort(([nameA, amountsA], [nameB, amountsB]) => {
    const nominalA = [...amountsA.values()].reduce((sum, cents) => sum + cents, 0);
    const nominalB = [...amountsB.values()].reduce((sum, cents) => sum + cents, 0);
    if (nominalA !== nominalB) return nominalB - nominalA;
    for (const currency of currencies) {
      const difference = (amountsB.get(currency) || 0) - (amountsA.get(currency) || 0);
      if (difference) return difference;
    }
    return nameA.localeCompare(nameB, 'ru');
  });
  const top = [...selected].sort((a, b) => Math.round(b.amount * 100) - Math.round(a.amount * 100)
    || currencyOrder(a.currency) - currencyOrder(b.currency)
    || a.currency.localeCompare(b.currency)
    || b.date.localeCompare(a.date)).slice(0, 10);
  return { year, month, count: selected.length, totals, categories: sortedCategories, top, currencies };
}

function formatMonthlyStatistics(report, scope) {
  const title = scope === 'mine' ? 'Мои траты' : 'Общие траты';
  const monthName = MONTH_NAMES[Number(report.month) - 1];
  const heading = bold(`📊 ${title} · ${monthName} ${report.year}`);
  const totals = report.currencies.map((currency) =>
    `• ${escapeHtml(currency)}: ${bold(amountText(report.totals.get(currency), currency))}`);
  const categories = report.categories.map(([category, amounts]) => {
    const primary = bold(amountText(amounts.get('EUR') || 0, 'EUR'));
    const additional = report.currencies.filter((currency) => currency !== 'EUR' && amounts.has(currency))
      .map((currency) => bold(amountText(amounts.get(currency), currency)));
    return `${escapeHtml(categoryButtonLabel(category))} — ${primary}${additional.length ? ` (${additional.join(' · ')})` : ''}`;
  });
  const summary = [heading, '', bold('💰 Всего'), ...totals,
    '', bold('🗂 По категориям'), ...categories].join('\n');
  const top = [bold('🏆 10 крупнейших транзакций'), ...report.top.map((transaction, index) => {
    const date = transaction.date.slice(0, 10);
    const readableDate = `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
    return `${bold(`${index + 1}.`)} ${bold(readableDate)} · ${bold(amountText(Math.round(transaction.amount * 100), transaction.currency))} · ${escapeHtml(transaction.category)}\n   ${escapeHtml(transaction.description)}`;
  })].join('\n\n');
  return { summary, top };
}

module.exports = {
  loadTransactions, availableYears, availableMonths, monthlyStatistics,
  formatMonthlyStatistics, parseReportDate, categoryExpenses, formatCategoryExpenses, MONTH_NAMES,
};

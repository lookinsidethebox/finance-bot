const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { CATEGORIES } = require('../constants/categories');

const DEFAULT_FILE = path.join(__dirname, '../../data/transactions.json');
const DEFAULT_RULES_FILE = path.join(__dirname, '../../data/category-rules.json');
const DEFAULT_EXCLUSIONS_FILE = path.join(__dirname, '../../data/exclusion-rules.json');
const DEFAULT_CATEGORIES_FILE = path.join(__dirname, '../../data/custom-categories.json');
const DEFAULT_SETTINGS_FILE = path.join(__dirname, '../../data/settings.json');
const DEFAULT_CURRENCY = 'EUR';
const CURRENCIES = Object.freeze([
  { code: 'EUR', name: 'Евро' },
  { code: 'USD', name: 'Доллары' },
  { code: 'RUB', name: 'Рубли' },
  { code: 'TRY', name: 'Турецкие лиры' },
  { code: 'RSD', name: 'Сербские динары' },
]);
let writeQueue = Promise.resolve();
class CategoryNameError extends Error {}
class CurrencyCodeError extends Error {}

function enqueue(work) {
  const task = writeQueue.then(work);
  writeQueue = task.catch(() => {});
  return task;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readSettings(file) {
  const settings = await readJson(file, { cashCurrency: DEFAULT_CURRENCY, customCurrencies: [] });
  if (!settings || !Array.isArray(settings.customCurrencies)
    || typeof settings.cashCurrency !== 'string') {
    throw new Error('Некорректный файл настроек.');
  }
  return settings;
}

function validOwner(owner) {
  return Number.isSafeInteger(owner) && owner > 0;
}

async function listCurrencies({ settingsFile = DEFAULT_SETTINGS_FILE } = {}) {
  const settings = await readSettings(settingsFile);
  return [...CURRENCIES, ...settings.customCurrencies.map((code) => ({ code, name: code }))];
}

async function getCashCurrency({ settingsFile = DEFAULT_SETTINGS_FILE } = {}) {
  return (await readSettings(settingsFile)).cashCurrency;
}

function setCashCurrency(code, { settingsFile = DEFAULT_SETTINGS_FILE } = {}) {
  return enqueue(async () => {
    const settings = await readSettings(settingsFile);
    const available = [...CURRENCIES.map((currency) => currency.code), ...settings.customCurrencies];
    if (!available.includes(code)) throw new CurrencyCodeError('Неизвестная валюта.');
    settings.cashCurrency = code;
    await writeJson(settingsFile, settings);
    return code;
  });
}

function addCustomCurrency(input, { settingsFile = DEFAULT_SETTINGS_FILE } = {}) {
  const code = String(input || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new CurrencyCodeError('Напишите код валюты из трёх латинских букв, например GBP.');
  }
  return enqueue(async () => {
    const settings = await readSettings(settingsFile);
    const added = !CURRENCIES.some((currency) => currency.code === code)
      && !settings.customCurrencies.includes(code);
    if (added) settings.customCurrencies.push(code);
    settings.cashCurrency = code;
    await writeJson(settingsFile, settings);
    return { code, added };
  });
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryFile, file);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

async function listCategories({ categoriesFile = DEFAULT_CATEGORIES_FILE } = {}) {
  const stored = await readJson(categoriesFile, { categories: [] });
  if (!Array.isArray(stored.categories)) throw new Error('Некорректный файл категорий.');
  return [...CATEGORIES, ...stored.categories];
}

function normalizeCategoryName(name) {
  const clean = String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 40) {
    throw new CategoryNameError('Название категории должно содержать от 2 до 40 символов.');
  }
  return clean[0].toLocaleUpperCase('ru-RU') + clean.slice(1);
}

function addCategory(name, { categoriesFile = DEFAULT_CATEGORIES_FILE } = {}) {
  const category = normalizeCategoryName(name);
  return enqueue(async () => {
    const stored = await readJson(categoriesFile, { categories: [] });
    if (!Array.isArray(stored.categories)) throw new Error('Некорректный файл категорий.');
    const existing = [...CATEGORIES, ...stored.categories].find((value) =>
      value.toLocaleLowerCase('ru-RU') === category.toLocaleLowerCase('ru-RU'));
    if (existing) return { category: existing, added: false };
    stored.categories.push(category);
    await writeJson(categoriesFile, stored);
    return { category, added: true };
  });
}

function addCashExpense(amount, category, {
  file = DEFAULT_FILE,
  categoriesFile = DEFAULT_CATEGORIES_FILE,
  settingsFile = DEFAULT_SETTINGS_FILE,
  owner,
  now = () => new Date(),
} = {}) {
  return enqueue(async () => {
    if (!validOwner(owner)) throw new Error('Некорректный Telegram ID владельца траты.');
    if (!Number.isFinite(amount) || amount <= 0
      || !Number.isSafeInteger(Math.round(amount * 100))
      || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
      throw new Error('Некорректная сумма наличной траты.');
    }
    if (!(await listCategories({ categoriesFile })).includes(category)) {
      throw new Error('Неизвестная категория.');
    }
    const stored = await readJson(file, { transactions: [] });
    if (!Array.isArray(stored.transactions)) throw new Error('Некорректный файл транзакций.');
    const currency = await getCashCurrency({ settingsFile });
    const transaction = {
      date: now().toISOString(),
      amount,
      currency,
      description: 'Наличные траты',
      category,
      owner,
    };
    stored.transactions.push(transaction);
    await writeJson(file, stored);
    return transaction;
  });
}

function descriptionKey(description) {
  const normalized = description.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^spotify(?:\*|\b)/.test(normalized)) return 'spotify';
  return normalized
    .replace(/\*([a-z0-9]{6,})$/, (suffix, code) => /\d/.test(code) ? '' : suffix)
    .replace(/\s([a-z0-9]{6,})$/, (suffix, code) =>
      (code.match(/\d/g) || []).length >= 3 ? '' : suffix)
    .trim();
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function learnedCategory(rules, description) {
  const key = descriptionKey(description);
  if (Object.hasOwn(rules, key)) return rules[key];
  if (key.length < 8) return null;
  const close = Object.entries(rules)
    .filter(([known]) => known.length >= 8 && known.slice(0, 5) === key.slice(0, 5)
      && editDistance(known, key) <= 2)
    .map(([, category]) => category);
  return new Set(close).size === 1 ? close[0] : null;
}

function transactionKey(transaction) {
  return JSON.stringify([
    transaction.owner, transaction.date, transaction.amount,
    transaction.currency, transaction.description,
  ]);
}

function processStatement(bank, transactions, {
  file = DEFAULT_FILE,
  rulesFile = DEFAULT_RULES_FILE,
  exclusionsFile = DEFAULT_EXCLUSIONS_FILE,
  owner,
} = {}) {
  return enqueue(async () => {
    if (!validOwner(owner)) throw new Error('Некорректный Telegram ID владельца траты.');
    const stored = await readJson(file, { transactions: [] });
    const allRules = await readJson(rulesFile, {});
    const allExclusions = await readJson(exclusionsFile, {});
    if (!Array.isArray(stored.transactions) || typeof allRules !== 'object' || !allRules) {
      throw new Error('Некорректный файл данных.');
    }
    if (typeof allExclusions !== 'object' || !allExclusions
      || (allExclusions[bank] !== undefined && !Array.isArray(allExclusions[bank]))) {
      throw new Error('Некорректный файл исключений.');
    }
    const rules = allRules[bank] || {};
    const exclusions = new Set(allExclusions[bank] || []);
    const available = new Map();
    stored.transactions.forEach((transaction, index) => {
      const key = transactionKey(transaction);
      if (!available.has(key)) available.set(key, []);
      available.get(key).push(index);
    });

    let pending = null;
    let added = 0;
    let skippedExcluded = 0;
    let changed = false;
    for (const transaction of transactions) {
      if (exclusions.has(descriptionKey(transaction.description))) {
        skippedExcluded++;
        continue;
      }
      const ownedTransaction = { ...transaction, owner };
      const existingIndex = available.get(transactionKey(ownedTransaction))?.shift();
      const category = learnedCategory(rules, transaction.description);
      if (existingIndex !== undefined) {
        const existing = stored.transactions[existingIndex];
        if (category !== null && existing.category === 'Прочее' && category !== 'Прочее') {
          existing.category = category;
          changed = true;
        } else if (category === null && existing.category === 'Прочее' && !pending) {
          pending = transaction;
        }
      } else if (category !== null) {
        stored.transactions.push({ ...transaction, category, owner });
        added++;
        changed = true;
      } else if (!pending) {
        pending = transaction;
      }
    }

    if (changed) await writeJson(file, stored);
    return { pending, added, total: transactions.length, skippedExcluded };
  });
}

function excludeDescription(bank, description, {
  exclusionsFile = DEFAULT_EXCLUSIONS_FILE,
} = {}) {
  return enqueue(async () => {
    const allExclusions = await readJson(exclusionsFile, {});
    if (typeof allExclusions !== 'object' || !allExclusions
      || (allExclusions[bank] !== undefined && !Array.isArray(allExclusions[bank]))) {
      throw new Error('Некорректный файл исключений.');
    }
    const key = descriptionKey(description);
    if (!key) throw new Error('Пустое описание операции.');
    const exclusions = allExclusions[bank] || [];
    if (exclusions.includes(key)) return false;
    allExclusions[bank] = [...exclusions, key];
    await writeJson(exclusionsFile, allExclusions);
    return true;
  });
}

function learnCategory(bank, description, category, {
  rulesFile = DEFAULT_RULES_FILE,
  categoriesFile = DEFAULT_CATEGORIES_FILE,
} = {}) {
  return enqueue(async () => {
    if (!(await listCategories({ categoriesFile })).includes(category)) {
      throw new Error('Неизвестная категория.');
    }
    const allRules = await readJson(rulesFile, {});
    if (typeof allRules !== 'object' || !allRules) throw new Error('Некорректный файл правил.');
    allRules[bank] = { ...allRules[bank], [descriptionKey(description)]: category };
    await writeJson(rulesFile, allRules);
  });
}

module.exports = {
  processStatement, learnCategory, excludeDescription, descriptionKey,
  listCategories, addCategory, addCashExpense, CategoryNameError,
  CURRENCIES, listCurrencies, getCashCurrency, setCashCurrency,
  addCustomCurrency, CurrencyCodeError,
};

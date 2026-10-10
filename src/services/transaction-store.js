const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { CATEGORIES } = require('../constants/categories');

const DEFAULT_FILE = path.join(__dirname, '../../data/transactions.json');
const DEFAULT_RECEIPTS_FILE = path.join(__dirname, '../../data/app-store-receipts.json');
const DEFAULT_RULES_FILE = path.join(__dirname, '../../data/category-rules.json');
const DEFAULT_EXCLUSIONS_FILE = path.join(__dirname, '../../data/exclusion-rules.json');
const DEFAULT_CATEGORIES_FILE = path.join(__dirname, '../../data/custom-categories.json');
const DEFAULT_SETTINGS_FILE = path.join(__dirname, '../../data/settings.json');
const DEFAULT_CURRENCY = 'EUR';
const APPLE_BILL_DESCRIPTION = 'APPLE.COM/BILL';
const APPLE_BILL_WINDOW_DAYS = 3;
const APP_STORE_PREFIX = 'App Store: ';
const APP_STORE_CATEGORY = 'Подписки';
const APP_STORE_CATEGORIES = Object.freeze(['Подписки', 'Игры']);
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
class AppStoreInputError extends Error {}

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
  return [...new Set([...CATEGORIES, ...stored.categories])];
}

function normalizeCategoryName(name) {
  const clean = String(name || '').normalize('NFKC').replace(/^ +| +$/g, '').replace(/ +/g, ' ');
  if (clean.length < 2 || clean.length > 40) {
    throw new CategoryNameError('Название категории должно содержать от 2 до 40 символов.');
  }
  if (!/^[\p{L} -]+$/u.test(clean)) {
    throw new CategoryNameError('В названии категории разрешены только буквы, дефис и пробел.');
  }
  const firstLetter = /\p{L}/u.exec(clean);
  if (!firstLetter) throw new CategoryNameError('Название категории должно содержать букву.');
  const index = firstLetter.index;
  return clean.slice(0, index) + firstLetter[0].toLocaleUpperCase('ru-RU')
    + clean.slice(index + firstLetter[0].length);
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

function parseAppStoreItems(input) {
  const lines = String(input || '').split(/\r?\n/);
  const items = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(.+?)\s+[–—-]\s+\$(\d+(?:[.,]\d{1,2})?)$/.exec(line);
    if (!match || !match[1].trim() || match[1].trim().length > 120) {
      throw new AppStoreInputError(`Строка ${index + 1}: напишите «Приложение – $0» и замените 0 на сумму.`);
    }
    const [whole, fraction = ''] = match[2].replace(',', '.').split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      throw new AppStoreInputError(`Строка ${index + 1}: сумма должна быть больше нуля.`);
    }
    items.push({ name: match[1].trim(), amount: cents / 100 });
  }
  if (!items.length) throw new AppStoreInputError('Пришлите хотя бы одно приложение с суммой.');
  return items;
}

async function appStoreCategories(items, { rulesFile = DEFAULT_RULES_FILE } = {}) {
  const allRules = await readJson(rulesFile, {});
  if (!allRules || typeof allRules !== 'object' || Array.isArray(allRules)
    || (allRules.appStore !== undefined && (!allRules.appStore
      || typeof allRules.appStore !== 'object' || Array.isArray(allRules.appStore)))) {
    throw new Error('Некорректный файл правил.');
  }
  return items.map(({ name }) => {
    const category = allRules.appStore?.[descriptionKey(name)];
    return APP_STORE_CATEGORIES.includes(category) ? category : null;
  });
}

function matchesAppStoreReceipt(receipt, charge) {
  if (charge.owner !== receipt.owner || charge.currency !== 'USD'
    || charge.description !== APPLE_BILL_DESCRIPTION
    || Math.round(charge.amount * 100) !== Math.round(receipt.total * 100)) return false;
  const chargeDate = charge.date?.slice(0, 10);
  const lastDate = new Date(`${receipt.date}T00:00:00.000Z`);
  lastDate.setUTCDate(lastDate.getUTCDate() + APPLE_BILL_WINDOW_DAYS);
  return chargeDate >= receipt.date && chargeDate <= lastDate.toISOString().slice(0, 10);
}

function receiptItemsKey(items) {
  return JSON.stringify(items.map(({ name, amount }) => [name, Math.round(amount * 100)])
    .sort(([aName, aAmount], [bName, bAmount]) => aName.localeCompare(bName) || aAmount - bAmount));
}

function receiptKey(receipt) {
  if (!Array.isArray(receipt.items)) throw new Error('Некорректный чек App Store.');
  return JSON.stringify([receipt.owner, receipt.date, receiptItemsKey(receipt.items)]);
}

async function loadAppStoreData(file, receiptsFile) {
  const stored = await readJson(file, { transactions: [] });
  const separate = await readJson(receiptsFile, { receipts: [] });
  if (!stored || !Array.isArray(stored.transactions) || !separate
    || !Array.isArray(separate.receipts)
    || (stored.appStoreReceipts !== undefined && !Array.isArray(stored.appStoreReceipts))) {
    throw new Error('Некорректный файл данных.');
  }
  if (stored.appStoreReceipts !== undefined) {
    const known = new Set(separate.receipts.map(receiptKey));
    for (const receipt of stored.appStoreReceipts) {
      const key = receiptKey(receipt);
      if (!known.has(key)) {
        separate.receipts.push(receipt);
        known.add(key);
      }
    }
    // The separate file must be durable before removing the legacy field.
    await writeJson(receiptsFile, separate);
    delete stored.appStoreReceipts;
    await writeJson(file, stored);
  }
  return { stored, receipts: separate.receipts };
}

function migrateAppStoreReceipts({ file = DEFAULT_FILE,
  receiptsFile = path.join(path.dirname(file), path.basename(DEFAULT_RECEIPTS_FILE)) } = {}) {
  return enqueue(async () => (await loadAppStoreData(file, receiptsFile)).receipts.length);
}

function availableAppStoreReceipts(transactions, receipts) {
  const appItems = new Map();
  for (const transaction of transactions) {
    if (!transaction.description?.startsWith(APP_STORE_PREFIX)) continue;
    const key = transactionKey(transaction);
    appItems.set(key, (appItems.get(key) || 0) + 1);
  }
  const available = [];
  for (const receipt of receipts) {
    if (!Array.isArray(receipt.items)) throw new Error('Некорректный чек App Store.');
    const keys = receipt.items.map(({ name, amount }) => transactionKey({
      owner: receipt.owner, date: receipt.date, amount, currency: 'USD',
      description: `${APP_STORE_PREFIX}${name}`,
    }));
    const needed = new Map();
    for (const key of keys) needed.set(key, (needed.get(key) || 0) + 1);
    if ([...needed].some(([key, count]) => (appItems.get(key) || 0) < count)) continue;
    for (const [key, count] of needed) appItems.set(key, appItems.get(key) - count);
    available.push(receipt);
  }
  return available;
}

function missingAppStoreTransactions(transactions, receipts, currentReceipt) {
  const expected = new Map();
  const existing = new Map();
  const toTransaction = ({ name, amount, category }, receipt) => ({
    date: receipt.date, amount, currency: 'USD',
    description: `${APP_STORE_PREFIX}${name}`, category: category || APP_STORE_CATEGORY,
    owner: receipt.owner,
  });
  for (const receipt of receipts) {
    for (const item of receipt.items) {
      const key = transactionKey(toTransaction(item, receipt));
      expected.set(key, (expected.get(key) || 0) + 1);
    }
  }
  for (const transaction of transactions) {
    const key = transactionKey(transaction);
    existing.set(key, (existing.get(key) || 0) + 1);
  }
  const missing = [];
  for (const item of currentReceipt.items) {
    const transaction = toTransaction(item, currentReceipt);
    const key = transactionKey(transaction);
    if ((existing.get(key) || 0) < expected.get(key)) {
      missing.push(transaction);
      existing.set(key, (existing.get(key) || 0) + 1);
    }
  }
  return missing;
}

function saveAppStoreReceipt(date, items, {
  file = DEFAULT_FILE,
  receiptsFile = path.join(path.dirname(file), path.basename(DEFAULT_RECEIPTS_FILE)),
  rulesFile = DEFAULT_RULES_FILE,
  owner,
} = {}) {
  return enqueue(async () => {
    if (!validOwner(owner)) throw new Error('Некорректный Telegram ID владельца траты.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw new AppStoreInputError('Некорректная дата чека.');
    }
    if (!Array.isArray(items) || !items.length || items.some(({ name, amount }) =>
      typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(Math.round(amount * 100))
      || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8)) {
      throw new AppStoreInputError('Некорректные позиции чека.');
    }
    const totalCents = items.reduce((sum, { amount }) => sum + Math.round(amount * 100), 0);
    if (!Number.isSafeInteger(totalCents)) throw new AppStoreInputError('Слишком большая сумма чека.');
    const { stored, receipts } = await loadAppStoreData(file, receiptsFile);
    const allRules = await readJson(rulesFile, {});
    if (!allRules || typeof allRules !== 'object' || Array.isArray(allRules)
      || (allRules.appStore !== undefined && (!allRules.appStore
        || typeof allRules.appStore !== 'object' || Array.isArray(allRules.appStore)))) {
      throw new Error('Некорректный файл данных.');
    }
    const rules = { ...allRules.appStore };
    if (items.some(({ category }) => category !== undefined
      && !APP_STORE_CATEGORIES.includes(category))) {
      throw new AppStoreInputError('Выберите для приложения категорию «Подписки» или «Игры».');
    }
    const categorizedItems = items.map((item) => {
      const known = rules[descriptionKey(item.name)];
      return { ...item, category: item.category
        || (APP_STORE_CATEGORIES.includes(known) ? known : APP_STORE_CATEGORY) };
    });
    const duplicate = receipts.some((receipt) => receipt.owner === owner && receipt.date === date
      && receiptItemsKey(receipt.items) === receiptItemsKey(items));
    const billIndex = stored.transactions.findIndex((transaction) =>
      matchesAppStoreReceipt({ date, owner, total: totalCents / 100 }, transaction));
    const removedApple = billIndex !== -1 ? 1 : 0;
    if (removedApple) stored.transactions.splice(billIndex, 1);
    if (!duplicate) {
      receipts.push({ date, owner, total: totalCents / 100, items: categorizedItems });
      await writeJson(receiptsFile, { receipts });
    }
    const missing = missingAppStoreTransactions(stored.transactions, receipts,
      { date, owner, items: categorizedItems });
    stored.transactions.push(...missing);
    let rulesChanged = false;
    for (const { name, category } of categorizedItems) {
      const key = descriptionKey(name);
      if (rules[key] !== category) {
        rules[key] = category;
        rulesChanged = true;
      }
    }
    if (rulesChanged) {
      allRules.appStore = rules;
      await writeJson(rulesFile, allRules);
    }
    if (missing.length || removedApple) await writeJson(file, stored);
    return { added: duplicate ? 0 : items.length, removedApple, duplicate,
      total: totalCents / 100 };
  });
}

function processStatement(bank, transactions, {
  file = DEFAULT_FILE,
  receiptsFile = path.join(path.dirname(file), path.basename(DEFAULT_RECEIPTS_FILE)),
  rulesFile = DEFAULT_RULES_FILE,
  exclusionsFile = DEFAULT_EXCLUSIONS_FILE,
  owner,
} = {}) {
  return enqueue(async () => {
    if (!validOwner(owner)) throw new Error('Некорректный Telegram ID владельца траты.');
    const { stored, receipts } = await loadAppStoreData(file, receiptsFile);
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
    const availableReceipts = bank === 'payoneer'
      ? availableAppStoreReceipts(stored.transactions, receipts) : [];
    stored.transactions.forEach((transaction, index) => {
      const key = transactionKey(transaction);
      if (!available.has(key)) available.set(key, []);
      available.get(key).push(index);
    });

    let pending = null;
    let added = 0;
    let skippedExcluded = 0;
    let skippedAppStore = 0;
    let changed = false;
    for (const transaction of transactions) {
      if (exclusions.has(descriptionKey(transaction.description))) {
        skippedExcluded++;
        continue;
      }
      const ownedTransaction = { ...transaction, owner };
      const existingIndex = available.get(transactionKey(ownedTransaction))?.shift();
      if (existingIndex === undefined && bank === 'payoneer'
        && transaction.description === APPLE_BILL_DESCRIPTION && transaction.currency === 'USD') {
        const receiptIndex = availableReceipts.findIndex((receipt) =>
          matchesAppStoreReceipt(receipt, ownedTransaction));
        if (receiptIndex !== -1) {
          availableReceipts.splice(receiptIndex, 1);
          skippedAppStore++;
          continue;
        }
      }
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
    return { pending, added, total: transactions.length, skippedExcluded, skippedAppStore };
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
  parseAppStoreItems, appStoreCategories, saveAppStoreReceipt, AppStoreInputError,
  migrateAppStoreReceipts,
};

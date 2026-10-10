const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { CATEGORIES } = require('../constants/categories');

const DEFAULT_FILE = path.join(__dirname, '../../data/transactions.json');
const DEFAULT_RULES_FILE = path.join(__dirname, '../../data/category-rules.json');
const DEFAULT_CATEGORIES_FILE = path.join(__dirname, '../../data/custom-categories.json');
let writeQueue = Promise.resolve();
class CategoryNameError extends Error {}

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
    transaction.date, transaction.amount, transaction.currency, transaction.description,
  ]);
}

function processStatement(bank, transactions, {
  file = DEFAULT_FILE,
  rulesFile = DEFAULT_RULES_FILE,
} = {}) {
  return enqueue(async () => {
    const stored = await readJson(file, { transactions: [] });
    const allRules = await readJson(rulesFile, {});
    if (!Array.isArray(stored.transactions) || typeof allRules !== 'object' || !allRules) {
      throw new Error('Некорректный файл данных.');
    }
    const rules = allRules[bank] || {};
    const available = new Map();
    stored.transactions.forEach((transaction, index) => {
      const key = transactionKey(transaction);
      if (!available.has(key)) available.set(key, []);
      available.get(key).push(index);
    });

    let pending = null;
    let added = 0;
    let changed = false;
    for (const transaction of transactions) {
      const existingIndex = available.get(transactionKey(transaction))?.shift();
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
        stored.transactions.push({ ...transaction, category });
        added++;
        changed = true;
      } else if (!pending) {
        pending = transaction;
      }
    }

    if (changed) await writeJson(file, stored);
    return { pending, added, total: transactions.length };
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
  processStatement, learnCategory, descriptionKey,
  listCategories, addCategory, CategoryNameError,
};

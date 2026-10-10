function loadConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  const ownerIdsValue = env.OWNER_IDS?.trim();

  if (!token) throw new Error('BOT_TOKEN is missing. Add it to .env.');
  if (!ownerIdsValue) throw new Error('OWNER_IDS is missing. Add it to .env.');

  const ownerIds = ownerIdsValue.split(',').map((id) => id.trim());
  if (ownerIds.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    || new Set(ownerIds).size !== ownerIds.length) {
    throw new Error('OWNER_IDS must contain unique, positive numeric Telegram user IDs separated by commas.');
  }

  return { token, ownerIds };
}

module.exports = { loadConfig };

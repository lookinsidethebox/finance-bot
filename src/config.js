function loadConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  const ownerId = env.OWNER_ID?.trim();

  if (!token) throw new Error('BOT_TOKEN is missing. Add it to .env.');
  if (!ownerId) throw new Error('OWNER_ID is missing. Add it to .env.');
  if (!/^[1-9]\d*$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId))) {
    throw new Error('OWNER_ID must be a positive numeric Telegram user ID.');
  }

  return { token, ownerId };
}

module.exports = { loadConfig };

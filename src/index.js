require('dotenv').config();
const { createBot } = require('./bot');
const { loadConfig } = require('./config');

async function main() {
  const bot = createBot(loadConfig());
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  await bot.launch({ allowedUpdates: ['message', 'callback_query'] }, () => {
    console.log('Connected to Telegram.');
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Bot stopped with an error:', error);
    process.exitCode = 1;
  });
}

module.exports = { main };

require('dotenv').config();
const { createBot } = require('./bot');
const { loadConfig } = require('./config');
const { createMonthlyReminder } = require('./services/monthly-reminder.service');

async function main() {
  const config = loadConfig();
  const bot = createBot(config);
  const reminder = createMonthlyReminder({ telegram: bot.telegram, ownerIds: config.ownerIds });
  process.once('SIGINT', () => { reminder.stop(); bot.stop('SIGINT'); });
  process.once('SIGTERM', () => { reminder.stop(); bot.stop('SIGTERM'); });
  await bot.launch({ allowedUpdates: ['message', 'callback_query'] }, () => {
    console.log('Connected to Telegram.');
    reminder.start();
    console.log('Monthly reminders scheduled for 12:00 Europe/Podgorica.');
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Bot stopped with an error:', error);
    process.exitCode = 1;
  });
}

module.exports = { main };

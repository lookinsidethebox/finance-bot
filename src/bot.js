const { Telegraf } = require('telegraf');
const { registerMessageController } = require('./controllers/message.controller');
const { createOwnerOnlyMiddleware } = require('./middleware/owner-only.middleware');

function createBot({ token, ownerId }, services) {
  const bot = new Telegraf(token);
  bot.use(createOwnerOnlyMiddleware(ownerId));
  registerMessageController(bot, services);
  return bot;
}

module.exports = { createBot };

const fs = require('node:fs/promises');
const path = require('node:path');

const TIME_ZONE = 'Europe/Podgorica';
const REMINDER_TEXT = '🎉️️️️️️ Наступил новый месяц! Не забудь внести в бота выписку из банка.';
const DEFAULT_FILE = path.join(process.cwd(), 'data', 'monthly-reminders.json');
const localFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  hourCycle: 'h23',
});

function localTime(date) {
  const parts = Object.fromEntries(localFormatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour };
}

async function readState(file) {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!state || !state.lastSentByOwner || typeof state.lastSentByOwner !== 'object'
      || Array.isArray(state.lastSentByOwner)) {
      throw new Error('Invalid monthly reminder state');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { lastSentByOwner: {} };
    throw error;
  }
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function createMonthlyReminder({
  telegram, ownerIds, file = DEFAULT_FILE, now = () => new Date(),
  onError = (error) => console.error('Monthly reminder failed:', error),
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let active = false;
  let running = false;
  let timer;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const { year, month, day, hour } = localTime(now());
      if (day !== 1 || hour < 12) return;

      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      const state = await readState(file);
      for (const ownerId of ownerIds) {
        if (state.lastSentByOwner[ownerId] === monthKey) continue;
        try {
          await telegram.sendMessage(ownerId, REMINDER_TEXT);
          state.lastSentByOwner[ownerId] = monthKey;
          await writeState(file, state);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (!active) return;
    const date = now();
    const millisecondsIntoMinute = date.getUTCSeconds() * 1000 + date.getUTCMilliseconds();
    timer = setTimer(async () => {
      try {
        await tick();
      } catch (error) {
        onError(error);
      }
      schedule();
    }, 60_000 - millisecondsIntoMinute);
  }

  function start() {
    if (active) return;
    active = true;
    tick().catch(onError);
    schedule();
  }

  function stop() {
    active = false;
    if (timer) clearTimer(timer);
    timer = undefined;
  }

  return { start, stop, tick };
}

module.exports = { createMonthlyReminder, localTime, REMINDER_TEXT, TIME_ZONE };

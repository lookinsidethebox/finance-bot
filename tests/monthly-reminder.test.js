const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMonthlyReminder, localTime, REMINDER_TEXT } = require('../src/services/monthly-reminder.service');

test('sends at noon in Podgorica in winter and summer, once per owner and month', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-reminder-'));
  try {
    const file = path.join(directory, 'monthly-reminders.json');
    const sent = [];
    let current = new Date('2027-01-01T10:59:59Z');
    const options = {
      telegram: { sendMessage: async (...args) => { sent.push(args); } },
      ownerIds: ['123', '456'], file, now: () => current,
    };
    assert.deepEqual(localTime(new Date('2027-01-01T11:00:00Z')),
      { year: 2027, month: 1, day: 1, hour: 12 });
    assert.deepEqual(localTime(new Date('2027-07-01T10:00:00Z')),
      { year: 2027, month: 7, day: 1, hour: 12 });
    const reminder = createMonthlyReminder(options);
    await reminder.tick();
    assert.deepEqual(sent, []);

    current = new Date('2027-01-01T11:00:00Z');
    await reminder.tick();
    assert.deepEqual(sent, [['123', REMINDER_TEXT], ['456', REMINDER_TEXT]]);
    await createMonthlyReminder(options).tick();
    assert.equal(sent.length, 2);

    current = new Date('2027-01-02T11:00:00Z');
    await reminder.tick();
    assert.equal(sent.length, 2);

    current = new Date('2027-07-01T09:59:59Z');
    await reminder.tick();
    assert.equal(sent.length, 2);
    current = new Date('2027-07-01T10:00:00Z');
    await reminder.tick();
    assert.equal(sent.length, 4);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).lastSentByOwner,
      { 123: '2027-07', 456: '2027-07' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retries a failed owner without resending to owners already notified', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-reminder-'));
  try {
    const sent = [];
    const errors = [];
    let failSecondOwner = true;
    const reminder = createMonthlyReminder({
      telegram: {
        sendMessage: async (id, text) => {
          if (id === '456' && failSecondOwner) throw new Error('Temporary Telegram error');
          sent.push([id, text]);
        },
      },
      ownerIds: ['123', '456'],
      file: path.join(directory, 'monthly-reminders.json'),
      now: () => new Date('2027-01-01T18:00:00Z'),
      onError: (error) => errors.push(error.message),
    });
    await reminder.tick();
    assert.deepEqual(sent, [['123', REMINDER_TEXT]]);
    assert.deepEqual(errors, ['Temporary Telegram error']);
    failSecondOwner = false;
    await reminder.tick();
    assert.deepEqual(sent, [['123', REMINDER_TEXT], ['456', REMINDER_TEXT]]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

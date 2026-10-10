const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../src/config');

test('loads and trims the required environment variables', () => {
  const env = { BOT_TOKEN: ' test-token ', OWNER_ID: ' 123 ' };
  assert.deepEqual(loadConfig(env), { token: 'test-token', ownerId: '123' });
  assert.equal(env.OWNER_ID, ' 123 ');
});

test('rejects missing credentials and invalid owner IDs', () => {
  const valid = { BOT_TOKEN: 'test-token', OWNER_ID: '123' };
  for (const name of Object.keys(valid)) {
    for (const value of [undefined, '', '  ']) {
      assert.throws(() => loadConfig({ ...valid, [name]: value }), new RegExp(name));
    }
  }
  for (const ownerId of ['@name', '0', '-1', '1.5', '9007199254740992']) {
    assert.throws(() => loadConfig({ ...valid, OWNER_ID: ownerId }), /OWNER_ID/);
  }
});

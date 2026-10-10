const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../src/config');

test('loads and trims the required environment variables', () => {
  const env = { BOT_TOKEN: ' test-token ', OWNER_IDS: ' 123, 456 ' };
  assert.deepEqual(loadConfig(env), { token: 'test-token', ownerIds: ['123', '456'] });
  assert.equal(env.OWNER_IDS, ' 123, 456 ');
});

test('rejects missing credentials and invalid owner IDs', () => {
  const valid = { BOT_TOKEN: 'test-token', OWNER_IDS: '123' };
  for (const name of Object.keys(valid)) {
    for (const value of [undefined, '', '  ']) {
      assert.throws(() => loadConfig({ ...valid, [name]: value }), new RegExp(name));
    }
  }
  for (const ownerIds of ['@name', '0', '-1', '1.5', '9007199254740992',
    '123,', ',123', '123,,456', '123,@name', '123,123']) {
    assert.throws(() => loadConfig({ ...valid, OWNER_IDS: ownerIds }), /OWNER_IDS/);
  }
  assert.throws(() => loadConfig({ BOT_TOKEN: 'test-token', OWNER_ID: '123' }), /OWNER_IDS/);
});

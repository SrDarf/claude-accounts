const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { freshHome } = require('./helpers.js');

function load() {
  for (const m of ['usage', 'paths', 'fsutil', 'lock', 'log', 'audit']) {
    delete require.cache[require.resolve(`../src/${m}.js`)];
  }
  return { usage: require('../src/usage.js'), p: require('../src/paths.js') };
}

test('persist hardens refreshed LIVE creds to 0o600 and preserves other keys', { skip: process.platform === 'win32' }, () => {
  freshHome({ accounts: true });
  const { usage, p } = load();
  usage.persist('work', 'work', { other: 1 }, { accessToken: 'A', refreshToken: 'R' });
  assert.strictEqual(fs.statSync(p.liveCreds()).mode & 0o777, 0o600);
  const j = JSON.parse(fs.readFileSync(p.liveCreds(), 'utf8'));
  assert.strictEqual(j.other, 1);
  assert.strictEqual(j.claudeAiOauth.accessToken, 'A');
});

test('persist hardens refreshed SLOT creds to 0o600', { skip: process.platform === 'win32' }, () => {
  freshHome({ accounts: true });
  const { usage, p } = load();
  usage.persist('home', 'work', {}, { accessToken: 'B' }); // non-current -> slot
  assert.strictEqual(fs.statSync(p.slotCreds('home')).mode & 0o777, 0o600);
});

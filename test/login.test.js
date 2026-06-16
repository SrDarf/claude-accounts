const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setup() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'login-home-'));
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  fs.mkdirSync(path.join(h, '.claude', '.accounts'), { recursive: true });
  for (const m of ['vault', 'login', 'paths', 'fsutil']) {
    delete require.cache[require.resolve(`../src/${m}.js`)];
  }
  return h;
}

test('addAccount captures creds written by the spawned login', async () => {
  setup();
  const { addAccount } = require('../src/login.js');
  const fakeSpawn = (cfgDir) => {
    fs.writeFileSync(path.join(cfgDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"NEW"}}');
    fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@x.com' } }));
    return { status: 0 };
  };
  const r = await addAccount('newacct', { spawnFn: fakeSpawn });
  assert.strictEqual(r.added, true);
  const vault = require('../src/vault.js');
  assert.ok(vault.list().includes('newacct'));
  assert.strictEqual(vault.readSlot('newacct').oauthAccount.emailAddress, 'new@x.com');
});

test('addAccount rejects when no creds produced', async () => {
  setup();
  const { addAccount } = require('../src/login.js');
  const r = await addAccount('aborted', { spawnFn: () => ({ status: 1 }) });
  assert.strictEqual(r.added, false);
  const vault = require('../src/vault.js');
  assert.ok(!vault.list().includes('aborted'));
});

test('addAccount rejects duplicate name', async () => {
  setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('dup', { credentialsText: '{}', oauthAccount: {} });
  const { addAccount } = require('../src/login.js');
  await assert.rejects(() => addAccount('dup', { spawnFn: () => ({ status: 0 }) }), /dup/);
});

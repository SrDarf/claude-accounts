const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { freshHome } = require('./helpers.js');

function run(home, args) {
  return cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), ...args], {
    env: { ...process.env, CLAUDE_ACCOUNTS_HOME: home },
    encoding: 'utf8',
  });
}

test('list prints accounts; current prints marker', () => {
  const h = freshHome({ accounts: true });
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  delete require.cache[require.resolve('../src/vault.js')];
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.setCurrent('work');

  const list = run(h, ['list']);
  assert.strictEqual(list.status, 0);
  assert.match(list.stdout, /work/);
  const cur = run(h, ['current']);
  assert.match(cur.stdout, /work/);
});

test('switch <name> changes marker', () => {
  const h = freshHome({ accounts: true });
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  delete require.cache[require.resolve('../src/vault.js')];
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"t":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"t":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"t":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  const r = run(h, ['switch', 'home']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude', '.accounts', 'current'), 'utf8').trim(), 'home');
});

test('unknown subcommand exits non-zero', () => {
  const r = run(freshHome({ accounts: true }), ['bogus']);
  assert.notStrictEqual(r.status, 0);
});

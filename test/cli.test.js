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

test('remove of a nonexistent account reports not-found and exits 1', () => {
  const h = freshHome({ accounts: true });
  const r = run(h, ['remove', 'ghost']);
  assert.strictEqual(r.status, 1, 'must NOT report success for a no-op delete');
  assert.match(r.stdout + r.stderr, /no such account|ghost/);
});

test('switch reports the active email on stdout', () => {
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
  assert.match(r.stdout, /h@x\.com/);
});

test('doctor exits non-zero on an incomplete core; log shows the audit trail', () => {
  const h = freshHome({ accounts: true });
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  delete require.cache[require.resolve('../src/vault.js')];
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"t":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"t":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"t":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  const d = run(h, ['doctor']);
  assert.notStrictEqual(d.status, 0); // core files are not staged in the test home
  assert.match(d.stdout, /claude-accounts doctor/);

  run(h, ['switch', 'home']); // writes an audit record
  const lg = run(h, ['log']);
  assert.strictEqual(lg.status, 0);
  assert.match(lg.stdout, /switch/);
});

test('current reports a live-but-unregistered login on a fresh home (read-only)', () => {
  const h = freshHome({ accounts: true });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"X"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fresh@x.com' } }));
  const r = run(h, ['current']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /fresh@x\.com/);
  assert.ok(!fs.existsSync(path.join(h, '.claude', '.accounts', 'current')), 'current must not register a marker');
});

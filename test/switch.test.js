const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { freshHome } = require('./helpers.js');

const setup = () => freshHome({ accounts: true, bust: ['vault', 'switch', 'paths', 'fsutil'] });

test('switch loads target creds + oauth and updates marker', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ keep: 1, oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  const { switchAccount } = require('../src/switch.js');
  const r = switchAccount('home');
  assert.strictEqual(r.switched, true);
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude', '.credentials.json'), 'utf8'), '{"tok":"H"}');
  const live = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  assert.strictEqual(live.oauthAccount.emailAddress, 'h@x.com');
  assert.strictEqual(live.keep, 1);
  assert.strictEqual(vault.getCurrent(), 'home');
});

test('switch saves current login back before loading target', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"OLD"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"REFRESHED"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  require('../src/switch.js').switchAccount('home');
  assert.strictEqual(vault.readSlot('work').credentialsText, '{"tok":"REFRESHED"}');
});

test('switch to current is a no-op', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.setCurrent('work');
  const r = require('../src/switch.js').switchAccount('work');
  assert.strictEqual(r.switched, false);
  assert.strictEqual(r.reason, 'already-current');
});

test('switch to unknown account throws', () => {
  setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{}', oauthAccount: {} });
  assert.throws(() => require('../src/switch.js').switchAccount('ghost'), /ghost/);
});

test('switch preserves current slot oauth when live has none', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  // live = work creds but .claude.json has NO oauthAccount
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ other: 1 }));
  vault.setCurrent('work');

  require('../src/switch.js').switchAccount('home');
  // work slot must keep its original oauth, not be clobbered to {}
  assert.strictEqual(vault.readSlot('work').oauthAccount.emailAddress, 'w@x.com');
});

test('a failed switch rolls back to a consistent FROM state (no contamination)', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  const { switchAccount } = require('../src/switch.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  const orig = vault.injectOAuthIntoLive;
  vault.injectOAuthIntoLive = () => { throw new Error('boom'); };
  try {
    assert.throws(() => switchAccount('home'), /home/i);
  } finally {
    vault.injectOAuthIntoLive = orig;
  }
  // live creds rolled back to work, marker still work, work slot uncontaminated
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude', '.credentials.json'), 'utf8'), '{"tok":"W"}');
  assert.strictEqual(vault.getCurrent(), 'work');
  assert.strictEqual(vault.readSlot('work').credentialsText, '{"tok":"W"}');
});

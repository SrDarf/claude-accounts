const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { freshHome } = require('./helpers.js');

const setup = () => freshHome({ accounts: true, bust: ['vault', 'switch', 'login', 'paths', 'fsutil', 'lock'] });

function writeLive(h, creds, oauth) {
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), creds);
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify(oauth));
}

// --- path traversal / arbitrary deletion (the `remove ..` foot-gun) ---

test('removeAccount refuses path traversal and never deletes outside the vault', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  const victim = path.join(h, '.claude', 'projects');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'precious');

  for (const bad of ['..', '.', '../..', 'a/b', '../../etc']) {
    assert.throws(() => vault.removeAccount(bad), /invalid|nome|name/i, `should reject "${bad}"`);
  }
  assert.ok(fs.existsSync(path.join(h, '.claude')), '~/.claude survives');
  assert.strictEqual(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'precious');
});

test('removeAccount deletes only the named slot', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{}', oauthAccount: { emailAddress: 'h@x.com' } });
  const r = vault.removeAccount('work');
  assert.strictEqual(r.removed, true);
  assert.deepStrictEqual(vault.list(), ['home']);
});

// --- config loss: removing the active account must not strand the live login ---

test('removeAccount of the active account clears the marker so the live login is re-adopted', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'work@x.com' } });
  vault.setCurrent('work');
  writeLive(h, '{"tok":"W"}', { oauthAccount: { emailAddress: 'work@x.com' } });

  vault.removeAccount('work');
  assert.strictEqual(vault.getCurrent(), null, 'marker cleared after removing the active account');

  // the still-live login is recaptured, never lost
  assert.strictEqual(vault.adoptCurrent(), 'work');
  assert.match(vault.readSlot('work').credentialsText, /W/);
});

// --- config loss: a dangling/stale marker must never clobber an unsaved login ---

test('switch saves the live login by identity before overwriting, even with a dangling marker', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  const { switchAccount } = require('../src/switch.js');
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'home@x.com' } });
  vault.setCurrent('ghost'); // marker points at a slot that does not exist
  writeLive(h, '{"tok":"GHOST"}', { oauthAccount: { emailAddress: 'ghost@x.com' } });

  switchAccount('home');

  const ghostSlot = vault.list().find((n) => vault.readSlot(n).credentialsText.includes('GHOST'));
  assert.ok(ghostSlot, 'the live login was preserved into a slot before being overwritten');
  assert.strictEqual(vault.readSlot(ghostSlot).oauthAccount.emailAddress, 'ghost@x.com');
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude', '.credentials.json'), 'utf8'), '{"tok":"H"}');
  assert.strictEqual(vault.getCurrent(), 'home');
});

test('saveCurrentLogin keys off identity, so a stale marker cannot contaminate another slot', () => {
  // Simulate a crash mid-switch: live login is B, but the marker still says A.
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('A', { credentialsText: '{"tok":"A-SAVED"}', oauthAccount: { emailAddress: 'a@x.com' } });
  vault.writeSlot('B', { credentialsText: '{"tok":"B-SAVED"}', oauthAccount: { emailAddress: 'b@x.com' } });
  vault.setCurrent('A'); // stale
  writeLive(h, '{"tok":"B-LIVE"}', { oauthAccount: { emailAddress: 'b@x.com' } });

  assert.strictEqual(vault.saveCurrentLogin(), 'B', 'saved into the slot matching the live identity');
  assert.strictEqual(vault.readSlot('A').credentialsText, '{"tok":"A-SAVED"}', 'slot A not contaminated');
  assert.match(vault.readSlot('B').credentialsText, /B-LIVE/, 'slot B got the live creds');
});

// --- corrupt ~/.claude.json: never destroy it, never crash read paths ---

test('injectOAuthIntoLive refuses to overwrite a corrupt ~/.claude.json (no data loss)', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  const corrupt = '{ not json,,, ';
  fs.writeFileSync(path.join(h, '.claude.json'), corrupt);
  assert.throws(() => vault.injectOAuthIntoLive({ emailAddress: 'x@x.com' }), /JSON/i);
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'), corrupt, 'file left intact');
});

test('captureOAuthFromLive degrades to null on a corrupt ~/.claude.json instead of throwing', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  fs.writeFileSync(path.join(h, '.claude.json'), '{ broken ');
  assert.strictEqual(vault.captureOAuthFromLive(), null);
});

test('switch aborts before overwriting live creds when ~/.claude.json is corrupt', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  const { switchAccount } = require('../src/switch.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), '{ corrupt ');
  vault.setCurrent('work');

  assert.throws(() => switchAccount('home'), /JSON/i);
  assert.strictEqual(
    fs.readFileSync(path.join(h, '.claude', '.credentials.json'), 'utf8'),
    '{"tok":"W"}',
    'live creds untouched — no half-applied switch',
  );
  assert.strictEqual(vault.getCurrent(), 'work');
});

// --- the reserved-name collision (a slot named "current" == the marker file) ---

test('an account named "current" is rejected rather than corrupting the marker', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  // marker path and slotDir('current') are the same path; removing/creating it
  // must not be allowed to clobber the marker mechanism.
  assert.throws(() => vault.removeAccount('current'), /invalid|nome|name/i);
  assert.throws(() => vault.removeAccount('.lock'), /invalid|nome|name/i);
});

test('adopting an identity that derives to a reserved name avoids the marker collision', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  writeLive(h, '{"tok":"C"}', { oauthAccount: { emailAddress: 'current@x.com' } });
  const name = vault.adoptCurrent();
  assert.notStrictEqual(name, 'current', 'must not create a slot that shadows the marker file');
  assert.ok(vault.list().includes(name));
  assert.strictEqual(vault.getCurrent(), name, 'marker still readable as a plain file');
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { freshHome } = require('./helpers.js');

beforeEach(() => { delete require.cache[require.resolve('../src/vault.js')]; });

test('writeSlot then readSlot round-trips', () => {
  freshHome();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"claudeAiOauth":{"accessToken":"T"}}', oauthAccount: { emailAddress: 'w@x.com' } });
  const slot = vault.readSlot('work');
  assert.match(slot.credentialsText, /accessToken/);
  assert.strictEqual(slot.oauthAccount.emailAddress, 'w@x.com');
  assert.deepStrictEqual(vault.list(), ['work']);
});

test('marker get/set', () => {
  freshHome();
  const vault = require('../src/vault.js');
  assert.strictEqual(vault.getCurrent(), null);
  fs.mkdirSync(require('../src/paths.js').vaultDir(), { recursive: true });
  vault.setCurrent('work');
  assert.strictEqual(vault.getCurrent(), 'work');
});

test('injectOAuthIntoLive preserves other keys', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude.json'),
    JSON.stringify({ keep: 1, oauthAccount: { emailAddress: 'old@x.com' }, also: 'yes' }));
  const vault = require('../src/vault.js');
  vault.injectOAuthIntoLive({ emailAddress: 'new@x.com' });
  const j = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  assert.strictEqual(j.oauthAccount.emailAddress, 'new@x.com');
  assert.strictEqual(j.keep, 1);
  assert.strictEqual(j.also, 'yes');
});

test('captureOAuthFromLive reads live oauthAccount', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'cap@x.com' } }));
  const vault = require('../src/vault.js');
  assert.strictEqual(vault.captureOAuthFromLive().emailAddress, 'cap@x.com');
});

test('adoptCurrent seeds the vault from the live login when empty', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"LIVE"}}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'gabriela@gmail.com' } }));
  const vault = require('../src/vault.js');
  const name = vault.adoptCurrent();
  assert.strictEqual(name, 'gabriela');
  assert.strictEqual(vault.getCurrent(), 'gabriela');
  assert.match(vault.readSlot('gabriela').credentialsText, /LIVE/);
  assert.strictEqual(vault.readSlot('gabriela').oauthAccount.emailAddress, 'gabriela@gmail.com');
});

test('adoptCurrent is a no-op when a current account already exists', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"x":1}');
  const vault = require('../src/vault.js');
  fs.mkdirSync(require('../src/paths.js').vaultDir(), { recursive: true });
  vault.writeSlot('work', { credentialsText: '{}', oauthAccount: {} });
  vault.setCurrent('work');
  assert.strictEqual(vault.adoptCurrent(), null);
  assert.strictEqual(vault.getCurrent(), 'work');
});

test('adoptCurrent returns null when there is no live login', () => {
  freshHome();
  const vault = require('../src/vault.js');
  assert.strictEqual(vault.adoptCurrent(), null);
});

test('adoptCurrent falls back to "default" without an email', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"x":1}');
  const vault = require('../src/vault.js');
  assert.strictEqual(vault.adoptCurrent(), 'default');
});

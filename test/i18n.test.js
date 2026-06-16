const { test } = require('node:test');
const assert = require('node:assert');
const { t, norm, detectLocale } = require('../src/i18n.js');

test('norm maps locale-ish strings to pt/en or null', () => {
  assert.strictEqual(norm('pt-BR'), 'pt');
  assert.strictEqual(norm('PT'), 'pt');
  assert.strictEqual(norm('en-US'), 'en');
  assert.strictEqual(norm('English'), 'en');
  assert.strictEqual(norm('fr'), null);
  assert.strictEqual(norm(''), null);
});

test('detectLocale honors CLAUDE_ACCOUNTS_LANG', () => {
  const prev = process.env.CLAUDE_ACCOUNTS_LANG;
  process.env.CLAUDE_ACCOUNTS_LANG = 'pt-BR';
  assert.strictEqual(detectLocale(), 'pt');
  process.env.CLAUDE_ACCOUNTS_LANG = 'en';
  assert.strictEqual(detectLocale(), 'en');
  if (prev === undefined) delete process.env.CLAUDE_ACCOUNTS_LANG;
  else process.env.CLAUDE_ACCOUNTS_LANG = prev;
});

test('t returns localized strings and formats args', () => {
  const prev = process.env.CLAUDE_ACCOUNTS_LANG;
  process.env.CLAUDE_ACCOUNTS_LANG = 'pt';
  assert.strictEqual(t('activeNow', 'work'), 'Conta ativa: work');
  assert.strictEqual(t('menuActive'), 'ativa');
  process.env.CLAUDE_ACCOUNTS_LANG = 'en';
  assert.strictEqual(t('activeNow', 'work'), 'Active account: work');
  assert.strictEqual(t('menuActive'), 'active');
  if (prev === undefined) delete process.env.CLAUDE_ACCOUNTS_LANG;
  else process.env.CLAUDE_ACCOUNTS_LANG = prev;
});

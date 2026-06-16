const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { upsertBlock, normLang, CORE_FILES } = require('../install.js');

const START = '# >>> claude-accounts >>>';
const END = '# <<< claude-accounts <<<';

test('upsertBlock inserts when absent', () => {
  const out = upsertBlock('existing\n', 'NEW', START, END);
  assert.match(out, /existing/);
  assert.match(out, /NEW/);
  assert.ok(out.indexOf(START) < out.indexOf('NEW'));
});

test('upsertBlock replaces only its own block', () => {
  const initial = `keep-top\n${START}\nOLD\n${END}\nkeep-bottom\n`;
  const out = upsertBlock(initial, 'NEW', START, END);
  assert.match(out, /keep-top/);
  assert.match(out, /keep-bottom/);
  assert.match(out, /NEW/);
  assert.ok(!out.includes('OLD'));
  // exactly one block
  assert.strictEqual(out.split(START).length - 1, 1);
});

test('CORE_FILES covers every src/*.js module', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const onDisk = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  const listed = CORE_FILES.filter((f) => f.startsWith('src/')).map((f) => f.slice(4)).sort();
  assert.deepStrictEqual(listed, onDisk, 'installer CORE_FILES must list all src modules');
});

test('normLang accepts pt/en variants, rejects others', () => {
  assert.strictEqual(normLang('pt-BR'), 'pt');
  assert.strictEqual(normLang('PT'), 'pt');
  assert.strictEqual(normLang('en_US'), 'en');
  assert.strictEqual(normLang('de'), null);
  assert.strictEqual(normLang(undefined), null);
});

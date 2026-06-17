const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertBlock, normLang, verifyFetch, CORE_FILES, WRAPPER_FILES } = require('../install.js');
const { CORE_FILES: SRC_CORE_FILES } = require('../src/core-files.js');

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

test('install.js CORE_FILES stays in sync with src/core-files.js', () => {
  assert.deepStrictEqual([...CORE_FILES].sort(), [...SRC_CORE_FILES].sort());
});

test('verifyFetch passes when the core is complete, throws on a missing/empty file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  const all = [...CORE_FILES, ...WRAPPER_FILES];
  for (const rel of all) {
    const d = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.writeFileSync(d, 'x');
  }
  assert.doesNotThrow(() => verifyFetch(tmp));
  fs.writeFileSync(path.join(tmp, CORE_FILES[0]), ''); // empty
  assert.throws(() => verifyFetch(tmp), /incomplete install/);
  fs.writeFileSync(path.join(tmp, CORE_FILES[0]), 'x');
  fs.rmSync(path.join(tmp, WRAPPER_FILES[0])); // missing
  assert.throws(() => verifyFetch(tmp), /incomplete install/);
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

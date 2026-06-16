const { test } = require('node:test');
const assert = require('node:assert');
const { upsertBlock } = require('../install.js');

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

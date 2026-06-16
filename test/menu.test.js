const { test } = require('node:test');
const assert = require('node:assert');
const { buildItems, reduceKey, renderLines } = require('../src/menu.js');

test('buildItems lists accounts then add/remove actions', () => {
  const items = buildItems(['work', 'home'], 'work');
  assert.deepStrictEqual(items.map((i) => i.value), ['work', 'home', '__add__', '__remove__']);
  assert.strictEqual(items[0].current, true);
  assert.strictEqual(items[1].current, false);
});

test('buildItems attaches emails when provided', () => {
  const items = buildItems(['work'], 'work', { work: 'w@x.com' });
  assert.strictEqual(items[0].email, 'w@x.com');
});

test('renderLines shows title, email, active tag and pointer', () => {
  const items = buildItems(['work'], 'work', { work: 'w@x.com' });
  const out = renderLines(items, 0).join('\n');
  assert.match(out, /Claude Accounts/);
  assert.match(out, /w@x\.com/);
  assert.match(out, /●/); // active marker, language-independent
  assert.match(out, /❯/);
});

test('reduceKey moves selection and wraps', () => {
  const n = 4;
  assert.strictEqual(reduceKey({ idx: 0, n }, 'up').idx, 3);
  assert.strictEqual(reduceKey({ idx: 3, n }, 'down').idx, 0);
  assert.strictEqual(reduceKey({ idx: 1, n }, 'up').idx, 0);
  assert.deepStrictEqual(reduceKey({ idx: 2, n }, 'enter'), { idx: 2, n, done: 'select' });
  assert.deepStrictEqual(reduceKey({ idx: 2, n }, 'escape'), { idx: 2, n, done: 'cancel' });
});

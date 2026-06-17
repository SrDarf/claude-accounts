const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../src/fsutil.js');

test('atomicWrite writes content and readJson round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsutil-'));
  const f = path.join(dir, 'a.json');
  u.atomicWrite(f, JSON.stringify({ x: 1 }));
  assert.deepStrictEqual(u.readJson(f), { x: 1 });
});

test('readJson returns null for missing file', () => {
  assert.strictEqual(u.readJson(path.join(os.tmpdir(), 'nope-xyz.json')), null);
});

test('chmodSafe surfaces a failure (returns false, never throws)', { skip: process.platform === 'win32' }, () => {
  process.env.CLAUDE_ACCOUNTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fsutil-home-'));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsutil-')), 'x');
  fs.writeFileSync(f, '1');
  const realChmod = fs.chmodSync;
  fs.chmodSync = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
  try {
    let ret;
    assert.doesNotThrow(() => { ret = u.chmodSafe(f, 0o600, 'test'); });
    assert.strictEqual(ret, false);
    assert.strictEqual(u.chmodSafe(f, 0o600), false); // works without a label too
  } finally {
    fs.chmodSync = realChmod;
  }
  assert.strictEqual(u.chmodSafe(f, 0o600), true); // succeeds once chmod works again
});

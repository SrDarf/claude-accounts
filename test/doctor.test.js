const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { freshHome } = require('./helpers.js');
const { CORE_FILES } = require('../src/core-files.js');

function load() {
  for (const m of ['doctor', 'vault', 'paths', 'fsutil', 'lock', 'i18n', 'claude-path', 'core-files', 'log', 'audit']) {
    delete require.cache[require.resolve(`../src/${m}.js`)];
  }
  return require('../src/doctor.js');
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp); else out.push(fp.slice(dir.length));
    }
  };
  walk(dir);
  return out.sort();
}

test('collect() is read-only (no mutation, no lock created)', () => {
  const h = freshHome({ accounts: true });
  process.env.CLAUDE_ACCOUNTS_REAL = process.execPath; // make claude-bin/version resolve
  try {
    const doctor = load();
    const before = snapshot(h);
    doctor.collect();
    assert.deepStrictEqual(snapshot(h), before, 'doctor must not change the home dir');
    assert.ok(!fs.existsSync(path.join(h, '.claude', '.accounts', '.lock')));
  } finally {
    delete process.env.CLAUDE_ACCOUNTS_REAL;
  }
});

test('exitCode maps error->4, warn->3, else 0', () => {
  const doctor = load();
  assert.strictEqual(doctor.exitCode({ checks: [{ status: 'ok' }] }), 0);
  assert.strictEqual(doctor.exitCode({ checks: [{ status: 'warn' }, { status: 'ok' }] }), 3);
  assert.strictEqual(doctor.exitCode({ checks: [{ status: 'error' }, { status: 'warn' }] }), 4);
});

test('core-files check flags an incomplete core', () => {
  const h = freshHome({ accounts: true });
  for (const rel of CORE_FILES) {
    const fp = path.join(h, '.claude-accounts', rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'x');
  }
  let cf = load().collect().checks.find((c) => c.id === 'core-files');
  assert.strictEqual(cf.status, 'ok');
  fs.rmSync(path.join(h, '.claude-accounts', CORE_FILES[0]));
  cf = load().collect().checks.find((c) => c.id === 'core-files');
  assert.strictEqual(cf.status, 'error');
});

test('render produces a human report; report shape is stable', () => {
  freshHome({ accounts: true });
  const report = load().collect();
  assert.match(load().render(report), /claude-accounts doctor/);
  assert.ok(Array.isArray(report.checks) && report.checks.every((c) => c.id && c.status && c.label));
});

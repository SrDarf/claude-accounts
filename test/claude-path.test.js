const { test } = require('node:test');
const assert = require('node:assert');

test('resolveRealClaude honors explicit env override', () => {
  delete require.cache[require.resolve('../src/claude-path.js')];
  process.env.CLAUDE_ACCOUNTS_REAL = '/opt/claude/bin/claude';
  const { resolveRealClaude } = require('../src/claude-path.js');
  assert.strictEqual(resolveRealClaude(), '/opt/claude/bin/claude');
  delete process.env.CLAUDE_ACCOUNTS_REAL;
});

test('findInPath skips the wrapper dir', () => {
  delete require.cache[require.resolve('../src/claude-path.js')];
  const { findInPath } = require('../src/claude-path.js');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-'));
  const skipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-'));
  const exe = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  fs.writeFileSync(path.join(realDir, exe), '');
  fs.writeFileSync(path.join(skipDir, exe), '');
  const found = findInPath('claude', [skipDir, realDir], [skipDir], [process.platform === 'win32' ? '.cmd' : '']);
  assert.strictEqual(found, path.join(realDir, exe));
});

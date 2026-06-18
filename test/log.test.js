const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const path = require('node:path');
const { resolveLevel, stripFlags, tilde, LEVELS } = require('../src/log.js');

const LOG = path.join(__dirname, '..', 'src', 'log.js');
// Run a snippet in a child so stdout and stderr can be captured separately.
// process.argv[1] inside the snippet is the log.js path.
function run(snippet, env = {}) {
  const clean = { ...process.env, NO_COLOR: '1' };
  delete clean.CLAUDE_ACCOUNTS_DEBUG;
  delete clean.CLAUDE_ACCOUNTS_LOG_LEVEL;
  delete clean.CLAUDE_ACCOUNTS_LOG_JSON;
  return cp.spawnSync(process.execPath, ['-e', snippet, LOG], { env: { ...clean, ...env }, encoding: 'utf8' });
}

test('resolveLevel precedence: flags > env > default', () => {
  assert.strictEqual(resolveLevel(['-q'], {}).level, LEVELS.ERROR);
  assert.strictEqual(resolveLevel(['-vv'], {}).level, LEVELS.TRACE);
  assert.strictEqual(resolveLevel(['-v'], {}).level, LEVELS.DEBUG);
  assert.strictEqual(resolveLevel(['--verbose'], {}).level, LEVELS.DEBUG);
  assert.strictEqual(resolveLevel([], { CLAUDE_ACCOUNTS_DEBUG: '1' }).level, LEVELS.DEBUG);
  assert.strictEqual(resolveLevel([], { CLAUDE_ACCOUNTS_DEBUG: 'trace' }).level, LEVELS.TRACE);
  assert.strictEqual(resolveLevel([], { CLAUDE_ACCOUNTS_LOG_LEVEL: 'info' }).level, LEVELS.INFO);
  assert.strictEqual(resolveLevel([], {}).level, LEVELS.WARN);
  assert.strictEqual(resolveLevel(['-q'], { CLAUDE_ACCOUNTS_DEBUG: '1' }).level, LEVELS.ERROR);
  assert.ok(resolveLevel([], { CLAUDE_ACCOUNTS_DEBUG: 'login,lock' }).scopes.has('login'));
  // 'silent' is index 0 — must resolve to SILENT, not fall back to WARN
  assert.strictEqual(resolveLevel([], { CLAUDE_ACCOUNTS_LOG_LEVEL: 'silent' }).level, LEVELS.SILENT);
  assert.strictEqual(resolveLevel([], { CLAUDE_ACCOUNTS_LOG_LEVEL: 'bogus' }).level, LEVELS.WARN);
});

test('stripFlags removes only its own tokens', () => {
  assert.deepStrictEqual(stripFlags(['-v', 'switch', 'work', '-q']), ['switch', 'work']);
  assert.deepStrictEqual(stripFlags(['add', '--verbose', 'x']), ['add', 'x']);
  assert.deepStrictEqual(stripFlags(['list']), ['list']);
});

test('tilde collapses the home dir', () => {
  const prev = process.env.CLAUDE_ACCOUNTS_HOME;
  process.env.CLAUDE_ACCOUNTS_HOME = '/home/x';
  assert.strictEqual(tilde('/home/x/.claude/foo'), '~/.claude/foo');
  assert.strictEqual(tilde('/other/p'), '/other/p');
  if (prev === undefined) delete process.env.CLAUDE_ACCOUNTS_HOME; else process.env.CLAUDE_ACCOUNTS_HOME = prev;
});

test('result() writes stdout; diagnostics write stderr', () => {
  const r = run("const l=require(process.argv[1]); l.setLevel(l.LEVELS.WARN); l.result('RESULT'); l.warn('warn.msg');");
  assert.match(r.stdout, /RESULT/);
  assert.doesNotMatch(r.stdout, /warn\.msg/);
  assert.match(r.stderr, /warn\.msg/);
});

test('level gates output (debug hidden at WARN, shown at DEBUG)', () => {
  const quiet = run("const l=require(process.argv[1]); l.setLevel(l.LEVELS.WARN); l.debug('dbg.msg');");
  assert.doesNotMatch(quiet.stderr, /dbg\.msg/);
  const loud = run("const l=require(process.argv[1]); l.setLevel(l.LEVELS.DEBUG); l.debug('dbg.msg');");
  assert.match(loud.stderr, /dbg\.msg/);
});

test('secret values are redacted; email is allowed', () => {
  const r = run("const l=require(process.argv[1]); l.setLevel(l.LEVELS.DEBUG); l.warn('cap',{token:'SECRETTOK',credentialsText:'CREDXYZ',email:'a@b.com'});");
  assert.doesNotMatch(r.stderr, /SECRETTOK|CREDXYZ/);
  assert.match(r.stderr, /«redacted»/);
  assert.match(r.stderr, /a@b\.com/);
});

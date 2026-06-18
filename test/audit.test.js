const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { freshHome } = require('./helpers.js');

function load() {
  for (const m of ['audit', 'paths', 'log']) delete require.cache[require.resolve(`../src/${m}.js`)];
  return { audit: require('../src/audit.js'), p: require('../src/paths.js') };
}
function readRecords(p) {
  return fs.readFileSync(p.auditLog(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('record appends a JSONL line with the core fields', () => {
  freshHome();
  const { audit, p } = load();
  audit.ok('switch', { account: 'work', from: 'home', to: 'work' });
  const recs = readRecords(p);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].action, 'switch');
  assert.strictEqual(recs[0].outcome, 'ok');
  assert.strictEqual(recs[0].account, 'work');
  assert.ok(typeof recs[0].ts === 'string' && typeof recs[0].pid === 'number' && recs[0].v === 1);
});

test('credMeta returns shape only and a stable hash (never the token)', () => {
  freshHome();
  const { audit } = load();
  const m1 = audit.credMeta('{"claudeAiOauth":{"accessToken":"TOPSECRET"}}');
  const m2 = audit.credMeta('{"claudeAiOauth":{"accessToken":"TOPSECRET"}}');
  assert.deepStrictEqual(Object.keys(m1).sort(), ['len', 'present', 'sha256_12']);
  assert.strictEqual(m1.present, true);
  assert.strictEqual(m1.sha256_12, m2.sha256_12);
  assert.ok(!JSON.stringify(m1).includes('TOPSECRET'));
  assert.strictEqual(audit.credMeta(null), null);
});

test('the audit file NEVER contains a token value', () => {
  freshHome();
  const { audit, p } = load();
  const credentialsText = '{"claudeAiOauth":{"accessToken":"DO-NOT-LEAK-ME"}}';
  audit.ok('slot.write', { account: 'work', cred: audit.credMeta(credentialsText) });
  const raw = fs.readFileSync(p.auditLog(), 'utf8');
  assert.ok(!raw.includes('DO-NOT-LEAK-ME'), 'token value leaked into audit log');
});

test('fail serializes the error; around stamps dur_ms and rethrows', () => {
  freshHome();
  const { audit, p } = load();
  audit.fail('add', new Error('boom'), { account: 'x', reason: 'no-credentials' });
  assert.throws(() => audit.around('switch', { account: 'y' }, () => { throw new Error('mid'); }), /mid/);
  const recs = readRecords(p);
  const f = recs.find((r) => r.action === 'add');
  assert.strictEqual(f.outcome, 'fail');
  assert.strictEqual(f.err.message, 'boom');
  const a = recs.find((r) => r.action === 'switch');
  assert.strictEqual(a.outcome, 'fail');
  assert.ok(typeof a.dur_ms === 'number');
});

test('record never throws into the mutation path when the dir is unwritable', { skip: process.platform === 'win32' }, () => {
  const h = freshHome();
  const { audit, p } = load();
  fs.mkdirSync(p.coreDir(), { recursive: true });
  fs.chmodSync(p.coreDir(), 0o000);
  try {
    assert.doesNotThrow(() => audit.ok('switch', { account: 'work' }));
  } finally {
    fs.chmodSync(p.coreDir(), 0o755); // restore so the temp dir can be cleaned
  }
});

test('rotation renames at the byte threshold, keeping one generation', () => {
  process.env.CLAUDE_ACCOUNTS_AUDIT_MAX_BYTES = '300';
  freshHome();
  const { audit, p } = load();
  for (let i = 0; i < 20; i += 1) audit.ok('slot.write', { account: `acct-${i}`, note: 'x'.repeat(40) });
  assert.ok(fs.existsSync(p.auditLog() + '.1'), 'rotated file .1 should exist');
  assert.ok(fs.existsSync(p.auditLog()), 'live audit log should exist');
  delete process.env.CLAUDE_ACCOUNTS_AUDIT_MAX_BYTES;
});

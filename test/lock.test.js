const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Isolate the core dir so a steal's audit record never touches the real home.
process.env.CLAUDE_ACCOUNTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-home-'));
const { withLock, acquire, release, STALE_MS } = require('../src/lock.js');

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  return path.join(dir, '.lock');
}

test('withLock runs the critical section and releases the lock', () => {
  const lp = tmpLock();
  const r = withLock(lp, () => 42);
  assert.strictEqual(r, 42);
  assert.ok(!fs.existsSync(lp), 'lock file removed after the section');
});

test('withLock releases the lock even when the section throws', () => {
  const lp = tmpLock();
  assert.throws(() => withLock(lp, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(lp), 'lock file removed after a thrown section');
});

test('a held lock is exclusive (a second acquire cannot also create it)', () => {
  const lp = tmpLock();
  withLock(lp, () => {
    // while held, the O_EXCL create must fail for anyone else
    assert.throws(() => fs.openSync(lp, 'wx'), /EEXIST/);
  });
});

test('withLock is reentrant within a process (nested same-path lock runs)', () => {
  const lp = tmpLock();
  const r = withLock(lp, () => {
    assert.ok(fs.existsSync(lp), 'lock held during outer section');
    return withLock(lp, () => {
      assert.ok(fs.existsSync(lp), 'still held during nested re-entry');
      return 'inner';
    });
  });
  assert.strictEqual(r, 'inner');
  assert.ok(!fs.existsSync(lp), 'released only after the outermost holder');
});

test('release does not delete a lock that was stolen/replaced by another holder', () => {
  const lp = tmpLock();
  acquire(lp); // writes OUR ownership token
  fs.writeFileSync(lp, 'OTHER:999:zzz\n'); // simulate a deadline-steal: replaced with another token
  release(lp); // must NOT remove a lock that is no longer ours
  assert.ok(fs.existsSync(lp), 'foreign lock must survive our release (else a third racer gets in)');
  fs.rmSync(lp, { force: true });
});

test('a stale lock left by a crashed process is stolen', () => {
  const lp = tmpLock();
  fs.writeFileSync(lp, '99999\n'); // pretend a dead process holds it
  const aged = (Date.now() - STALE_MS - 5000) / 1000; // seconds, past the threshold
  fs.utimesSync(lp, aged, aged);
  const r = withLock(lp, () => 'stolen');
  assert.strictEqual(r, 'stolen');
  assert.ok(!fs.existsSync(lp));
  // the steal must leave a forensic audit record (never silent)
  const auditPath = path.join(process.env.CLAUDE_ACCOUNTS_HOME, '.claude-accounts', 'audit.log');
  assert.match(fs.readFileSync(auditPath, 'utf8'), /lock\.steal/);
});

'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A cross-process advisory lock for the vault's critical sections (switch / add /
// remove / adopt). The whole point of claude-accounts is to swap the live login
// in place; two invocations racing each other can otherwise interleave their
// save-then-load steps and contaminate a slot with another account's tokens.
// O_EXCL create is the portable atomic "test-and-set"; a stale lock (left by a
// crashed process) is stolen once it ages past STALE_MS so we never deadlock.
//
// The lock is REENTRANT within a single process: a multi-step operation can hold
// it (one file) while calling helpers that each self-lock, so every public vault
// mutator can lock unconditionally without fear of self-deadlock. Re-entry only
// bumps an in-process counter; the file is created once and removed when the
// outermost holder releases. The O_EXCL guarantee still excludes OTHER processes.
const STALE_MS = 15_000;
const POLL_MS = 25;
const held = new Map(); // lockPath -> reentrancy depth held by THIS process

function sleep(ms) {
  // Synchronous sleep without a busy loop; the vault API is sync end to end.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockPath) {
  const depth = held.get(lockPath) || 0;
  if (depth > 0) { held.set(lockPath, depth + 1); return; } // re-entry: just count
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      held.set(lockPath, 1);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      continue; // holder released it between open and stat; retry immediately
    }
    if (age > STALE_MS || Date.now() - start > STALE_MS) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* raced; retry */ }
      continue;
    }
    sleep(POLL_MS);
  }
}

function release(lockPath) {
  const depth = held.get(lockPath) || 0;
  if (depth > 1) { held.set(lockPath, depth - 1); return; } // inner holder
  held.delete(lockPath);
  try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
}

function withLock(lockPath, fn) {
  acquire(lockPath);
  try {
    return fn();
  } finally {
    release(lockPath);
  }
}

module.exports = { withLock, acquire, release, STALE_MS };

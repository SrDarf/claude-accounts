'use strict';
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.js');
const audit = require('./audit.js');

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
const held = new Map(); // lockPath -> { depth, token } held by THIS process

function sleep(ms) {
  // Synchronous sleep without a busy loop; the vault API is sync end to end.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockPath) {
  const cur = held.get(lockPath);
  if (cur) { cur.depth += 1; return; } // re-entry: just count
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // A per-acquisition ownership token so release() only ever deletes OUR lock,
  // never one that a deadline-steal replaced with another process's.
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
      fs.writeSync(fd, token + '\n');
      fs.closeSync(fd);
      held.set(lockPath, { depth: 1, token });
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
      // Stealing a lock means a prior holder crashed, or a live one was judged
      // stale because WE waited too long (deadline) — the latter can let two
      // mutations interleave. Either is worth a forensic record, never silent.
      let holderPid = null;
      try { holderPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10) || null; } catch { /* gone */ }
      const trigger = age > STALE_MS ? 'stale' : 'deadline';
      log.warn('lock.steal', { lock: log.tilde(lockPath), holderPid, ageMs: Math.round(age), trigger, staleMs: STALE_MS });
      audit.record('lock.steal', { outcome: 'ok', reason: trigger, paths: { dest: lockPath } });
      if (trigger === 'deadline') log.warn('lock.steal.contention', { holderPid, hint: 'holder was fresh; concurrent mutation possible' });
      try { fs.rmSync(lockPath, { force: true }); } catch { /* raced; retry */ }
      continue;
    }
    sleep(POLL_MS);
  }
}

function release(lockPath) {
  const cur = held.get(lockPath);
  if (!cur) return;
  if (cur.depth > 1) { cur.depth -= 1; return; } // inner holder
  held.delete(lockPath);
  // Only remove the lock if it is STILL OURS — if a deadline-steal replaced it
  // with another process's lock, deleting it would let a third racer in.
  try {
    if (fs.readFileSync(lockPath, 'utf8').trim() === cur.token) fs.rmSync(lockPath, { force: true });
  } catch { /* already gone */ }
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

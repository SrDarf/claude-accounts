'use strict';
// Append-only JSONL trail of every state mutation, so a surprising switch/remove/
// add can be reconstructed after the fact. Best-effort: it MUST NEVER throw into
// the mutation path; on its own write failure it routes a one-time log.warn.
// Token VALUES are never recorded — only credMeta (presence/length/short hash).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./paths.js');
const log = require('./log.js');

const SCHEMA_VERSION = 1;
const MAX_BYTES = Number(process.env.CLAUDE_ACCOUNTS_AUDIT_MAX_BYTES) || 1048576; // 1 MiB
let seq = 0;
let warnedOnce = false;

// The ONLY function that ever sees token bytes; returns shape, never content.
function credMeta(credentialsText) {
  if (credentialsText == null) return null;
  const len = Buffer.byteLength(credentialsText, 'utf8');
  return {
    present: len > 0,
    len,
    sha256_12: crypto.createHash('sha256').update(credentialsText).digest('hex').slice(0, 12),
  };
}

function maybeRotate() {
  try {
    if (fs.statSync(p.auditLog()).size >= MAX_BYTES) {
      fs.renameSync(p.auditLog(), p.auditLog() + '.1'); // single generation; clobbers prior .1
    }
  } catch { /* absent or stat failed: nothing to rotate */ }
}

function record(action, fields = {}) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      seq: (seq += 1),
      pid: process.pid,
      v: SCHEMA_VERSION,
      action,
      outcome: fields.outcome || 'ok',
      account: fields.account == null ? null : fields.account,
      ...fields,
    };
    fs.mkdirSync(path.dirname(p.auditLog()), { recursive: true });
    maybeRotate();
    const fresh = !fs.existsSync(p.auditLog());
    fs.appendFileSync(p.auditLog(), JSON.stringify(rec) + '\n');
    if (fresh && process.platform !== 'win32') {
      try { fs.chmodSync(p.auditLog(), 0o600); } catch { /* best effort */ }
    }
  } catch (e) {
    if (!warnedOnce) { warnedOnce = true; log.warn('audit.write.failed', { err: e.message }); }
  }
}

function ok(action, fields = {}) { record(action, { ...fields, outcome: 'ok' }); }

function fail(action, err, fields = {}) {
  const e = err && typeof err === 'object'
    ? { message: err.message, code: err.code || null, stack: err.stack }
    : { message: String(err), code: null, stack: null };
  record(action, { ...fields, outcome: 'fail', err: e });
}

// Time fn(); record ok on return / fail on throw (rethrowing); stamp dur_ms.
function around(action, baseFields, fn) {
  const start = Date.now();
  try {
    const out = fn();
    ok(action, { ...baseFields, dur_ms: Date.now() - start });
    return out;
  } catch (e) {
    fail(action, e, { ...baseFields, dur_ms: Date.now() - start });
    throw e;
  }
}

module.exports = { record, ok, fail, around, credMeta };

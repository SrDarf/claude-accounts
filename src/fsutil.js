'use strict';
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.js');
const audit = require('./audit.js');

function atomicWrite(dest, body) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, dest);
}

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Best-effort permission hardening. On a filesystem/platform where chmod fails,
// a creds file can stay world-readable — so a failure is surfaced (WARN + audit)
// instead of swallowed. Returns whether the mode was applied.
function chmodSafe(p, mode, label) {
  if (process.platform === 'win32') return true;
  try { fs.chmodSync(p, mode); return true; }
  catch (e) {
    log.warn('chmod.failed', { path: log.tilde(p), mode: mode.toString(8), label, errno: e.code });
    audit.record('chmod.failed', { outcome: 'fail', reason: 'chmod', paths: { dest: p } });
    return false;
  }
}

module.exports = { atomicWrite, readJson, chmodSafe };

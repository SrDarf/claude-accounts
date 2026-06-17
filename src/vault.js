'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = require('./paths.js');
const { atomicWrite, readJson, chmodSafe } = require('./fsutil.js');
const { withLock } = require('./lock.js');
const { t } = require('./i18n.js');
const log = require('./log.js');
const audit = require('./audit.js');

// Concurrency contract: every mutator here self-locks the vault (p.lockPath()).
// The lock is reentrant within a process, so a multi-step operation that must be
// atomic as a whole (switchAccount in switch.js, addAccount in login.js) wraps its
// sequence in withLock and the nested per-method locks become free re-entries.
// Reads do not lock: atomicWrite renames into place, so a reader always sees a
// whole old-or-new file, never a torn one.

// Names that must never become a slot. 'current'/'.lock' collide with the
// marker (vaultDir/current) and lock (vaultDir/.lock) control files; '.' and
// '..' escape the vault dir (slotDir('..') === ~/.claude). Rejecting them here
// is the single source of truth, so switch/add/remove are all protected.
const RESERVED = new Set(['current', '.lock', '.', '..']);

function validAccountName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !RESERVED.has(name);
}

function list() {
  if (!fs.existsSync(p.vaultDir())) return [];
  return fs.readdirSync(p.vaultDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function getCurrent() {
  if (!fs.existsSync(p.markerPath())) return null;
  const v = fs.readFileSync(p.markerPath(), 'utf8').trim();
  return v || null;
}

function setCurrent(name) {
  withLock(p.lockPath(), () => atomicWrite(p.markerPath(), name));
}

function clearCurrent() {
  withLock(p.lockPath(), () => {
    try { fs.rmSync(p.markerPath(), { force: true }); } catch { /* nothing to clear */ }
  });
}

function writeSlot(name, { credentialsText, oauthAccount }) {
  withLock(p.lockPath(), () => {
    atomicWrite(p.slotCreds(name), credentialsText);
    atomicWrite(p.slotOAuth(name), JSON.stringify(oauthAccount, null, 2));
    chmodSafe(p.slotDir(name), 0o700, 'slot-dir');
    chmodSafe(p.slotCreds(name), 0o600, 'slot-creds');
    chmodSafe(p.slotOAuth(name), 0o600, 'slot-oauth');
  });
}

function readSlot(name) {
  return {
    credentialsText: fs.readFileSync(p.slotCreds(name), 'utf8'),
    oauthAccount: readJson(p.slotOAuth(name)),
  };
}

// Tolerant slot-oauth read: a corrupt file must not crash list/menu rendering.
function storedOAuth(name) {
  try { return readJson(p.slotOAuth(name)); } catch { return null; }
}

function email(name) {
  const o = storedOAuth(name);
  return (o && o.emailAddress) || '';
}

function deriveName(oauthAccount) {
  const e = (oauthAccount && oauthAccount.emailAddress) || '';
  const local = String(e).split('@')[0].replace(/[^A-Za-z0-9._-]/g, '');
  return local || 'default';
}

function uniqueName(base, taken) {
  const blocked = (n) => taken.includes(n) || RESERVED.has(n);
  if (!blocked(base)) return base;
  let i = 2;
  while (blocked(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

// Read ~/.claude.json. Returns {} when the file is absent, but THROWS when it
// exists yet is unparseable: callers that rewrite the whole file (the crown-jewel
// config holding projects/history/settings) must never replace it from an empty
// object, which would silently destroy every other key.
function readLiveJson() {
  if (!fs.existsSync(p.liveJson())) return {};
  const raw = fs.readFileSync(p.liveJson(), 'utf8');
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    throw new Error(`refusing to modify ${p.liveJson()}: not valid JSON (${e.message})`);
  }
}

function captureOAuthFromLive() {
  // Tolerant: used by read/adopt paths, which must degrade rather than crash if
  // ~/.claude.json is mid-write or corrupt. The destructive write path uses
  // readLiveJson() directly so it still refuses to clobber a corrupt file.
  try {
    return readLiveJson().oauthAccount || null;
  } catch (e) {
    log.warn('live.json.corrupt', { path: log.tilde(p.liveJson()), err: e.message, action: 'degraded-to-null-identity' });
    audit.record('livejson.corrupt', { outcome: 'fail', reason: 'corrupt-live-json', paths: { liveJson: p.liveJson() } });
    return null;
  }
}

function injectOAuthIntoLive(oauthAccount) {
  withLock(p.lockPath(), () => {
    const j = readLiveJson();
    j.oauthAccount = oauthAccount;
    atomicWrite(p.liveJson(), JSON.stringify(j, null, 2));
  });
}

// Decide which slot the *currently live* login belongs to. We key off identity
// (the live oauth email), NOT the marker, so a stale or dangling marker (e.g.
// after a crash mid-switch, or after removing the active account) can never make
// us save the live tokens into the wrong account's slot.
// Returns { name, oauth } where oauth is the identity to persist if the live
// login has none of its own: the live identity wins when present, otherwise we
// keep the marker slot's stored oauth so a switch never blanks it out.
function resolveCurrentSlot(liveOAuth) {
  const liveEmail = liveOAuth && liveOAuth.emailAddress;
  const slots = list();
  if (liveEmail) {
    const match = slots.find((n) => email(n) === liveEmail);
    if (match) return { name: match, oauth: liveOAuth };
  } else {
    const cur = getCurrent();
    if (cur && slots.includes(cur)) return { name: cur, oauth: storedOAuth(cur) };
  }
  const name = uniqueName(deriveName(liveOAuth || {}), slots);
  // No live identity to key off: we are about to write a slot with empty oauth
  // (e.g. corrupt ~/.claude.json). Announce it so the identity loss isn't silent.
  if (!liveEmail) log.warn('slot.identity.unknown', { slot: name });
  return { name, oauth: liveOAuth || {} };
}

// Capture the live login into the vault slot that matches its identity. Returns
// the slot name, or null if there is no live login to save. Never overwrites the
// live files; self-locks (and is also called inside switch/adopt's outer lock).
function saveCurrentLogin() {
  return withLock(p.lockPath(), () => {
    if (!fs.existsSync(p.liveCreds())) return null;
    const credentialsText = fs.readFileSync(p.liveCreds(), 'utf8');
    const liveOAuth = captureOAuthFromLive();
    const { name, oauth } = resolveCurrentSlot(liveOAuth);
    writeSlot(name, { credentialsText, oauthAccount: liveOAuth || oauth || {} });
    return name;
  });
}

// First-run safety: register the already logged-in account as the initial slot
// so the live login is never overwritten before being saved. Idempotent: does
// nothing once a current account exists. Returns the adopted name or null.
function adoptCurrent() {
  if (getCurrent()) return null;
  if (!fs.existsSync(p.liveCreds())) return null;
  return withLock(p.lockPath(), () => {
    if (getCurrent()) return null; // re-check under lock
    const name = saveCurrentLogin();
    if (name) setCurrent(name);
    return name;
  });
}

// Delete a stored account. Validates the name and confirms the resolved path
// stays inside the vault (defends against `remove ..` / `remove .` wiping
// ~/.claude or the home dir), and clears the marker when the active account is
// removed so the next run's adoptCurrent re-captures the still-live login.
function removeAccount(name) {
  if (!validAccountName(name)) {
    throw new Error(t('invalidName', name));
  }
  return withLock(p.lockPath(), () => {
    const dir = path.resolve(p.slotDir(name));
    const root = path.resolve(p.vaultDir());
    if (dir === root || !dir.startsWith(root + path.sep)) {
      throw new Error(t('invalidName', name));
    }
    const existed = fs.existsSync(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    if (getCurrent() === name) clearCurrent();
    return { removed: existed, account: name };
  });
}

module.exports = {
  list, getCurrent, setCurrent, clearCurrent, writeSlot, readSlot, email,
  deriveName, adoptCurrent, captureOAuthFromLive, injectOAuthIntoLive,
  readLiveJson, saveCurrentLogin, removeAccount, validAccountName,
};

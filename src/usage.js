'use strict';
const fs = require('node:fs');
const p = require('./paths.js');
const { atomicWrite, chmodSafe } = require('./fsutil.js');
const { withLock } = require('./lock.js');
const log = require('./log.js');

// Endpoints + OAuth client, verified against the bundled `claude` binary:
//   GET  api.anthropic.com/api/oauth/usage      -> per-window utilization
//   POST platform.claude.com/v1/oauth/token     -> refresh_token grant
// The usage payload returns utilization as a 0-100 number and resets_at as an
// ISO-8601 string (NOT the 0-1 / unix-seconds internal shape used elsewhere).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 60_000; // refresh if the token expires within a minute
const FETCH_TIMEOUT_MS = 6000;

// Active account reads the freshest tokens from the live credentials file; the
// others read their stashed slot copy.
function credsPath(name, current) {
  return name === current ? p.liveCreds() : p.slotCreds(name);
}

function readOAuth(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { json, oauth: json.claudeAiOauth || null };
}

async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Exchange a refresh token for a fresh access token. The refresh token may be
// rotated (response.refresh_token); when absent the old one is kept. Caller MUST
// persist the result before doing anything else, or a rotated token is lost and
// the account can no longer refresh.
async function refresh(oauth) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: CLIENT_ID,
    scope: (oauth.scopes || []).join(' '),
  });
  const r = await httpJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok || !r.body || !r.body.access_token) {
    throw new Error(`refresh failed (${r.status})`);
  }
  const b = r.body;
  return {
    ...oauth,
    accessToken: b.access_token,
    refreshToken: b.refresh_token || oauth.refreshToken,
    expiresAt: Date.now() + (Number(b.expires_in) || 0) * 1000,
    scopes: typeof b.scope === 'string' ? b.scope.split(' ') : oauth.scopes,
  };
}

// Write refreshed tokens back, preserving every other key in the file. Slot
// writes take the vault lock (a switch/add could be writing the same dir);
// the live file is written atomically like Claude itself does.
function persist(name, current, json, oauth) {
  const file = credsPath(name, current);
  const body = JSON.stringify({ ...json, claudeAiOauth: oauth }, null, 2);
  if (name === current) {
    atomicWrite(file, body);
    chmodSafe(file, 0o600, 'live-creds'); // never leave refreshed live creds world-readable
  } else {
    // chmod INSIDE the lock so the slot creds are never briefly 0o644 under contention.
    withLock(p.lockPath(), () => {
      atomicWrite(file, body);
      chmodSafe(file, 0o600, 'slot-creds');
    });
  }
}

function parseLimit(o) {
  if (!o || typeof o.utilization !== 'number') return null;
  return {
    pct: o.utilization,
    resetsAt: o.resets_at ? Date.parse(o.resets_at) : null,
  };
}

async function fetchUsage(accessToken) {
  const r = await httpJson(USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`usage ${r.status}`);
  const b = r.body || {};
  return { session: parseLimit(b.five_hour), week: parseLimit(b.seven_day) };
}

// Resolve one account to its usage, refreshing (and persisting) an expired token
// when possible. Never throws: returns { ok:false, reason } so one bad account
// can't blank out the whole menu.
async function accountUsage(name, current) {
  try {
    const file = credsPath(name, current);
    if (!fs.existsSync(file)) return { name, ok: false, reason: 'no-creds' };
    let { json, oauth } = readOAuth(file);
    if (!oauth || !oauth.accessToken) return { name, ok: false, reason: 'no-token' };
    if (oauth.refreshToken && (oauth.expiresAt || 0) - Date.now() < REFRESH_BUFFER_MS) {
      oauth = await refresh(oauth);
      // Persist the (possibly rotated) token, but a write failure must NOT abort
      // the usage fetch — the in-memory access token is still valid for this run.
      try { persist(name, current, json, oauth); }
      catch (e) { log.warn('usage.persist.failed', { account: name, err: e.message }); }
    }
    const usage = await fetchUsage(oauth.accessToken);
    return { name, ok: true, ...usage };
  } catch (e) {
    return { name, ok: false, reason: e.message };
  }
}

async function getAll(names, current) {
  const map = {};
  const entries = await Promise.all(names.map((n) => accountUsage(n, current)));
  for (const e of entries) map[e.name] = e;
  return map;
}

module.exports = { getAll, accountUsage, fetchUsage, refresh, persist };

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const p = require('./paths.js');
const vault = require('./vault.js');
const { readJson } = require('./fsutil.js');
const { withLock } = require('./lock.js');
const { resolveRealClaude } = require('./claude-path.js');
const { t } = require('./i18n.js');
const log = require('./log.js');
const audit = require('./audit.js');

// Capture timing (env-overridable, mainly so tests run fast). The default
// timeout is generous because a real OAuth login involves a browser round-trip.
const CAPTURE_TIMEOUT_MS = Number(process.env.CLAUDE_ACCOUNTS_CAPTURE_TIMEOUT_MS) || 300_000;
const STABILIZE_MS = Number(process.env.CLAUDE_ACCOUNTS_CAPTURE_STABILIZE_MS) || 400;
const POLL_MS = Number(process.env.CLAUDE_ACCOUNTS_CAPTURE_POLL_MS) || 150;
const KILL_TIMEOUT_MS = Number(process.env.CLAUDE_ACCOUNTS_CAPTURE_KILL_MS) || 2000;

// Restore the terminal after a TUI child is signalled (it may not run its own
// teardown), so the user's shell isn't left in raw mode / the alternate screen.
function restoreTty() {
  try { if (process.stdout.isTTY) process.stdout.write('\x1b[?1049l\x1b[?25h'); } catch { /* ignore */ }
  try { if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false); } catch { /* ignore */ }
}

// Kill the temp login session and WAIT for it to actually exit (escalating to
// SIGKILL) before the caller deletes its config dir.
function terminate(child, alreadyExited) {
  return new Promise((resolve) => {
    if (!child || typeof child.kill !== 'function' || alreadyExited()) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof child.once === 'function') child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { return finish(); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(); }, KILL_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// Async so we can watch the credential file appear while the login session is
// still open — the user only needs /login, not /exit. Returns a ChildProcess.
function defaultSpawn(cfgDir) {
  const claude = resolveRealClaude();
  return cp.spawn(claude, [], {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir },
    shell: false,
  });
}

// Resolve once .credentials.json appears AND stops changing (claude writes via
// rename, so size/mtime settle); reject 'no-credentials' if the child dies first,
// or 'timeout' at the deadline.
function waitForCredentials(credPath, deadline, isDead) {
  return new Promise((resolve, reject) => {
    let lastSize = -1;
    let lastMtime = -1;
    let stableSince = 0;
    const tick = () => {
      let st = null;
      try { st = fs.statSync(credPath); } catch { /* not there yet */ }
      const now = Date.now();
      if (st && st.isFile() && st.size > 0) {
        if (st.size === lastSize && st.mtimeMs === lastMtime) {
          if (now - stableSince >= STABILIZE_MS) return resolve('stable');
        } else { lastSize = st.size; lastMtime = st.mtimeMs; stableSince = now; }
      } else {
        // Absent/empty: reset tracking so a create->unlink->recreate (rename churn)
        // can't be mistaken for "unchanged since before", resolving prematurely.
        lastSize = -1; lastMtime = -1; stableSince = 0;
        if (isDead && isDead()) return reject(new Error('no-credentials'));
      }
      if (now >= deadline) return reject(new Error('timeout'));
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

function hasOAuth(jsonPath) {
  try {
    const j = readJson(jsonPath);
    return !!(j && j.oauthAccount && Object.keys(j.oauthAccount).length);
  } catch { return false; }
}

async function addAccount(name, { spawnFn = defaultSpawn } = {}) {
  if (!vault.validAccountName(name)) throw new Error(t('invalidName', name));
  if (vault.list().includes(name)) throw new Error(t('exists', name));

  const slog = log.scoped('login');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-login-'));
  const credPath = path.join(tmp, '.credentials.json');
  const jsonPath = path.join(tmp, '.claude.json');
  const started = Date.now();
  let child = null;
  let childExited = false;
  let spawnError = null;
  slog.debug('capture.tmpdir', { cfgDir: log.tilde(tmp) });
  try {
    slog.debug('capture.spawn', { cfgDir: log.tilde(tmp) });
    child = spawnFn(tmp);
    if (child && typeof child.on === 'function') {
      child.on('exit', () => { childExited = true; });
      // Without this, a failed spawn (ENOENT/EACCES) emits an async 'error' with
      // no handler -> uncaught exception that crashes the whole CLI.
      child.on('error', (e) => { spawnError = e; childExited = true; });
    }

    slog.debug('capture.watch.start', { cred: log.tilde(credPath), timeoutMs: CAPTURE_TIMEOUT_MS, stabilizeMs: STABILIZE_MS });
    try {
      await waitForCredentials(credPath, started + CAPTURE_TIMEOUT_MS, () => childExited);
    } catch (e) {
      if (spawnError) throw spawnError; // spawn itself failed — surface it (catchable upstream)
      const elapsedMs = Date.now() - started;
      // keyring shape: login wrote an oauth identity but no credential FILE
      const keyringSuspected = !fs.existsSync(credPath) && hasOAuth(jsonPath);
      const reason = keyringSuspected ? 'keyring' : e.message; // 'timeout' | 'no-credentials'
      if (keyringSuspected) slog.warn('capture.keyring.suspected', { platform: process.platform, cred: log.tilde(credPath) });
      slog[reason === 'timeout' ? 'error' : 'warn'](`capture.${reason}`, { elapsedMs, cred: log.tilde(credPath) });
      audit.fail('add', e, { account: name, reason, paths: { tmp, creds: credPath }, dur_ms: elapsedMs });
      return { added: false, reason, credPath, elapsedMs, keyringSuspected };
    }

    const credentialsText = fs.readFileSync(credPath, 'utf8');
    slog.debug('capture.cred.stable', { bytes: Buffer.byteLength(credentialsText) });
    let oauthAccount = {};
    try { oauthAccount = (readJson(jsonPath) || {}).oauthAccount || {}; }
    catch (e) { slog.warn('capture.oauth.unreadable', { jsonPath: log.tilde(jsonPath), err: e.message }); oauthAccount = {}; }

    withLock(p.lockPath(), () => {
      if (vault.list().includes(name)) throw new Error(t('exists', name));
      vault.writeSlot(name, { credentialsText, oauthAccount });
    });
    const email = oauthAccount.emailAddress || null;
    audit.ok('add', { account: name, email, cred: audit.credMeta(credentialsText), dur_ms: Date.now() - started });
    return { added: true, account: name, email };
  } finally {
    // End the temp session (no /exit needed), WAIT for it to die, restore the
    // terminal it took over, THEN delete its config dir.
    await terminate(child, () => childExited);
    restoreTty();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { addAccount, waitForCredentials };

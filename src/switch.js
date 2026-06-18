'use strict';
const fs = require('node:fs');
const p = require('./paths.js');
const vault = require('./vault.js');
const { atomicWrite, chmodSafe, fail } = require('./fsutil.js');
const { withLock } = require('./lock.js');
const { t } = require('./i18n.js');
const audit = require('./audit.js');

function switchAccount(target) {
  return withLock(p.lockPath(), () => {
    if (!vault.list().includes(target)) {
      throw new Error(t('unknownVault', target));
    }
    const from = vault.getCurrent();
    if (from === target) {
      return { switched: false, reason: 'already-current', account: target };
    }

    // Save whatever login is live right now into the slot that matches its
    // identity. Keyed off identity (not the marker) so a stale/dangling marker
    // can never clobber the wrong slot or lose the live tokens.
    const savedFrom = vault.saveCurrentLogin();

    const slot = vault.readSlot(target);
    // Preflight: abort BEFORE overwriting live creds if ~/.claude.json is corrupt.
    vault.readLiveJson();

    // Snapshot the live login so a later failure can roll back to a CONSISTENT
    // FROM state. Otherwise leaving creds=target while oauth/marker=from would make
    // the next switch save the target's tokens into FROM's slot (cross-contamination).
    const prevCreds = fs.existsSync(p.liveCreds()) ? fs.readFileSync(p.liveCreds(), 'utf8') : null;
    const prevOAuth = vault.captureOAuthFromLive();

    atomicWrite(p.liveCreds(), slot.credentialsText);
    chmodSafe(p.liveCreds(), 0o600, 'live-creds');
    try {
      vault.injectOAuthIntoLive(slot.oauthAccount || {});
      vault.setCurrent(target);
    } catch (e) {
      // Best-effort rollback to FROM; the original error is what we report.
      try { if (prevCreds !== null) { atomicWrite(p.liveCreds(), prevCreds); chmodSafe(p.liveCreds(), 0o600, 'live-creds'); } } catch (_) { /* keep e */ }
      try { vault.injectOAuthIntoLive(prevOAuth || {}); } catch (_) { /* keep e */ }
      audit.fail('switch', e, { account: target, from, to: target });
      throw fail('switch', t('switchFailed', target), { cause: e });
    }

    const email = (slot.oauthAccount || {}).emailAddress || null;
    audit.ok('switch', { account: target, from, to: target, email, cred: audit.credMeta(slot.credentialsText) });
    return { switched: true, account: target, email, savedFrom };
  });
}

module.exports = { switchAccount };

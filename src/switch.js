'use strict';
const p = require('./paths.js');
const vault = require('./vault.js');
const { atomicWrite, chmodSafe } = require('./fsutil.js');
const { withLock } = require('./lock.js');
const { t } = require('./i18n.js');

function switchAccount(target) {
  return withLock(p.lockPath(), () => {
    if (!vault.list().includes(target)) {
      throw new Error(t('unknownVault', target));
    }
    if (vault.getCurrent() === target) {
      return { switched: false, reason: 'already-current', account: target };
    }

    // Save whatever login is live right now into the slot that matches its
    // identity. Keyed off identity (not the marker) so a stale/dangling marker
    // can never clobber the wrong slot or lose the live tokens.
    vault.saveCurrentLogin();

    const slot = vault.readSlot(target);
    // Preflight: abort BEFORE overwriting live creds if ~/.claude.json exists but
    // is corrupt, so we never leave creds=target while oauth/marker=previous.
    vault.readLiveJson();

    atomicWrite(p.liveCreds(), slot.credentialsText);
    chmodSafe(p.liveCreds(), 0o600, 'live-creds');
    vault.injectOAuthIntoLive(slot.oauthAccount || {});

    vault.setCurrent(target);
    return { switched: true, account: target, email: (slot.oauthAccount || {}).emailAddress || null };
  });
}

module.exports = { switchAccount };

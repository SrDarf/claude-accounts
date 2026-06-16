'use strict';
const os = require('node:os');
const path = require('node:path');

function home() { return process.env.CLAUDE_ACCOUNTS_HOME || os.homedir(); }
function coreDir() { return path.join(home(), '.claude-accounts'); }
function configPath() { return path.join(coreDir(), 'config.json'); }
function claudeDir() { return path.join(home(), '.claude'); }
function vaultDir() { return path.join(claudeDir(), '.accounts'); }
function liveCreds() { return path.join(claudeDir(), '.credentials.json'); }
function liveJson() { return path.join(home(), '.claude.json'); }
function markerPath() { return path.join(vaultDir(), 'current'); }
function slotDir(name) { return path.join(vaultDir(), name); }
function slotCreds(name) { return path.join(slotDir(name), 'credentials.json'); }
function slotOAuth(name) { return path.join(slotDir(name), 'oauthAccount.json'); }

module.exports = {
  home, coreDir, configPath, claudeDir, vaultDir, liveCreds, liveJson,
  markerPath, slotDir, slotCreds, slotOAuth,
};

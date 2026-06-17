'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Create an isolated CLAUDE_ACCOUNTS_HOME for a test and (optionally) bust the
// require cache for the given src modules so they re-resolve paths against the
// new home. Centralizes the bootstrap so the cache-bust list lives next to the
// reason for it, instead of drifting across every test file.
function freshHome({ accounts = false, bust = [] } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  fs.mkdirSync(accounts ? path.join(h, '.claude', '.accounts') : path.join(h, '.claude'),
    { recursive: true });
  for (const m of bust) delete require.cache[require.resolve(`../src/${m}.js`)];
  return h;
}

module.exports = { freshHome };

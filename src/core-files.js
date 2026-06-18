'use strict';
// Single manifest of the runtime core. install.js keeps its OWN copy of these
// lists because it runs before this file is fetched (curl | node), so it cannot
// require it; test/install.test.js asserts the two never drift and that this
// list covers every src/*.js. doctor.js reads it to verify the core is complete.
const CORE_FILES = [
  'src/core-files.js', 'src/paths.js', 'src/fsutil.js', 'src/log.js', 'src/audit.js',
  'src/lock.js', 'src/i18n.js', 'src/vault.js', 'src/switch.js', 'src/login.js',
  'src/claude-path.js', 'src/menu.js', 'src/usage.js', 'src/doctor.js', 'src/cli.js',
];
const WRAPPER_FILES = [
  'wrappers/claude.cmd', 'wrappers/claude.ps1.tmpl', 'wrappers/claude.sh.tmpl',
];
module.exports = { CORE_FILES, WRAPPER_FILES };

# claude-accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a cross-platform tool that switches the logged-in Claude account in a single `~/.claude` in place (no browser re-login), invoked via `claude --accounts` / `claude --account <name>`, installed by `curl|node`.

**Architecture:** One dependency-free Node core (`src/*.js`) holds all logic — vault, switch, guided login, TUI menu. Thin per-shell wrappers (PowerShell function, cmd shim, bash/zsh function) detect the account flags and delegate to the Node core, then exec the real `claude` with remaining args. State lives in `~/.claude/.accounts/<name>/`.

**Tech Stack:** Node.js >= 18, no runtime dependencies. Tests use the built-in `node --test` runner and `node:assert`. All path resolution honors `CLAUDE_ACCOUNTS_HOME` (falls back to `os.homedir()`) so tests run against a temp home.

---

## File Structure

```
claude-accounts/
  install.js              # curl|node entry
  src/
    paths.js              # resolve home/.claude/vault paths (honors CLAUDE_ACCOUNTS_HOME)
    fsutil.js             # atomicWrite, chmodSafe, readJson
    vault.js              # slots, marker, oauthAccount capture/inject
    switch.js             # switchAccount(target)
    login.js              # addAccount(name, spawnFn)
    claude-path.js        # resolveRealClaude()
    menu.js               # reduceKey() pure reducer + interactive runMenu()
    cli.js                # dispatch: menu|switch|add|remove|list|current
  wrappers/
    claude.cmd
    claude.ps1.tmpl
    claude.sh.tmpl
  test/
    vault.test.js
    switch.test.js
    login.test.js
    claude-path.test.js
    menu.test.js
    cli.test.js
  docs/specs/ docs/plans/
  README.md  LICENSE  package.json  .github/workflows/ci.yml
```

Test helper convention: every test sets `process.env.CLAUDE_ACCOUNTS_HOME` to a fresh
`fs.mkdtempSync` dir and builds a fake `.claude` inside it.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `README.md` (stub, filled in Task 11)

- [ ] **Step 1: Write package.json**

```json
{
  "name": "claude-accounts",
  "version": "0.1.0",
  "description": "Switch logged-in Claude Code accounts in place, no re-login.",
  "license": "MIT",
  "type": "commonjs",
  "scripts": {
    "test": "node --test"
  },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 2: Stub README**

```markdown
# claude-accounts

Switch logged-in Claude Code accounts in a single `~/.claude`, no browser re-login.
```

- [ ] **Step 3: Verify node test runner is available**

Run: `node --test`
Expected: exits 0 with "tests 0" (no tests yet).

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "chore: project scaffold"
```

---

### Task 2: paths.js

**Files:**
- Create: `src/paths.js`
- Test: `test/paths.test.js`

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('paths derive from CLAUDE_ACCOUNTS_HOME', () => {
  process.env.CLAUDE_ACCOUNTS_HOME = path.join('/tmp', 'h');
  const p = require('../src/paths.js');
  assert.strictEqual(p.claudeDir(), path.join('/tmp', 'h', '.claude'));
  assert.strictEqual(p.vaultDir(), path.join('/tmp', 'h', '.claude', '.accounts'));
  assert.strictEqual(p.liveCreds(), path.join('/tmp', 'h', '.claude', '.credentials.json'));
  assert.strictEqual(p.liveJson(), path.join('/tmp', 'h', '.claude.json'));
  assert.strictEqual(p.markerPath(), path.join('/tmp', 'h', '.claude', '.accounts', 'current'));
  assert.strictEqual(p.slotDir('work'), path.join('/tmp', 'h', '.claude', '.accounts', 'work'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL ("Cannot find module '../src/paths.js'").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const os = require('node:os');
const path = require('node:path');

function home() { return process.env.CLAUDE_ACCOUNTS_HOME || os.homedir(); }
function claudeDir() { return path.join(home(), '.claude'); }
function vaultDir() { return path.join(claudeDir(), '.accounts'); }
function liveCreds() { return path.join(claudeDir(), '.credentials.json'); }
function liveJson() { return path.join(home(), '.claude.json'); }
function markerPath() { return path.join(vaultDir(), 'current'); }
function slotDir(name) { return path.join(vaultDir(), name); }
function slotCreds(name) { return path.join(slotDir(name), 'credentials.json'); }
function slotOAuth(name) { return path.join(slotDir(name), 'oauthAccount.json'); }

module.exports = {
  home, claudeDir, vaultDir, liveCreds, liveJson,
  markerPath, slotDir, slotCreds, slotOAuth,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.js test/paths.test.js
git commit -m "feat: path resolution honoring CLAUDE_ACCOUNTS_HOME"
```

---

### Task 3: fsutil.js (atomic writes, json, chmod)

**Files:**
- Create: `src/fsutil.js`
- Test: `test/fsutil.test.js`

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../src/fsutil.js');

test('atomicWrite writes content and readJson round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsutil-'));
  const f = path.join(dir, 'a.json');
  u.atomicWrite(f, JSON.stringify({ x: 1 }));
  assert.deepStrictEqual(u.readJson(f), { x: 1 });
});

test('readJson returns null for missing file', () => {
  assert.strictEqual(u.readJson(path.join(os.tmpdir(), 'nope-xyz.json')), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fsutil.test.js`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

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

function chmodSafe(p, mode) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(p, mode); } catch (_) {}
}

module.exports = { atomicWrite, readJson, chmodSafe };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/fsutil.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fsutil.js test/fsutil.test.js
git commit -m "feat: atomic write + json helpers"
```

---

### Task 4: vault.js

**Files:**
- Create: `src/vault.js`
- Test: `test/vault.test.js`

- [ ] **Step 1: Write the failing test**

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-home-'));
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  return h;
}

beforeEach(() => { delete require.cache[require.resolve('../src/vault.js')]; });

test('writeSlot then readSlot round-trips', () => {
  freshHome();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"claudeAiOauth":{"accessToken":"T"}}', oauthAccount: { emailAddress: 'w@x.com' } });
  const slot = vault.readSlot('work');
  assert.match(slot.credentialsText, /accessToken/);
  assert.strictEqual(slot.oauthAccount.emailAddress, 'w@x.com');
  assert.deepStrictEqual(vault.list(), ['work']);
});

test('marker get/set', () => {
  freshHome();
  const vault = require('../src/vault.js');
  assert.strictEqual(vault.getCurrent(), null);
  fs.mkdirSync(require('../src/paths.js').vaultDir(), { recursive: true });
  vault.setCurrent('work');
  assert.strictEqual(vault.getCurrent(), 'work');
});

test('injectOAuthIntoLive preserves other keys', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude.json'),
    JSON.stringify({ keep: 1, oauthAccount: { emailAddress: 'old@x.com' }, also: 'yes' }));
  const vault = require('../src/vault.js');
  vault.injectOAuthIntoLive({ emailAddress: 'new@x.com' });
  const j = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  assert.strictEqual(j.oauthAccount.emailAddress, 'new@x.com');
  assert.strictEqual(j.keep, 1);
  assert.strictEqual(j.also, 'yes');
});

test('captureOAuthFromLive reads live oauthAccount', () => {
  const h = freshHome();
  fs.writeFileSync(path.join(h, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'cap@x.com' } }));
  const vault = require('../src/vault.js');
  assert.strictEqual(vault.captureOAuthFromLive().emailAddress, 'cap@x.com');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/vault.test.js`
Expected: FAIL ("Cannot find module '../src/vault.js'").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('node:fs');
const p = require('./paths.js');
const { atomicWrite, readJson, chmodSafe } = require('./fsutil.js');

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
  atomicWrite(p.markerPath(), name);
}

function writeSlot(name, { credentialsText, oauthAccount }) {
  atomicWrite(p.slotCreds(name), credentialsText);
  atomicWrite(p.slotOAuth(name), JSON.stringify(oauthAccount, null, 2));
  chmodSafe(p.slotDir(name), 0o700);
  chmodSafe(p.slotCreds(name), 0o600);
  chmodSafe(p.slotOAuth(name), 0o600);
}

function readSlot(name) {
  return {
    credentialsText: fs.readFileSync(p.slotCreds(name), 'utf8'),
    oauthAccount: readJson(p.slotOAuth(name)),
  };
}

function captureOAuthFromLive() {
  const j = readJson(p.liveJson());
  return j ? (j.oauthAccount || null) : null;
}

function injectOAuthIntoLive(oauthAccount) {
  const j = readJson(p.liveJson()) || {};
  j.oauthAccount = oauthAccount;
  atomicWrite(p.liveJson(), JSON.stringify(j, null, 2));
}

module.exports = {
  list, getCurrent, setCurrent, writeSlot, readSlot,
  captureOAuthFromLive, injectOAuthIntoLive,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/vault.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault.js test/vault.test.js
git commit -m "feat: vault slots, marker, oauthAccount capture/inject"
```

---

### Task 5: switch.js

**Files:**
- Create: `src/switch.js`
- Test: `test/switch.test.js`

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setup() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-'));
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  fs.mkdirSync(path.join(h, '.claude', '.accounts'), { recursive: true });
  for (const m of ['vault', 'switch', 'paths', 'fsutil']) {
    delete require.cache[require.resolve(`../src/${m}.js`)];
  }
  return h;
}

test('switch loads target creds + oauth and updates marker', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  // two accounts in the vault
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  // live = work
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ keep: 1, oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  const { switchAccount } = require('../src/switch.js');
  const r = switchAccount('home');
  assert.strictEqual(r.switched, true);
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude', '.credentials.json'), 'utf8'), '{"tok":"H"}');
  const live = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'));
  assert.strictEqual(live.oauthAccount.emailAddress, 'h@x.com');
  assert.strictEqual(live.keep, 1);
  assert.strictEqual(vault.getCurrent(), 'home');
});

test('switch saves current login back before loading target', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"OLD"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"tok":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  // live = work but with a REFRESHED token not yet in the slot
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"tok":"REFRESHED"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  require('../src/switch.js').switchAccount('home');
  // work slot must now hold the refreshed token
  assert.strictEqual(vault.readSlot('work').credentialsText, '{"tok":"REFRESHED"}');
});

test('switch to current is a no-op', () => {
  const h = setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"tok":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.setCurrent('work');
  const r = require('../src/switch.js').switchAccount('work');
  assert.strictEqual(r.switched, false);
  assert.strictEqual(r.reason, 'already-current');
});

test('switch to unknown account throws', () => {
  setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{}', oauthAccount: {} });
  assert.throws(() => require('../src/switch.js').switchAccount('ghost'), /ghost/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/switch.test.js`
Expected: FAIL ("Cannot find module '../src/switch.js'").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('node:fs');
const p = require('./paths.js');
const vault = require('./vault.js');
const { atomicWrite, chmodSafe } = require('./fsutil.js');

function switchAccount(target) {
  if (!vault.list().includes(target)) {
    throw new Error(`conta desconhecida no cofre: '${target}'`);
  }
  const current = vault.getCurrent();
  if (current === target) {
    return { switched: false, reason: 'already-current', account: target };
  }

  // 1. save current live login back to its slot (preserve refreshed tokens)
  if (current && vault.list().includes(current)) {
    if (fs.existsSync(p.liveCreds())) {
      vault.writeSlot(current, {
        credentialsText: fs.readFileSync(p.liveCreds(), 'utf8'),
        oauthAccount: vault.captureOAuthFromLive() || {},
      });
    }
  }

  // 2. load target
  const slot = vault.readSlot(target);
  atomicWrite(p.liveCreds(), slot.credentialsText);
  chmodSafe(p.liveCreds(), 0o600);
  vault.injectOAuthIntoLive(slot.oauthAccount || {});

  // 3. marker
  vault.setCurrent(target);
  return { switched: true, account: target, email: (slot.oauthAccount || {}).emailAddress || null };
}

module.exports = { switchAccount };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/switch.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/switch.js test/switch.test.js
git commit -m "feat: in-place account switch with save-before-load"
```

---

### Task 6: login.js (guided add, spawn injected)

**Files:**
- Create: `src/login.js`
- Test: `test/login.test.js`

- [ ] **Step 1: Write the failing test**

The `spawnFn` is injected so tests can simulate the real `claude` login by writing
credential files into the temp `CLAUDE_CONFIG_DIR`.

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setup() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'login-home-'));
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  fs.mkdirSync(path.join(h, '.claude', '.accounts'), { recursive: true });
  for (const m of ['vault', 'login', 'paths', 'fsutil']) {
    delete require.cache[require.resolve(`../src/${m}.js`)];
  }
  return h;
}

test('addAccount captures creds written by the spawned login', async () => {
  setup();
  const { addAccount } = require('../src/login.js');
  // fake login: writes the two files into the temp config dir it is given
  const fakeSpawn = (cfgDir) => {
    fs.writeFileSync(path.join(cfgDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"NEW"}}');
    fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@x.com' } }));
    return { status: 0 };
  };
  const r = await addAccount('newacct', { spawnFn: fakeSpawn });
  assert.strictEqual(r.added, true);
  const vault = require('../src/vault.js');
  assert.ok(vault.list().includes('newacct'));
  assert.strictEqual(vault.readSlot('newacct').oauthAccount.emailAddress, 'new@x.com');
});

test('addAccount rejects when no creds produced', async () => {
  setup();
  const { addAccount } = require('../src/login.js');
  const r = await addAccount('aborted', { spawnFn: () => ({ status: 1 }) });
  assert.strictEqual(r.added, false);
  const vault = require('../src/vault.js');
  assert.ok(!vault.list().includes('aborted'));
});

test('addAccount rejects duplicate name', async () => {
  setup();
  const vault = require('../src/vault.js');
  vault.writeSlot('dup', { credentialsText: '{}', oauthAccount: {} });
  const { addAccount } = require('../src/login.js');
  await assert.rejects(() => addAccount('dup', { spawnFn: () => ({ status: 0 }) }), /existe/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/login.test.js`
Expected: FAIL ("Cannot find module '../src/login.js'").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vault = require('./vault.js');
const { readJson } = require('./fsutil.js');
const { resolveRealClaude } = require('./claude-path.js');

// default spawn: run the real claude with CLAUDE_CONFIG_DIR=cfgDir, inherit stdio
function defaultSpawn(cfgDir) {
  const claude = resolveRealClaude();
  return cp.spawnSync(claude, [], {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir },
    shell: false,
  });
}

async function addAccount(name, { spawnFn = defaultSpawn } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`nome invalido: '${name}'`);
  if (vault.list().includes(name)) throw new Error(`conta '${name}' ja existe`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-login-'));
  try {
    spawnFn(tmp);
    const credPath = path.join(tmp, '.credentials.json');
    const jsonPath = path.join(tmp, '.claude.json');
    if (!fs.existsSync(credPath)) return { added: false, reason: 'no-credentials' };
    const credentialsText = fs.readFileSync(credPath, 'utf8');
    const liveJson = readJson(jsonPath) || {};
    vault.writeSlot(name, { credentialsText, oauthAccount: liveJson.oauthAccount || {} });
    return { added: true, account: name, email: (liveJson.oauthAccount || {}).emailAddress || null };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { addAccount };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/login.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/login.js test/login.test.js
git commit -m "feat: guided add-account via captured login"
```

---

### Task 7: claude-path.js

**Files:**
- Create: `src/claude-path.js`
- Test: `test/claude-path.test.js`

Resolution order: explicit `CLAUDE_ACCOUNTS_REAL` env (installer-written) wins; else
scan PATH for the real binary, skipping any entry inside our own wrapper dir (`~/bin`
on Windows).

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('resolveRealClaude honors explicit env override', () => {
  delete require.cache[require.resolve('../src/claude-path.js')];
  process.env.CLAUDE_ACCOUNTS_REAL = '/opt/claude/bin/claude';
  const { resolveRealClaude } = require('../src/claude-path.js');
  assert.strictEqual(resolveRealClaude(), '/opt/claude/bin/claude');
  delete process.env.CLAUDE_ACCOUNTS_REAL;
});

test('findInPath skips the wrapper dir', () => {
  delete require.cache[require.resolve('../src/claude-path.js')];
  const { findInPath } = require('../src/claude-path.js');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-'));
  const skipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-'));
  const exe = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  fs.writeFileSync(path.join(realDir, exe), '');
  fs.writeFileSync(path.join(skipDir, exe), '');
  const found = findInPath('claude', [skipDir, realDir], [skipDir], [process.platform === 'win32' ? '.cmd' : '']);
  assert.strictEqual(found, path.join(realDir, exe));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude-path.test.js`
Expected: FAIL ("Cannot find module '../src/claude-path.js'").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function findInPath(name, dirs, skipDirs, exts) {
  const skip = new Set(skipDirs.map((d) => path.resolve(d)));
  for (const dir of dirs) {
    if (!dir || skip.has(path.resolve(dir))) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveRealClaude() {
  if (process.env.CLAUDE_ACCOUNTS_REAL) return process.env.CLAUDE_ACCOUNTS_REAL;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const wrapperDir = path.join(process.env.HOME || process.env.USERPROFILE || '', 'bin');
  const found = findInPath('claude', dirs, [wrapperDir], exts);
  if (!found) throw new Error('claude real nao encontrado no PATH');
  return found;
}

module.exports = { resolveRealClaude, findInPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/claude-path.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/claude-path.js test/claude-path.test.js
git commit -m "feat: resolve real claude binary, skipping wrapper dir"
```

---

### Task 8: menu.js (pure reducer + interactive runner)

**Files:**
- Create: `src/menu.js`
- Test: `test/menu.test.js`

The arrow-key reducer is pure and tested. The raw-mode IO runner (`runMenu`) is a thin
shell around it and is not unit-tested (documented limitation).

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildItems, reduceKey } = require('../src/menu.js');

test('buildItems lists accounts then add/remove actions', () => {
  const items = buildItems(['work', 'home'], 'work');
  assert.deepStrictEqual(items.map((i) => i.value), ['work', 'home', '__add__', '__remove__']);
  assert.strictEqual(items[0].current, true);
  assert.strictEqual(items[1].current, false);
});

test('reduceKey moves selection and wraps', () => {
  const n = 4;
  assert.strictEqual(reduceKey({ idx: 0, n }, 'up').idx, 3);
  assert.strictEqual(reduceKey({ idx: 3, n }, 'down').idx, 0);
  assert.strictEqual(reduceKey({ idx: 1, n }, 'up').idx, 0);
  assert.deepStrictEqual(reduceKey({ idx: 2, n }, 'enter'), { idx: 2, n, done: 'select' });
  assert.deepStrictEqual(reduceKey({ idx: 2, n }, 'escape'), { idx: 2, n, done: 'cancel' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/menu.test.js`
Expected: FAIL ("Cannot find module '../src/menu.js'").

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';

function buildItems(names, current) {
  const accounts = names.map((n) => ({ label: n, value: n, current: n === current }));
  return [
    ...accounts,
    { label: '[+] adicionar conta', value: '__add__', current: false },
    { label: '[-] remover conta', value: '__remove__', current: false },
  ];
}

function reduceKey(state, key) {
  const { idx, n } = state;
  if (key === 'up') return { ...state, idx: (idx - 1 + n) % n };
  if (key === 'down') return { ...state, idx: (idx + 1) % n };
  if (key === 'enter') return { ...state, done: 'select' };
  if (key === 'escape') return { ...state, done: 'cancel' };
  return state;
}

// Interactive raw-mode runner. Returns the chosen item.value or null on cancel.
// Not unit-tested (requires a TTY). Keep it thin.
function runMenu(names, current) {
  return new Promise((resolve) => {
    const items = buildItems(names, current);
    let state = { idx: Math.max(0, names.indexOf(current)), n: items.length };
    const out = process.stdout;
    const stdin = process.stdin;

    const render = () => {
      out.write(`\x1b[?25l`); // hide cursor
      out.write(`\r\x1b[2K  Conta Claude  ↑/↓  Enter  Esc\n`);
      items.forEach((it, i) => {
        const tag = it.current ? '  (ativa)' : '';
        const row = `${it.label}${tag}`;
        if (i === state.idx) out.write(`\x1b[2K\x1b[7m❯ ${row}\x1b[0m\n`);
        else out.write(`\x1b[2K  ${row}\n`);
      });
      out.write(`\x1b[${items.length + 1}A`); // move cursor back up
    };

    const cleanup = () => {
      out.write(`\x1b[${items.length + 1}B\x1b[?25h`);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (buf) => {
      const s = buf.toString();
      let key = null;
      if (s === '\x1b[A' || s === 'k') key = 'up';
      else if (s === '\x1b[B' || s === 'j') key = 'down';
      else if (s === '\r' || s === '\n') key = 'enter';
      else if (s === '\x1b' || s === '\x03') key = 'escape';
      if (!key) return;
      state = reduceKey(state, key);
      if (state.done === 'select') { cleanup(); resolve(items[state.idx].value); return; }
      if (state.done === 'cancel') { cleanup(); resolve(null); return; }
      render();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    render();
  });
}

module.exports = { buildItems, reduceKey, runMenu };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/menu.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/menu.js test/menu.test.js
git commit -m "feat: TUI menu reducer + raw-mode runner"
```

---

### Task 9: cli.js dispatch

**Files:**
- Create: `src/cli.js`
- Test: `test/cli.test.js`

`cli.js` is the entry the wrappers call. Subcommands: `list`, `current`, `switch <name>`,
`menu`, `add`, `remove <name>`. Tests exercise the non-interactive subcommands by
spawning `node src/cli.js` with a temp home.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function freshHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-home-'));
  fs.mkdirSync(path.join(h, '.claude', '.accounts'), { recursive: true });
  return h;
}
function run(home, args) {
  return cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), ...args], {
    env: { ...process.env, CLAUDE_ACCOUNTS_HOME: home },
    encoding: 'utf8',
  });
}

test('list prints accounts; current prints marker', () => {
  const h = freshHome();
  const p = require('../src/paths.js');
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  delete require.cache[require.resolve('../src/vault.js')];
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.setCurrent('work');

  const list = run(h, ['list']);
  assert.strictEqual(list.status, 0);
  assert.match(list.stdout, /work/);
  const cur = run(h, ['current']);
  assert.match(cur.stdout, /work/);
});

test('switch <name> changes marker', () => {
  const h = freshHome();
  process.env.CLAUDE_ACCOUNTS_HOME = h;
  delete require.cache[require.resolve('../src/vault.js')];
  const vault = require('../src/vault.js');
  vault.writeSlot('work', { credentialsText: '{"t":"W"}', oauthAccount: { emailAddress: 'w@x.com' } });
  vault.writeSlot('home', { credentialsText: '{"t":"H"}', oauthAccount: { emailAddress: 'h@x.com' } });
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), '{"t":"W"}');
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
  vault.setCurrent('work');

  const r = run(h, ['switch', 'home']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(h, '.claude', '.accounts', 'current'), 'utf8').trim(), 'home');
});

test('unknown subcommand exits non-zero', () => {
  const r = run(freshHome(), ['bogus']);
  assert.notStrictEqual(r.status, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL ("Cannot find module '../src/cli.js'" reported via non-zero child status assertions).

- [ ] **Step 3: Write minimal implementation**

```js
#!/usr/bin/env node
'use strict';
const vault = require('./vault.js');
const { switchAccount } = require('./switch.js');

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'list': {
      const cur = vault.getCurrent();
      for (const n of vault.list()) console.log(n === cur ? `* ${n}` : `  ${n}`);
      return 0;
    }
    case 'current': {
      const cur = vault.getCurrent();
      console.log(cur || '(nenhuma)');
      return 0;
    }
    case 'switch': {
      if (!rest[0]) { console.error('uso: switch <nome>'); return 2; }
      const r = switchAccount(rest[0]);
      console.log(r.switched ? `Conta ativa: ${r.account}` : `Ja na conta '${r.account}'.`);
      return 0;
    }
    case 'remove': {
      if (!rest[0]) { console.error('uso: remove <nome>'); return 2; }
      const fs = require('node:fs');
      const p = require('./paths.js');
      fs.rmSync(p.slotDir(rest[0]), { recursive: true, force: true });
      console.log(`removida: ${rest[0]}`);
      return 0;
    }
    case 'add': {
      const { addAccount } = require('./login.js');
      const name = rest[0] || await prompt('Nome da nova conta: ');
      const r = await addAccount(name, {});
      console.log(r.added ? `Adicionada: ${name}` : `Nada capturado (login abortado).`);
      return r.added ? 0 : 1;
    }
    case 'menu': {
      return runInteractiveMenu();
    }
    default:
      console.error(`subcomando desconhecido: ${cmd || '(vazio)'}`);
      return 2;
  }
}

function prompt(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    process.stdin.resume();
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(d.toString().trim()); });
  });
}

async function runInteractiveMenu() {
  const { runMenu } = require('./menu.js');
  const choice = await runMenu(vault.list(), vault.getCurrent());
  if (choice === null) { console.log('Cancelado.'); return 1; }
  if (choice === '__add__') {
    const { addAccount } = require('./login.js');
    const name = await prompt('Nome da nova conta: ');
    const r = await addAccount(name, {});
    if (!r.added) { console.log('Nada capturado.'); return 1; }
    switchAccount(name);
    console.log(`Conta ativa: ${name}`);
    return 0;
  }
  if (choice === '__remove__') {
    const sub = await runMenu(vault.list(), vault.getCurrent());
    if (sub && sub !== '__add__' && sub !== '__remove__') {
      const fs = require('node:fs');
      const p = require('./paths.js');
      fs.rmSync(p.slotDir(sub), { recursive: true, force: true });
      console.log(`removida: ${sub}`);
    }
    return 0;
  }
  const r = switchAccount(choice);
  console.log(r.switched ? `Conta ativa: ${r.account}` : `Ja na conta '${r.account}'.`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => { console.error(`[claude-accounts] ${e.message}`); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cli.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole suite**

Run: `node --test`
Expected: PASS (all tasks' tests green).

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: cli dispatch (list/current/switch/add/remove/menu)"
```

---

### Task 10: Shell wrappers

**Files:**
- Create: `wrappers/claude.cmd`
- Create: `wrappers/claude.ps1.tmpl`
- Create: `wrappers/claude.sh.tmpl`

These are static text installed by `install.js`. `__CORE__` and `__REAL__` are replaced
at install time with the core dir and the resolved real-claude path (the `.tmpl` ones);
`claude.cmd` reads paths from env/config at runtime.

- [ ] **Step 1: Write claude.sh.tmpl**

```sh
# >>> claude-accounts >>>
claude() {
  if [ "$1" = "--accounts" ]; then
    shift
    node "__CORE__/src/cli.js" menu || return $?
    command claude "$@"
  elif [ "$1" = "--account" ]; then
    node "__CORE__/src/cli.js" switch "$2" || return $?
    shift 2
    command claude "$@"
  else
    command claude "$@"
  fi
}
# <<< claude-accounts <<<
```

- [ ] **Step 2: Write claude.ps1.tmpl**

```powershell
# >>> claude-accounts >>>
function claude {
  $core = "__CORE__"
  $real = "__REAL__"
  if ($args.Count -ge 1 -and $args[0] -eq '--accounts') {
    $rest = @(); if ($args.Count -gt 1) { $rest = $args[1..($args.Count-1)] }
    node "$core\src\cli.js" menu; if ($LASTEXITCODE -ne 0) { return }
    & $real @rest
  } elseif ($args.Count -ge 1 -and $args[0] -eq '--account') {
    $rest = @(); if ($args.Count -gt 2) { $rest = $args[2..($args.Count-1)] }
    node "$core\src\cli.js" switch $args[1]; if ($LASTEXITCODE -ne 0) { return }
    & $real @rest
  } else {
    & $real @args
  }
}
# <<< claude-accounts <<<
```

- [ ] **Step 3: Write claude.cmd**

```bat
@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "CORE=%USERPROFILE%\.claude-accounts"
set "REAL=%CLAUDE_ACCOUNTS_REAL%"
if "%REAL%"=="" set "REAL=%USERPROFILE%\.local\bin\claude.exe"
if /I "%~1"=="--accounts" goto :menu
if /I "%~1"=="--account"  goto :acct
"%REAL%" %*
exit /b %ERRORLEVEL%
:menu
shift
node "%CORE%\src\cli.js" menu || (endlocal & exit /b 1)
goto :rest
:acct
node "%CORE%\src\cli.js" switch "%~2" || (endlocal & exit /b 1)
shift & shift
goto :rest
:rest
set "ARGS="
:loop
if "%~1"=="" goto :run
set "ARGS=!ARGS! %1"
shift
goto :loop
:run
"%REAL%" !ARGS!
exit /b %ERRORLEVEL%
```

- [ ] **Step 4: Commit**

```bash
git add wrappers/
git commit -m "feat: per-shell wrappers (bash/zsh, powershell, cmd)"
```

---

### Task 11: install.js

**Files:**
- Create: `install.js`
- Test: `test/install.test.js` (covers the pure helpers only)

`install.js` mirrors XClaudeUsage patterns: Node>=18 check, fetch core from GitHub raw
into `~/.claude-accounts/`, resolve real claude, write per-shell wrappers wrapped in
marker blocks with backups. Network fetch and shell-file mutation are factored into pure
helpers that are unit-tested; the top-level `main()` orchestration is verified manually.

- [ ] **Step 1: Write the failing test for the block-merge helper**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { upsertBlock } = require('../install.js');

const START = '# >>> claude-accounts >>>';
const END = '# <<< claude-accounts <<<';

test('upsertBlock inserts when absent', () => {
  const out = upsertBlock('existing\n', 'NEW', START, END);
  assert.match(out, /existing/);
  assert.match(out, /NEW/);
  assert.ok(out.indexOf(START) < out.indexOf('NEW'));
});

test('upsertBlock replaces only its own block', () => {
  const initial = `keep-top\n${START}\nOLD\n${END}\nkeep-bottom\n`;
  const out = upsertBlock(initial, 'NEW', START, END);
  assert.match(out, /keep-top/);
  assert.match(out, /keep-bottom/);
  assert.match(out, /NEW/);
  assert.ok(!out.includes('OLD'));
  // exactly one block
  assert.strictEqual(out.split(START).length - 1, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/install.test.js`
Expected: FAIL ("Cannot find module '../install.js'" or `upsertBlock` undefined).

- [ ] **Step 3: Write install.js**

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const cp = require('node:child_process');

const RAW = 'https://raw.githubusercontent.com/__OWNER__/claude-accounts/main';
const CORE_FILES = [
  'src/paths.js', 'src/fsutil.js', 'src/vault.js', 'src/switch.js',
  'src/login.js', 'src/claude-path.js', 'src/menu.js', 'src/cli.js',
];
const START = '# >>> claude-accounts >>>';
const END = '# <<< claude-accounts <<<';
const HOME = os.homedir();
const CORE_DIR = path.join(HOME, '.claude-accounts');

function upsertBlock(content, block, start, end) {
  const wrapped = `${start}\n${block}\n${end}`;
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
  if (re.test(content)) return content.replace(re, wrapped);
  const sep = content.endsWith('\n') || content === '' ? '' : '\n';
  return `${content}${sep}${wrapped}\n`;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function backupThenWrite(file, newContent) {
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur === newContent) return false;
    fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, newContent);
  return true;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); resolve(httpGet(res.headers.location)); return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} ${url}`)); return; }
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function fetchCore() {
  for (const rel of CORE_FILES) {
    const body = await httpGet(`${RAW}/${rel}`);
    const dest = path.join(CORE_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
}

function resolveRealClaude() {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const wrapperDir = path.join(HOME, 'bin');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === path.resolve(wrapperDir)) continue;
    for (const ext of exts) {
      const c = path.join(dir, 'claude' + ext);
      if (fs.existsSync(c)) return c;
    }
  }
  throw new Error('claude real nao encontrado no PATH');
}

function installUnix(real) {
  const tmpl = fs.readFileSync(path.join(CORE_DIR, 'wrappers', 'claude.sh.tmpl'), 'utf8')
    .replace(/__CORE__/g, CORE_DIR);
  const block = tmpl.replace(START + '\n', '').replace('\n' + END, '');
  for (const rc of ['.zshrc', '.bashrc']) {
    const file = path.join(HOME, rc);
    if (!fs.existsSync(file) && rc === '.bashrc') continue;
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    backupThenWrite(file, upsertBlock(cur, block, START, END));
  }
}

async function main() {
  const maj = Number(process.version.match(/^v(\d+)/)[1]);
  if (maj < 18) { console.error('Node >= 18 required'); process.exit(1); }
  console.log('[claude-accounts] fetching core...');
  await fetchCore();
  // wrappers dir alongside core
  fs.mkdirSync(path.join(CORE_DIR, 'wrappers'), { recursive: true });
  for (const w of ['claude.cmd', 'claude.ps1.tmpl', 'claude.sh.tmpl']) {
    const body = await httpGet(`${RAW}/wrappers/${w}`);
    fs.writeFileSync(path.join(CORE_DIR, 'wrappers', w), body);
  }
  const real = resolveRealClaude();
  console.log(`[claude-accounts] real claude: ${real}`);
  if (process.platform === 'win32') {
    installWindows(real); // defined in Step 4
  } else {
    installUnix(real);
  }
  console.log('[claude-accounts] done. Open a new shell and run: claude --accounts');
}

if (require.main === module) {
  main().catch((e) => { console.error(`[claude-accounts] ${e.message}`); process.exit(1); });
}

module.exports = { upsertBlock, backupThenWrite, resolveRealClaude };
```

- [ ] **Step 4: Add the Windows installer branch**

Append to `install.js` (before `module.exports`):

```js
function installWindows(real) {
  // 1) PowerShell profile function
  const ps = fs.readFileSync(path.join(CORE_DIR, 'wrappers', 'claude.ps1.tmpl'), 'utf8')
    .replace(/__CORE__/g, CORE_DIR).replace(/__REAL__/g, real);
  const psBlock = ps.replace(START + '\n', '').replace('\n' + END, '');
  const profile = path.join(HOME, 'Documents', 'WindowsPowerShell', 'profile.ps1');
  const curPs = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
  // PowerShell comment markers differ; reuse the same text markers as comments
  backupThenWrite(profile, upsertBlock(curPs, psBlock, START, END));

  // 2) cmd shim into ~/bin, prepended to User PATH
  const binDir = path.join(HOME, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cmd = fs.readFileSync(path.join(CORE_DIR, 'wrappers', 'claude.cmd'), 'utf8');
  fs.writeFileSync(path.join(binDir, 'claude.cmd'), cmd);
  try {
    const cur = cp.execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\')"', { encoding: 'utf8' }).trim();
    if (!cur.split(';').includes(binDir)) {
      cp.execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path','${binDir};${cur}','User')"`);
    }
  } catch (e) { console.error(`[claude-accounts] PATH update skipped: ${e.message}`); }
  // record real path for the cmd shim
  process.env.CLAUDE_ACCOUNTS_REAL = real;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/install.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Manual smoke (documented, not automated)**

On a real machine with `claude` installed and at least one account already in the vault:
```
node install.js
# open new shell
claude --accounts
```
Expected: selector appears; switching changes the active account.

- [ ] **Step 7: Commit**

```bash
git add install.js test/install.test.js
git commit -m "feat: curl|node installer with per-shell wrapper wiring"
```

---

### Task 12: README, LICENSE, CI

**Files:**
- Modify: `README.md`
- Create: `LICENSE` (MIT)
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write README**

Document: what it does, the one-line install, `claude --accounts` / `claude --account <n>`,
adding an account (guided login), the plaintext-token security note (same exposure as
Claude's own `.credentials.json`), and "close Claude before switching".

```markdown
# claude-accounts

Switch the logged-in Claude Code account in a single `~/.claude` — no browser re-login.

## Install
\`\`\`
curl -fsSL https://raw.githubusercontent.com/__OWNER__/claude-accounts/main/install.js | node
\`\`\`
Open a new shell, then:
\`\`\`
claude --accounts        # arrow-key selector
claude --account work    # switch directly, then launches Claude
\`\`\`

## Adding an account
Choose `[+] adicionar conta` in the selector. A guided browser login runs in a temporary
config dir; the resulting credentials are stored in the vault. No tokens are typed by hand.

## How it works
Each account's `.credentials.json` + `oauthAccount` are stored under
`~/.claude/.accounts/<name>/`. Switching saves the current login back to its slot (keeping
refreshed tokens), then loads the target into `~/.claude/.credentials.json` and
`~/.claude.json`. Always close Claude before switching.

## Security
Tokens are stored in plaintext under `~/.claude/.accounts` — the same exposure level as
Claude Code's own `~/.claude/.credentials.json`. No new attack surface.

## License
MIT
\`\`\`
```

- [ ] **Step 2: Write LICENSE (MIT)**

Standard MIT text, year 2026.

- [ ] **Step 3: Write CI workflow**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: node --test
```

- [ ] **Step 4: Run the full suite locally**

Run: `node --test`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add README.md LICENSE .github/workflows/ci.yml
git commit -m "docs: readme, license, CI matrix"
```

---

## Self-Review notes

- **Spec coverage:** vault (T4), switch save-before-load (T5), guided add (T6), real-claude
  resolution (T7), TUI (T8), CLI entry (T9), wrappers for all three shells (T10), curl|node
  installer with marker-block merge + backups + PATH (T11), README security note + CI (T12).
- **`__OWNER__`** is a deliberate placeholder for the GitHub owner, filled when the repo is
  created (install URL + RAW base). Flagged here so it is not mistaken for an oversight.
- **Open questions from the spec** (empty-`CLAUDE_CONFIG_DIR` triggers login; `command claude`
  reaches the real binary) are validated by Task 11 Step 6 smoke test and the `login.js`
  injected-spawn design (real spawn path exercised manually).

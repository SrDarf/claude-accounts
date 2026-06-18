# Observability & Audit Plan for claude-accounts

Status: PLAN / DESIGN (team implements later). Date: 2026-06-17.

## Context — why this exists

A recent bug (the `add`/login flow not saving an account into the vault) cost a
long manual debugging session "in the dark" because the tool reports almost
nothing. A follow-up observability review found 11 confirmed gaps across three
themes:

- **Silent swallowing.** `fsutil.chmodSafe` swallows chmod errors (a creds file
  can stay world-readable behind a green success); `vault.captureOAuthFromLive`
  swallows a corrupt `~/.claude.json` into a `null` identity, which then makes
  `adoptCurrent` write a `default` slot with empty oauth; `lock.acquire` steals a
  stale lock with zero log (masking crashes, and the deadline-steal can silently
  let two switches contaminate a slot); the installer's `fetchAll` can leave a
  partial core with no completeness check.
- **Misreporting.** `remove X` prints "removed" and exits `0` even when `X` never
  existed (`removeAccount` returns `{removed:false}` and `cli.js` ignores it);
  `switch` prints the account name but discards the `email` it computed (the user
  can operate as the wrong identity); the slot name from `saveCurrentLogin` is
  discarded; `login`'s `reason:'no-credentials'` is dropped.
- **Undiagnosable.** The top-level catch prints only `e.message` (no stack, no
  debug switch); there is no `status`/`doctor` command to inspect resolved state;
  destructive ops have no audit trail (the runtime has no logger at all; only the
  installer has `step`/`done`/`progress`). A collaborator explicitly asked "is
  there an audit log?" — there is none. And `login.addAccount` has no
  instrumentation at all: it never logs the temp config dir, where it looked for
  `.credentials.json`, whether the file appeared, or why it gave up — exactly the
  blind spot that caused the long session. (Empirically, `CLAUDE_CONFIG_DIR` IS
  respected, so the paths are right; the failure is timing/flush/keyring-shaped,
  which is why capture instrumentation is essential.)

This plan unifies four design proposals (logger, audit, diagnostics, capture)
into one coherent build, deduplicated and with conflicts resolved.

## Goals

1. A single, tiny, zero-dependency runtime logging layer (`src/log.js`) — the
   foundation every other piece uses.
2. A durable, machine-readable audit trail of every state mutation
   (`src/audit.js`), answering "is there an audit log?" with "yes, and you can
   `claude-accounts log` it".
3. A read-only `doctor`/`status` command (`src/doctor.js`) that surfaces resolved
   state (real claude path, version, language + source, vault dir, active
   account + email, cred-file perms, lock state, core-file completeness).
4. Real error context: a `DEBUG`-gated stack trace and an operation/step tag on
   thrown errors, plus a stable exit-code convention.
5. Full instrumentation of the `add`/login capture flow — the original incident.
6. Fix every misreport by consuming the structured returns the code already
   produces.
7. Make every currently-silent swallow observable.

## Non-goals

- No logging framework, no transports, no external deps (Node >=18 builtins
  only: `fs`, `os`, `path`, `child_process`, `crypto`).
- No log rotation beyond a single-generation rename (no gzip, no `zlib` hot path).
- No change to the deliberate tolerant behaviors (e.g. `captureOAuthFromLive`
  still degrades to `null` rather than crashing); we make the degrade *visible*,
  not different.
- `menu.js` keeps its raw ANSI cursor control: it is a full-screen TUI, not
  logging, and stays out of scope.
- `install.js` keeps its own `step`/`done`/`progress` pretty-printer (see
  "Resolved conflicts").

---

## Design

Two new runtime modules plus targeted edits. The dependency order is:
`log.js` (no deps) ← `audit.js` (uses `log.js` only for its own failure warning)
← everything else.

> Cross-cutting constraint, load-bearing for both new modules and the existing
> CLI: **diagnostics go to stderr (fd 2); machine-consumable results go to stdout
> (fd 1).** This lets `X=$(claude-accounts current)` and `claude-accounts list`
> stay pipeable while every log/error line lands on fd 2. Today `cli.js` mixes
> both on stdout via `console.log`; this plan splits them.

### 1. `src/log.js` — leveled diagnostics to stderr

Levels (integers so threshold comparison is trivial):

```
SILENT 0 · ERROR 1 · WARN 2 · INFO 3 · DEBUG 4 · TRACE 5
```

Default console threshold is **WARN**. Rationale: the security/degrade/lock-steal
events live at WARN so they are never invisible by default, while routine INFO
audit lines do not clutter an interactive terminal (the durable audit record is
`src/audit.js`'s job, independent of console level — see Resolved conflicts).

Level resolution, computed once at module load (first match wins), from a copy of
`process.argv`:

1. `-q` / `--quiet` → ERROR
2. `-vv` → TRACE
3. `-v` / `--verbose` → DEBUG
4. `CLAUDE_ACCOUNTS_DEBUG` truthy (`1`/`true`/`yes`/`on`, case-insensitive) → DEBUG;
   `=trace` → TRACE; a comma list of scopes (e.g. `login,lock`) → those scopes to
   DEBUG, base stays WARN
5. `CLAUDE_ACCOUNTS_LOG_LEVEL` = `error|warn|info|debug|trace` → that level
6. default → WARN

```js
// src/log.js  'use strict';
const LEVELS = { SILENT:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, TRACE:5 };

function level();                 // -> 0..5, cached
function setLevel(n);             // cli.js calls after parsing argv (testable override)
function enabled(lvl);            // lvl: 'error'|'warn'|'info'|'debug'|'trace'

function error(msg, ctx);         // ctx: flat, serializable key/values (optional)
function warn(msg, ctx);
function info(msg, ctx);
function debug(msg, ctx);
function trace(msg, ctx);

function result(line);            // the ONLY fn that writes fd 1; plain, undecorated
function formatError(err);        // -> string: message always; stack iff level>=DEBUG
function scoped(scope);           // -> { error,warn,info,debug,trace } bound with ctx.scope
function stripFlags(argv);        // -> argv copy without -v/-vv/-q/--verbose/--quiet
function tilde(p);                // collapse home dir in a path so screenshots/logs don't leak it

module.exports = {
  level, setLevel, enabled, error, warn, info, debug, trace,
  result, formatError, scoped, stripFlags, tilde, LEVELS,
};
```

Console line format (fd 2, pretty default):

```
[claude-accounts] WARN  chmod.failed path=~/.claude/.credentials.json mode=600 errno=EPERM
```

- Prefix `[claude-accounts]` (matches the current top-level catch).
- LEVEL padded to 5 cols, colorized when color is on. `msg` is a dotted event
  token; `ctx` is space-joined `key=value`, values JSON-stringified when they
  contain spaces/quotes, truncated past 200 chars.
- JSON mode (`CLAUDE_ACCOUNTS_LOG_JSON=1`): one object per line,
  `{"ts":...,"level":"warn","msg":...,"scope":...,...ctx}`.

Color decision, computed once, keyed off **stderr** (all logs go to fd 2):

```js
const colorOn = !process.env.NO_COLOR &&
  (process.env.CLAUDE_ACCOUNTS_FORCE_COLOR === '1' || process.stderr.isTTY);
```

Palette mirrors `install.js` (WARN=yellow, ERROR=red, DEBUG/TRACE=dim) so the two
surfaces look identical without a require (see Resolved conflicts). `result()`
writes to stdout and is never colorized.

**Secret hygiene (baked into the serializer).** Denylisted ctx keys are redacted
to `«redacted»`: `credentialsText`, `credentials`, `token`, `accessToken`,
`refreshToken`, `oauthAccount`. Callers log *shape, not content*: `credBytes`,
`hasOAuth:true`, `email` (already user-facing today, allowed). The token bytes are
only ever touched by `audit.credMeta` (below).

`stripFlags` is exported so `cli.js` calls `main(log.stripFlags(process.argv.slice(2)))`
and subcommand parsing never sees `-v`/`-q`.

### 2. `src/audit.js` — durable JSONL trail of every mutation

A separate module from `log.js` (see Resolved conflicts: console-quiet vs.
always-record are different policies, so they get different sinks). Append-only
JSON Lines, one record per completed (or failed) mutation attempt; read paths
(`list`/`current`/`status`/`doctor`) are never recorded.

**Location.** `~/.claude-accounts/audit.log`, i.e. in the **core dir** alongside
`config.json`, NOT in the vault. Add to `src/paths.js`:

```js
function auditLog() { return path.join(coreDir(), 'audit.log'); }
```

Rationale for core dir over vault: the log is tooling telemetry, not account
state; keeping it out of `~/.claude/.accounts` means it is never copied as part
of a slot and never collides with a `RESERVED` slot name or the `current`/`.lock`
control files.

```js
// src/audit.js
const crypto = require('node:crypto');

// The ONLY function that ever sees token bytes. Returns presence/shape only.
function credMeta(credentialsText);   // -> null | { present, len, sha256_12 }

// Append one record. Best-effort: NEVER throws into the mutation path. On its
// own write failure it routes a one-time log.warn('audit.write.failed', …) so
// the swallow is itself observable. This is the only sanctioned silent-ish swallow.
function record(action, fields = {}); // fields: {outcome,account,from,to,email,paths,cred,reason,err,dur_ms}
function ok(action, fields = {});      // stamps outcome:'ok'
function fail(action, err, fields = {}); // stamps outcome:'fail', serializes err -> {message,code,stack}
function around(action, baseFields, fn); // times fn(); ok on return / fail on throw; rethrows; sets dur_ms

module.exports = { record, ok, fail, around, credMeta };
```

`credMeta` is the single secret-touching choke point:

```js
function credMeta(credentialsText) {
  if (credentialsText == null) return null;
  const bytes = Buffer.byteLength(credentialsText, 'utf8');
  return {
    present: bytes > 0,
    len: bytes,
    // 48 bits: enough to tell "creds changed" from "creds identical" across a
    // switch without being reversible.
    sha256_12: crypto.createHash('sha256').update(credentialsText).digest('hex').slice(0, 12),
  };
}
```

`record` assigns `ts`/`seq`/`pid`/`v`, single-line `JSON.stringify`s, calls
`maybeRotate()`, then `fs.appendFileSync(p.auditLog(), line + '\n')`. The dir is
created lazily; on first create the file is `chmodSafe(p.auditLog(), 0o600)` (it
names emails and paths, never tokens). The whole body is `try/catch`; on catch it
warns once via `log.warn` and otherwise does nothing.

**Rotation (zero-dep, single generation).** Threshold `CLAUDE_ACCOUNTS_AUDIT_MAX_BYTES`
(default `1048576` = 1 MiB ≈ 4k events). `maybeRotate()` stats the file; if
`>= max`, `fs.renameSync(auditLog, auditLog + '.1')` (clobbering any prior `.1`).
Bounded total ≈ 2 MiB. Rename is atomic and cross-platform; rotation failure is
swallowed like any other audit error.

### 3. `src/doctor.js` — read-only resolved-state inspector

Pure read-only: never mutates, never acquires the lock (only reports its
presence/age), never throws for "the thing is wrong" (a wrong thing is data, not
an exception).

```js
// src/doctor.js
function collect();                 // -> Report (pure read-only)
function render(report, { color }); // -> human string
function exitCode(report);          // -> worst severity mapped to exit code
module.exports = { collect, render, exitCode };
```

```js
Report = { ok: boolean, generatedAt: string, checks: Check[] };
Check  = { id, label, status: 'ok'|'warn'|'error'|'info', value, detail? };
```

Checks (each one `Check`; render order = list order):

| id | source | ok when | warn/error when |
|----|--------|---------|-----------------|
| `node` | `process.version` | >= 18 | error if < 18 |
| `claude-bin` | `resolveRealClaude()` in try/catch | resolves | error if it throws (not in PATH); message → `detail` |
| `claude-version` | `spawnSync(real,['--version'],{timeout:5000,encoding:'utf8'})` | exit 0 → trimmed stdout | warn on fail/non-zero/timeout; skipped `info` if `claude-bin` errored |
| `lang` | `i18n.lang()` + which source won | always `info` | shows `pt-BR (source: env CLAUDE_ACCOUNTS_LANG)` / `en (source: config.json)` / `en (source: default)` |
| `vault-dir` | `p.vaultDir()` | exists | warn if missing (no accounts yet) |
| `active` | `vault.getCurrent()` | marker set AND slot exists | warn if marker set but slot dir missing (dangling marker); info if none |
| `active-email` | `vault.email(current)` | non-empty | warn if current set but email empty (the silent empty-oauth symptom) |
| `accounts` | `vault.list()` + per-slot email | always `info` | warn a slot whose `oauthAccount.json` is unreadable |
| `perms-live-creds` | `statSync(p.liveCreds()).mode & 0o777` | `=== 0o600` | warn if other bits set; info if absent; `info: n/a (windows)` on win32 |
| `perms-slot-creds` | per slot `p.slotCreds(name)` | all `0o600` | warn listing any slot not `0o600` |
| `lock` | `statSync(p.lockPath())` | absent | info if present & age < `STALE_MS` ("held pid N age Nms"); warn if age > `STALE_MS` (likely a crashed switch) |
| `core-files` | each `CORE_FILES` exists & non-empty under `p.coreDir()` | all present | error listing any missing/empty (partial install) |
| `audit` | `statSync(p.auditLog())` + tail | always `info` | size + last event + age (or "none yet") |

`exitCode(report)`: any `error` → `4`; else any `warn` → `3`; else `0`. Distinct
3/4 lets CI separate "degraded" from "broken"; any non-zero is still "fail" for a
simple check.

`render` human mock (glyphs `✓`/`⚠`/`✗`/`ℹ`, plain Unicode so they survive
`color:false`):

```
  claude-accounts doctor

  ✓  node            v20.11.1
  ✓  claude binary   /home/luka/.local/bin/claude
  ✓  claude version  2.0.14 (Claude Code)
  ℹ  language        pt-BR  (source: env CLAUDE_ACCOUNTS_LANG)
  ✓  vault dir       ~/.claude/.accounts
  ✓  active account  work
  ✓  active email    leo@company.com
  ℹ  accounts (3)    work     leo@company.com
                     personal leofilhocastro@gmail.com
                     client   ⚠ oauthAccount.json unreadable
  ✓  live creds      0o600  ~/.claude/.credentials.json
  ⚠  slot creds      personal/credentials.json is 0o644 (expected 0o600)
  ✓  lock            none
  ℹ  audit log       ~/.claude-accounts/audit.log  (14 KB, last: switch.ok 2m ago)
  ✓  core files      12/12 present

  1 warning. Run with -v (or CLAUDE_ACCOUNTS_DEBUG=1) for stack traces on errors.
```

`core-files`: to keep one source of truth, extract a 3-line `src/core-files.js`
that exports the array; both `install.js` (replacing its inline literal) and
`doctor.js` require it. This also closes the installer's "partial core, no
completeness check" gap because doctor can verify completeness post-install.

### 4. Error context

**DEBUG-gated stack traces.** Replace the lossy top-level catch in `cli.js`:

```js
main(log.stripFlags(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((e) => {
    const op = e.caStep ? ` (${e.caStep})` : '';
    process.stderr.write(`[claude-accounts]${op} ${e.message}\n`);
    if (log.level() >= log.LEVELS.DEBUG) {
      process.stderr.write((e.stack || '') + '\n');
      if (e.cause) process.stderr.write(`caused by: ${e.cause.stack || e.cause}\n`);
    }
    audit.fail('fatal', e, { reason: process.argv[2] || null });
    process.exit(e.caExit || 1);
  });
```

**Operation/step tagging.** Add a one-line helper to `src/fsutil.js` (already the
shared low-level util, no deps):

```js
function fail(step, message, opts = {}) {     // throw fail('switch:partial', msg, { cause, exit })
  const e = new Error(message);
  e.caStep = step;                             // names the failed step in output
  if (opts.cause) e.cause = opts.cause;
  if (opts.exit) e.caExit = opts.exit;
  return e;
}
```

Apply at load-bearing throw sites:

- **`switch.js`** — the dangerous gap: a throw between `atomicWrite(p.liveCreds())`
  and `setCurrent` leaves live creds = target while marker = previous. Wrap the
  post-write region and signal a recoverable partial switch with exit `75`:

  ```js
  atomicWrite(p.liveCreds(), slot.credentialsText);   // step: switch:write-live-creds
  chmodSafe(p.liveCreds(), 0o600, 'live-creds');
  try {
    vault.injectOAuthIntoLive(slot.oauthAccount || {});
    vault.setCurrent(target);
  } catch (e) {
    throw fail('switch:partial', t('switchPartial', target), { cause: e, exit: 75 });
  }
  ```

- **`vault.readLiveJson`** — keep its precise "refusing to modify … not valid
  JSON" message but throw via `fail('read-live-json', msg)` so the step shows even
  without `-v`; add `audit.fail('livejson.refused', e, { paths:{ liveJson } })` at
  the throw so the refusal-to-clobber is recorded.
- **`vault.removeAccount`** invalid-name throw → `fail('remove:validate', t('invalidName',name), { exit: 2 })`.
- **`login.js`** capture/write region → `fail('add:write-slot', msg, { cause })`.

`caStep`/`caExit`/`cause` are plain properties; tests asserting on `e.message`
keep passing.

### 5. Capture instrumentation — the add/login blind spot

Two parts: observe the credential file appearing, and trace every decision point.

**(a) Watch-based capture.** Replace the blocking `cp.spawnSync` + bare
`fs.existsSync(credPath)` (login.js:28,31) with `cp.spawn` and a poll-until-stable
loop, so we can observe the file materialize and avoid reading a half-flushed
keyring write.

```js
const CAPTURE_TIMEOUT_MS = Number(process.env.CLAUDE_ACCOUNTS_CAPTURE_TIMEOUT_MS) || 300_000;
const STABILIZE_MS = 400;   // size+mtime must hold this long before we read
const POLL_MS = 150;
async function waitForCredentials(credPath, deadline); // resolves stable | rejects timeout
```

**(b) Instrument every point that went dark** (scope `login`, mostly DEBUG so
normal output stays clean; one always-on failure line):

| Point in flow | Call | Severity | Fields |
|---|---|---|---|
| after `mkdtempSync` | `log.debug('capture.tmpdir', …)` | debug | `cfgDir` |
| before spawn | `log.debug('capture.spawn', …)` | debug | `claude=resolveRealClaude()`, `cfgDir` |
| watch begin | `log.debug('capture.watch.start', …)` | debug | `cred`, `timeoutMs`, `stabilizeMs` |
| each absent poll | `log.trace('capture.watch.tick', …)` | trace | `elapsedMs` |
| file appears | `log.debug('capture.cred.appeared', …)` | debug | `elapsedMs`, `bytes` |
| file stable → read | `log.debug('capture.cred.stable', …)` | debug | `bytes`, `mode` |
| keyring suspected | `log.warn('capture.keyring.suspected', …)` | warn | `platform`, `cred`, hint |
| timeout | `log.error('capture.timeout', …)` + `audit.fail('add', …, {reason:'timeout'})` | error | `elapsedMs`, `cred`, actionable msg |
| child exit before file | `log.debug('capture.child.exit', …)` | debug | `code`, `signal` |
| corrupt/missing `.claude.json` oauth (replaces silent catch login.js:34) | `log.warn('capture.oauth.unreadable', …)` | warn | `jsonPath`, `err` |
| slot written | `audit.ok('add', …)` | audit | `account`, `email`, `cred` (via `credMeta`), `dur_ms` |
| no-credentials return | always-on stderr line + `audit.fail('add', …, {reason:'no-credentials'})` | error/audit | `cfgDir`, `cred` |

**Keyring detection** (the empirically-confirmed failure shape): after timeout,
if `credPath` is absent but `path.join(tmp,'.claude.json')` exists with an
`oauthAccount`, login succeeded into the OS keyring, not a file. Emit a clear
`capture.keyring.suspected` warning explaining the tool can only vault
file-based credentials. Also detect `fs.lstatSync(credPath).isFile() === false`
(symlink/socket/dir) → `capture.cred.notfile`.

`addAccount` returns the richer reason so the CLI stops misreporting:

```js
return { added: false, reason: 'timeout' /* | 'no-credentials' */, credPath, elapsedMs, keyringSuspected };
```

With `CLAUDE_ACCOUNTS_DEBUG=login claude-accounts add work` the operator sees the
temp config dir, the spawn exit status, whether each file appeared, and the exact
give-up reason — the entire blind spot.

### 6. Make every silent swallow observable

**(a) `fsutil.chmodSafe`** — gains an optional `label`; warns + audits on failure
(SECURITY: a creds file can stay world-readable behind a green success):

```js
function chmodSafe(p, mode, label) {
  if (process.platform === 'win32') return true;
  try { fs.chmodSync(p, mode); return true; }
  catch (e) {
    log.warn('chmod.failed', { path: log.tilde(p), mode: mode.toString(8), label, errno: e.code });
    audit.record('chmod.failed', { outcome: 'fail', reason: 'chmod', paths: { dest: p } });
    return false;
  }
}
```

Callers in `vault.writeSlot` and `switch.js` pass labels (`slot-dir`,
`slot-creds`, `slot-oauth`, `live-creds`). Behavior unchanged on Windows/exotic
FS; only visibility is added.

**(b) `lock.acquire` steal** — read the holder PID, distinguish the two triggers,
warn + audit (currently zero log):

```js
let holderPid = null;
try { holderPid = parseInt(fs.readFileSync(lockPath,'utf8'),10) || null; } catch {}
const trigger = age > STALE_MS ? 'stale' : 'deadline';
log.warn('lock.steal', { lock: log.tilde(lockPath), holderPid, ageMs: Math.round(age), trigger, staleMs: STALE_MS });
audit.record('lock.steal', { outcome: 'ok', reason: trigger, paths: { dest: lockPath } });
if (trigger === 'deadline') {
  log.warn('lock.steal.contention', { holderPid });  // holder was fresh the whole time: possible slot corruption
}
```

Plus `log.trace('lock.acquired'|'lock.released', …)` for lifecycle (gated so the
25 ms poll loop does not spam — only one `log.debug('lock.wait', …)` on first
contended wait).

**(c) `vault.captureOAuthFromLive`** — warn on the corrupt-degrade (keeps the
tolerant `return null`):

```js
catch (e) {
  log.warn('live.json.corrupt', { path: log.tilde(p.liveJson()), err: e.message, action: 'degraded-to-null-identity' });
  audit.record('livejson.corrupt', { outcome: 'fail', reason: 'corrupt-live-json', paths: { liveJson: p.liveJson() } });
  return null;
}
```

Companion in `resolveCurrentSlot` when identity is null and it falls through to
`uniqueName(deriveName(...))`: `log.warn('slot.identity.unknown', { slot })` so the
"silently writes a default slot with empty oauth" path announces itself.

**(d) `install.js fetchAll`** — add `verifyFetch()` after the loop and **before**
wiring any shell rc/PATH, so a partial fetch is never made live:

```js
function verifyFetch() {
  const missing = [...CORE_FILES, ...WRAPPER_FILES].filter((rel) => {
    try { return fs.statSync(path.join(CORE_DIR, rel)).size === 0; } catch { return true; }
  });
  if (missing.length) throw new Error(
    `incomplete install: ${missing.length} file(s) missing or empty: ${missing.join(', ')}. ` +
    `Re-run the installer; nothing was wired into your shell.`);
  done(`verified ${CORE_FILES.length + WRAPPER_FILES.length} files`);
}
```

`httpGet` non-200 already rejects with the URL; surface it via the existing `✗`
error path. The installer keeps its own printer (see Resolved conflicts).

### 7. Surface every dropped return signal (`cli.js`)

| Site | Dropped signal | New behavior |
|---|---|---|
| `remove` (cli.js:30) | `removeAccount().removed` | capture `r`; if `!r.removed`: `log.warn(...)` + `log.result(t('notFound', name))` + return `1`; else `log.result(t('removed', name))` + `audit.ok('remove', …)` + return `0`. Stops "removed + exit 0" for a name that never existed. |
| `reportSwitch` (cli.js:64) | `r.email` | print `t('activeNowEmail', r.account, r.email)` when email present; if `r.switched && !r.email`: `log.warn('switch.no-identity', { account })` (operate-as-wrong-identity guard) but still return `0`. |
| `add` (cli.js:38) | `r.reason`, `r.email` | branch on `r.reason`: `no-credentials` → `t('nothingCaptured')`; `timeout` → actionable timeout msg; `keyringSuspected` → keyring hint; all return `1`. On success print `t('addedEmail', name, r.email)` when email present. |
| menu `__add__` (cli.js:83) | `r.reason` | same reason-aware messages instead of generic `nothingShort`. |
| `adoptCurrent()` (cli.js:11) | adopted slot name | when non-null, `log.info(t('adopted', name))` to **stderr** so it is visible but does not pollute `list`/`current` stdout. |
| `saveCurrentLogin()` (switch.js:20) | saved slot name | capture it, pass up as `r.savedFrom`, `audit.ok('save-slot', { account: saved })`; `log.debug('switch.saved-prev', …)`. No longer silently discarded. |

Also: all `console.log` that are *results* (`list`/`current`/`switch`/`remove`/
`add` strings) become `log.result(...)` (stdout); all `console.error` and
diagnostic `console.log` become `log.*` (stderr). Guard `vault.adoptCurrent()` at
cli.js:11 so it runs only for mutating commands (`switch|add|menu|remove`), never
for `doctor|status|list|current` — doctor must observe state without changing it.

### 8. `doctor`/`status` + `log` CLI wiring (`cli.js`)

```js
case 'doctor':
case 'status': {
  const doctor = require('./doctor.js');
  const report = doctor.collect();
  process.stdout.write(rest.includes('--json')
    ? JSON.stringify(report, null, 2) + '\n'
    : doctor.render(report, { color: process.stdout.isTTY && !process.env.NO_COLOR }));
  return doctor.exitCode(report);
}
case 'log': {           // read-only audit reader
  // claude-accounts log [N] [--json] [--action=switch,add] [--fails] [--account=NAME]
  // default: pretty-print last 50 records (chronological), reading audit.log.1 then audit.log.
  // --json: emit raw JSONL unchanged. Empty/missing -> t('noAuditYet'), exit 0.
  // exit 0 success / 2 bad usage. Never the mutation-failed code: a failed *record* is not a failed *read*.
}
```

`log` pretty line:

```
2026-06-17T09:14:22.418Z  switch  ok    work -> personal   (1180ms)
```

with an indented second line on `fail` carrying `reason` + `err.message`;
`--json` is the full-fidelity escape hatch (paths, cred, stack).

---

## Audit record schema

Flat JSON object, one per line. Field order is fixed for readability; parsers
must not depend on it.

| Field | Type | Req | Notes |
|---|---|---|---|
| `ts` | string | yes | `new Date().toISOString()` (UTC, ms) |
| `seq` | number | yes | monotonic per-process counter from 1; disambiguates same-`ts` events |
| `pid` | number | yes | `process.pid`; correlates with lock-steal + concurrent runs |
| `v` | number | yes | schema version, currently `1` |
| `action` | string | yes | enum below |
| `outcome` | string | yes | `"ok"` \| `"fail"` |
| `account` | string\|null | yes | slot the op acts on; `null` when not yet known |
| `from` / `to` | string\|null | no | for `switch`, `marker.set` |
| `email` | string\|null | no | identity email (not a secret in this tool) |
| `paths` | object | no | role-keyed absolute paths: `src`,`dest`,`creds`,`oauth`,`liveJson`,`slotDir`,`tmp`,`lock` |
| `cred` | object\|null | no | metadata ONLY, from `credMeta`: `{present,len,sha256_12}` |
| `reason` | string\|null | no | `no-credentials`,`timeout`,`already-current`,`not-found`,`corrupt-live-json`,`invalid-name`,`lock-timeout`,`stale`,`deadline`,`chmod` |
| `err` | object\|null | no | on fail: `{message,code,stack}` (the only place a stack is persisted) |
| `dur_ms` | number | no | wall-clock of the mutation when cheaply available |

**Never logged:** token/credential VALUES (`.credentials.json` contents, oauth
`accessToken`/`refreshToken`, any `oauthAccount` field except `emailAddress`); full
`~/.claude.json` contents (only its path, in `paths.liveJson`); `process.env`; lock
file contents. Token bytes touch exactly one function (`credMeta`).

Action enum (logged at the mutation site so menu path and flag path both record):

| `action` | from | mutation |
|---|---|---|
| `adopt` | `vault.adoptCurrent` | first-run capture of the live login into a slot |
| `add` | `login.addAccount` | spawned-login capture into a slot (or fail w/ reason) |
| `switch` | `switch.switchAccount` | composite swap summary (`from`/`to`) |
| `save-slot` | `vault.saveCurrentLogin` | live login written to its identity slot |
| `slot.write` | `vault.writeSlot` | raw slot write (carries `cred`) |
| `creds.overwrite` | `switch.switchAccount` | live `~/.claude/.credentials.json` replaced |
| `livejson.rewrite` | `vault.injectOAuthIntoLive` | `~/.claude.json` rewritten with new oauth |
| `livejson.corrupt` / `livejson.refused` | `vault.js` | degrade / refuse-to-clobber |
| `marker.set` / `marker.clear` | `vault.setCurrent` / `clearCurrent` | marker changed/removed |
| `remove` | `vault.removeAccount` | slot deleted; `reason:'not-found'` + `outcome:'ok'` when `existed===false` (fixes the misreport by making the truth auditable) |
| `chmod.failed` | `fsutil.chmodSafe` | a chmod was swallowed (SECURITY) |
| `lock.steal` | `lock.acquire` | a stale/deadline lock was stolen (highest-value forensic record) |
| `fatal` | `cli.js` catch | uncaught error |

A high-level op emits several records sharing `pid`, ordered by `seq` (a `switch`
emits `save-slot`, `slot.write`, `creds.overwrite`, `livejson.rewrite`,
`marker.set`, then the summarizing `switch`), so a reader can fold them into one
transaction.

### Examples

Successful switch (summarizing record):

```json
{"ts":"2026-06-17T09:14:22.418Z","seq":5,"pid":48213,"v":1,"action":"switch","outcome":"ok","account":"personal","from":"work","to":"personal","email":"me@personal.com","paths":{"creds":"/home/luka/.claude/.credentials.json","liveJson":"/home/luka/.claude.json","slotDir":"/home/luka/.claude/.accounts/personal"},"cred":{"present":true,"len":1487,"sha256_12":"9f1c0a7b3e21"},"dur_ms":1180}
```

Failed add — login spawned but no credentials appeared (the exact blind spot):

```json
{"ts":"2026-06-17T09:31:07.002Z","seq":2,"pid":48990,"v":1,"action":"add","outcome":"fail","account":"newwork","email":null,"reason":"no-credentials","paths":{"tmp":"/tmp/ca-login-Qx7Lp2","creds":"/tmp/ca-login-Qx7Lp2/.credentials.json","liveJson":"/tmp/ca-login-Qx7Lp2/.claude.json"},"cred":{"present":false},"err":{"message":"no credentials file after login","code":null,"stack":"Error: no credentials file after login\n    at addAccount (…/login.js:31)\n    …"}}
```

---

## Env vars

| Var | Effect |
|---|---|
| `CLAUDE_ACCOUNTS_DEBUG` | `=1`/`true`/`yes`/`on` → DEBUG console; `=trace` → TRACE; `=login,lock` → those scopes to DEBUG |
| `CLAUDE_ACCOUNTS_LOG_LEVEL` | explicit `error\|warn\|info\|debug\|trace` |
| `CLAUDE_ACCOUNTS_LOG_JSON` | `=1` → console emits one JSON object per line |
| `CLAUDE_ACCOUNTS_AUDIT_MAX_BYTES` | rotation threshold (default `1048576`) |
| `CLAUDE_ACCOUNTS_CAPTURE_TIMEOUT_MS` | add-flow capture timeout (default `300000`) |
| `CLAUDE_ACCOUNTS_FORCE_COLOR` | `=1` → ANSI even when stderr is not a TTY (CI capture) |
| `NO_COLOR` | any value → never emit ANSI (honored even on a TTY) |

CLI flags (parsed and stripped by `log.stripFlags` before subcommand parsing):
`-v`/`--verbose` → DEBUG, `-vv` → TRACE, `-q`/`--quiet` → ERROR.

(`CLAUDE_ACCOUNTS_LANG`, `CLAUDE_ACCOUNTS_REAL`, `CLAUDE_ACCOUNTS_HOME` already
exist and are unchanged.)

## Exit codes

| Code | Name | Meaning | Emitted by |
|---|---|---|---|
| 0 | OK | success (wrapper then launches `claude` for switch/add/menu-switch) | normal completion |
| 1 | FAIL | operation completed-but-nothing-happened or runtime failure: `add` captured nothing/timeout/keyring, `remove` of a missing account, menu cancelled, generic uncaught error | cli.js cases + top-level catch default |
| 2 | USAGE | missing arg, unknown subcommand, invalid account name, bad `log` flag | usage guards, `unknown`, `remove:validate` |
| 3 | DOCTOR_WARN | `doctor`/`status` ran fine, found ≥1 warn and 0 error | `doctor.exitCode` |
| 4 | DOCTOR_ERROR | `doctor`/`status` found ≥1 error (missing core file, claude not found, node < 18) | `doctor.exitCode` |
| 75 | TEMPFAIL | partial/recoverable switch: live creds written for target but oauth/marker not committed — rerun the same `switch <target>` to finish | `switch.js` `switch:partial` |

`remove` of a nonexistent account moves from the current wrong `0` to `1`. All
error output goes to stderr; only command results and `doctor`/`log` renders go to
stdout, so `list`/`current`/`doctor --json`/`log --json` stay machine-parseable.

---

## Phased rollout (highest-leverage, lowest-risk first)

Each phase is independently shippable and testable. The mapping column ties each
item to the 11 review findings.

**Phase 0 — Foundation (no behavior change yet).**
- Add `src/log.js` (levels, sinks, `stripFlags`, `tilde`, secret denylist).
- Add `src/audit.js` + `paths.auditLog()` + rotation.
- Add `src/core-files.js`; point `install.js` at it.
- Add all three new files to `CORE_FILES` (the existing test
  `CORE_FILES covers every src/*.js module` makes this mandatory for any new
  `src/*.js`; same class as the prior `i18n.js` omission).
- Wire `log.stripFlags` + the DEBUG-gated top-level catch in `cli.js`.
- *Closes:* the "no logger / no audit log / catch shows only e.message" findings
  (3 of 11) at the infrastructure level; collaborator's "is there an audit log?".

**Phase 1 — Make silent swallows observable (cheapest, highest forensic value).**
- `chmodSafe` warn + audit (SECURITY). *(finding 1)*
- `lock.steal` warn + audit + contention line. *(finding 2 — the stale/deadline steal)*
- `captureOAuthFromLive` corrupt-degrade warn + `slot.identity.unknown`. *(finding 3)*
- `install.verifyFetch()` completeness gate. *(finding 4)*
- These are 1-to-few-line edits at known sites, no API changes, no test churn.

**Phase 2 — Stop misreporting (consume the returns the code already produces).**
- `remove` honors `{removed:false}` → exit 1 + `notFound`. *(finding 5)*
- `switch` prints `email`, warns on no-identity. *(finding 6)*
- surface `add` `reason`, `adopted` name, `saveCurrentLogin` `savedFrom`. *(findings 7,8)*
- new i18n keys (en/pt): `notFound`, `activeNowEmail`, `warnNoEmail`, `addFailed`,
  `addedEmail`, `adopted`, `switchPartial`, `noAuditYet`, `usageLog`.

**Phase 3 — Capture instrumentation (the original incident).**
- Watch-based capture + full `login.addAccount` trace + keyring detection +
  actionable timeout. *(finding 9 — the blind spot)*
- Highest risk (changes the capture mechanism), so it ships after the cheap wins
  are in and well-tested.

**Phase 4 — Diagnosability commands.**
- `src/doctor.js` + `doctor`/`status` CLI case (guard `adoptCurrent` off it). *(finding 10 — no status/doctor)*
- `log` CLI reader over the audit file. *(finding 11 — destructive ops auditability, read side)*
- `fail()` step tags + exit 75 partial-switch. *(error-context portion of finding on undiagnosable catch)*

---

## Testing notes

Tests use `node --test` and the `freshHome()` helper (isolated
`CLAUDE_ACCOUNTS_HOME`, optional require-cache bust). New tests, per phase:

- **log.js:** level resolution precedence (argv > `CLAUDE_ACCOUNTS_DEBUG` >
  `CLAUDE_ACCOUNTS_LOG_LEVEL` > default); `stripFlags` removes only its tokens and
  leaves subcommand args intact; secret denylist redacts `token`/`credentialsText`/
  `accessToken`; `result()` writes fd 1 while `warn()` writes fd 2 (capture both
  streams in a child process); `NO_COLOR` and non-TTY suppress ANSI; `tilde`
  collapses home. Use `setLevel` to make level deterministic in-process.
- **audit.js:** `record` never throws when the dir is read-only (point `coreDir`
  at a chmod-000 dir; assert no throw and that a `log.warn` fired); `credMeta`
  returns only `{present,len,sha256_12}` and the same input yields a stable hash;
  `around` sets `dur_ms` and logs `fail` (rethrowing) on a throwing fn; rotation
  renames at the byte threshold and keeps exactly two files. **Critical secret
  test:** read back the written JSONL and assert no record contains the literal
  credentials text or any oauth token field.
- **chmodSafe:** on a path where `fs.chmodSync` is monkey-patched to throw, assert
  it returns `false`, emits one `chmod.failed` warn, and does NOT throw. win32
  short-circuit returns `true` without touching fs.
- **lock steal:** create a stale lock (mtime older than `STALE_MS`) and a fresh
  lock; assert `stale` vs `deadline` trigger classification and that a steal emits
  a warn + audit record with `holderPid`. Keep the existing reentrancy/exclusion
  tests green.
- **misreports (cli):** `remove` of an absent name → exit 1 + `notFound` (regression
  for the headline misreport); `switch` output includes the email; `add` with a
  spawnFn that writes nothing → reason-specific message + exit 1. Drive via the
  injectable `spawnFn` already in `addAccount`.
- **capture:** spawnFn that writes `.credentials.json` after a delay → captured;
  spawnFn that writes nothing → timeout reason (use a tiny
  `CLAUDE_ACCOUNTS_CAPTURE_TIMEOUT_MS`); spawnFn that writes only `.claude.json`
  with an `oauthAccount` → `keyringSuspected:true`. Assert DEBUG trace lines appear
  on stderr only under `-v`.
- **doctor:** `collect()` is pure (snapshot the home dir before/after, assert no
  mutation, assert no lock file created); `exitCode` maps error→4, warn→3, else 0;
  a missing core file yields a `core-files` error; bad live-creds perms yield a
  warn; `--json` shape is stable. Skip perms assertions on win32.
- **install:** extend the existing `CORE_FILES covers every src/*.js module` test
  (it already auto-enforces the three new files); add a `verifyFetch` test that an
  empty/missing file makes it throw before any shell wiring.
- **i18n:** every new key exists in both `en` and `pt` (the table already has a
  parity-style test surface).

## NOT in scope / deferred

- Remote/syslog/journald transports, structured log shipping, OpenTelemetry — out
  (zero-dep constraint).
- Multi-generation or time-based audit rotation, compression — single `.1` rename
  only.
- A `--repair` / "finish the partial switch" automation — exit 75 documents the
  state and tells the user to rerun the same `switch`; auto-repair is deferred.
- Refactoring `install.js` onto `src/log.js` — deferred by design (bootstrap
  cycle; see below). The installer only gains `verifyFetch` and may optionally
  append its `step`/`done` to `audit.log` best-effort.
- Refactoring `menu.js` onto the logger — it is a TUI, not logging.
- Per-account or global config for log level/audit path beyond the env vars above.
- Encrypting or signing the audit log.

---

## Resolved conflicts (where the proposals disagreed, and the pick)

- **One module vs. two (logger-is-the-audit-log vs. separate `audit.js`).** Picked
  **two modules.** The logger proposal folded audit into a second sink of
  `log.js`; the audit proposal made it standalone. Two modules win because the
  policies genuinely differ: console output is quiet-by-default (WARN) and
  TTY/level-gated, while the audit record must be written unconditionally,
  always-JSON, always to disk, and must never throw into a mutation. Keeping them
  separate makes "the audit write failed" expressible as a `log.warn` (audit
  depends on log, not vice-versa) and keeps each module single-purpose. Tradeoff:
  two files instead of one, and two `require`s at call sites — accepted for the
  clean dependency direction and testability.
- **Audit file location: vault vs. core dir.** Picked **core dir**
  (`~/.claude-accounts/audit.log`). The logger proposal defaulted to the core dir;
  one capture proposal put it in the vault. Core dir wins: the log is tooling
  telemetry, must not be copied as slot state, and must not risk colliding with a
  `RESERVED` slot name or the `current`/`.lock` control files.
- **Stack-trace switch: env var only vs. `-v` flag.** Picked **both**, unified
  through `log.level()`: `-v`/`-vv`/`-q` flags AND `CLAUDE_ACCOUNTS_DEBUG`. The
  diagnostics proposal argued env-only (survives the shell wrapper without arg
  parsing); the logger proposal added flags. Since `log.stripFlags` already has to
  parse argv for level anyway, supporting both costs nothing and the flag is the
  ergonomic interactive path while the env var is the wrapper/CI path.
- **Capture mechanism: keep `spawnSync` + instrument, vs. async `spawn` + watch.**
  Picked **async `spawn` + poll-until-stable.** The minimal proposal kept
  `spawnSync` and only added trace lines; the capture proposal rewrote to a watch
  loop. The watch loop is the only design that can (a) detect the
  timing/flush/keyring failure the incident actually was, and (b) avoid reading a
  half-flushed credential file. Tradeoff: it is the riskiest change, so it is
  sequenced last (Phase 3) behind the cheap, high-value swallow/misreport fixes.
- **Installer coupling.** Picked **keep `install.js` separate** from `src/log.js`.
  The installer runs before `src/*.js` exists on disk (it is what fetches them), so
  requiring `src/log.js` would create a bootstrap cycle; its `progress()` bar is a
  different concern from leveled logging. We share only the palette constants
  (mirrored, not required) and the `CORE_FILES` array (via the new
  `src/core-files.js`).

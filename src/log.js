'use strict';
// Tiny, dependency-free leveled logger. Diagnostics go to stderr (fd 2) so that
// command results on stdout (fd 1) stay pipeable; result() is the only writer of
// fd 1. Verbosity comes from -v/-vv/-q flags or CLAUDE_ACCOUNTS_DEBUG /
// CLAUDE_ACCOUNTS_LOG_LEVEL. Secret values are redacted by the serializer.

const LEVELS = { SILENT: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5 };
const NAMES = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];
const FLAG_TOKENS = new Set(['-v', '--verbose', '-vv', '-q', '--quiet']);
// Lower-cased ctx keys whose VALUE must never be written. Callers log shape
// (credBytes, hasOAuth, email) instead.
const SECRET_KEYS = new Set([
  'credentialstext', 'credentials', 'token', 'accesstoken', 'refreshtoken', 'oauthaccount',
]);

function truthy(v) { return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v)); }

// Pure level/scope resolution so tests don't have to mutate process state.
// Returns { level, scopes:Set } — scopes are raised to DEBUG even when the base
// level is lower (e.g. CLAUDE_ACCOUNTS_DEBUG=login,lock).
function resolveLevel(argv, env) {
  const scopes = new Set();
  let level;
  if (argv.includes('-q') || argv.includes('--quiet')) level = LEVELS.ERROR;
  else if (argv.includes('-vv')) level = LEVELS.TRACE;
  else if (argv.includes('-v') || argv.includes('--verbose')) level = LEVELS.DEBUG;

  const dbg = env.CLAUDE_ACCOUNTS_DEBUG;
  if (dbg) {
    if (/^trace$/i.test(dbg)) { level = level == null ? LEVELS.TRACE : level; }
    else if (truthy(dbg)) { level = level == null ? LEVELS.DEBUG : level; }
    else { String(dbg).split(',').forEach((s) => { const n = s.trim(); if (n) scopes.add(n); }); }
  }
  if (level == null) {
    const lvl = env.CLAUDE_ACCOUNTS_LOG_LEVEL;
    const i = lvl ? NAMES.indexOf(String(lvl).toLowerCase()) : -1;
    level = i >= 0 ? i : LEVELS.WARN; // i===0 is 'silent'; only an unknown value (-1) falls back

  }
  return { level, scopes };
}

let _state; // { level, scopes }
function state() {
  if (!_state) _state = resolveLevel(process.argv, process.env);
  return _state;
}
function level() { return state().level; }
function setLevel(n) { _state = { level: n, scopes: (_state && _state.scopes) || new Set() }; }

function enabled(name, scope) {
  const want = LEVELS[name.toUpperCase()];
  const s = state();
  if (s.level >= want) return true;
  return !!scope && s.scopes.has(scope) && want <= LEVELS.DEBUG;
}

const colorOn = !process.env.NO_COLOR
  && (process.env.CLAUDE_ACCOUNTS_FORCE_COLOR === '1' || process.stderr.isTTY);
const PAINT = { error: '\x1b[31m', warn: '\x1b[33m', info: '', debug: '\x1b[2m', trace: '\x1b[2m' };
const RESET = '\x1b[0m';

function tilde(p) {
  if (typeof p !== 'string') return p;
  const home = process.env.CLAUDE_ACCOUNTS_HOME || require('node:os').homedir();
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function serializeCtx(ctx) {
  if (!ctx) return '';
  const parts = [];
  for (const [k, vRaw] of Object.entries(ctx)) {
    if (k === 'scope') continue;
    let v = SECRET_KEYS.has(k.toLowerCase()) ? '«redacted»' : vRaw;
    if (v == null) v = String(v);
    else if (typeof v === 'object') v = JSON.stringify(v);
    else v = String(v);
    if (v.length > 200) v = v.slice(0, 197) + '...';
    if (/[\s"]/.test(v)) v = JSON.stringify(v);
    parts.push(`${k}=${v}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function emit(name, msg, ctx) {
  if (!enabled(name, ctx && ctx.scope)) return;
  if (process.env.CLAUDE_ACCOUNTS_LOG_JSON === '1') {
    const safe = {};
    if (ctx) for (const [k, v] of Object.entries(ctx)) {
      safe[k] = SECRET_KEYS.has(k.toLowerCase()) ? '«redacted»' : v;
    }
    process.stderr.write(JSON.stringify({ level: name, msg, ...safe }) + '\n');
    return;
  }
  const label = name.toUpperCase().padEnd(5);
  const head = colorOn && PAINT[name] ? `${PAINT[name]}${label}${RESET}` : label;
  process.stderr.write(`[claude-accounts] ${head} ${msg}${serializeCtx(ctx)}\n`);
}

const error = (msg, ctx) => emit('error', msg, ctx);
const warn = (msg, ctx) => emit('warn', msg, ctx);
const info = (msg, ctx) => emit('info', msg, ctx);
const debug = (msg, ctx) => emit('debug', msg, ctx);
const trace = (msg, ctx) => emit('trace', msg, ctx);

// Command results: stdout, never colorized, never gated by level.
function result(line) { process.stdout.write(line + '\n'); }

function formatError(err) {
  if (!err) return '';
  const msg = err.message || String(err);
  return level() >= LEVELS.DEBUG && err.stack ? err.stack : msg;
}

function scoped(scope) {
  return {
    error: (m, c) => error(m, { ...c, scope }),
    warn: (m, c) => warn(m, { ...c, scope }),
    info: (m, c) => info(m, { ...c, scope }),
    debug: (m, c) => debug(m, { ...c, scope }),
    trace: (m, c) => trace(m, { ...c, scope }),
  };
}

// Remove our own flags so subcommand parsing never sees them.
function stripFlags(argv) { return argv.filter((a) => !FLAG_TOKENS.has(a)); }

module.exports = {
  LEVELS, resolveLevel, level, setLevel, enabled,
  error, warn, info, debug, trace, result, formatError, scoped, stripFlags, tilde,
};

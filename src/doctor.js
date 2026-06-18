'use strict';
// Read-only resolved-state inspector. Never mutates, never acquires the lock
// (only reports its presence), never throws for "the thing is wrong" — a wrong
// thing is a Check with status 'warn'/'error', not an exception.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const p = require('./paths.js');
const vault = require('./vault.js');
const log = require('./log.js');
const i18n = require('./i18n.js');
const { resolveRealClaude } = require('./claude-path.js');
const { STALE_MS } = require('./lock.js');
const { CORE_FILES } = require('./core-files.js');

function langSource() {
  if (i18n.norm(process.env.CLAUDE_ACCOUNTS_LANG)) return 'env CLAUDE_ACCOUNTS_LANG';
  try { if (i18n.norm(JSON.parse(fs.readFileSync(p.configPath(), 'utf8')).lang)) return 'config.json'; } catch { /* none */ }
  return 'default';
}

function collect() {
  const checks = [];
  const add = (id, label, status, value, detail) => checks.push({ id, label, status, value, detail });

  const maj = Number((process.version.match(/^v(\d+)/) || [])[1] || 0);
  add('node', 'node', maj >= 18 ? 'ok' : 'error', process.version);

  let real = null;
  try { real = resolveRealClaude(); add('claude-bin', 'claude binary', 'ok', log.tilde(real)); }
  catch (e) { add('claude-bin', 'claude binary', 'error', 'not found', e.message); }

  if (real) {
    try {
      const r = cp.spawnSync(real, ['--version'], { timeout: 5000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout) add('claude-version', 'claude version', 'ok', r.stdout.trim().split('\n')[0]);
      else add('claude-version', 'claude version', 'warn', 'could not determine', (r.error && r.error.message) || `exit ${r.status}`);
    } catch (e) { add('claude-version', 'claude version', 'warn', 'could not determine', e.message); }
  } else {
    add('claude-version', 'claude version', 'info', 'n/a');
  }

  add('lang', 'language', 'info', `${i18n.lang()}  (source: ${langSource()})`);

  const vaultExists = fs.existsSync(p.vaultDir());
  add('vault-dir', 'vault dir', vaultExists ? 'ok' : 'warn', log.tilde(p.vaultDir()), vaultExists ? undefined : 'no accounts yet');

  const cur = vault.getCurrent();
  const slots = vault.list();
  if (!cur) add('active', 'active account', 'info', '(none)');
  else if (!slots.includes(cur)) add('active', 'active account', 'warn', cur, 'marker set but slot missing (dangling)');
  else {
    add('active', 'active account', 'ok', cur);
    const em = vault.email(cur);
    add('active-email', 'active email', em ? 'ok' : 'warn', em || '(none)', em ? undefined : 'current account has no stored identity');
  }

  add('accounts', `accounts (${slots.length})`, 'info', slots.map((n) => `${n}  ${vault.email(n) || ''}`).join('\n') || '(none)');

  if (process.platform === 'win32') {
    add('perms-live-creds', 'live creds', 'info', 'n/a (windows)');
  } else {
    const lc = p.liveCreds();
    if (!fs.existsSync(lc)) add('perms-live-creds', 'live creds', 'info', 'absent');
    else {
      const mode = fs.statSync(lc).mode & 0o777;
      add('perms-live-creds', 'live creds', mode === 0o600 ? 'ok' : 'warn', `0o${mode.toString(8)}  ${log.tilde(lc)}`, mode === 0o600 ? undefined : 'expected 0o600');
    }
    const bad = slots.filter((n) => { try { return (fs.statSync(p.slotCreds(n)).mode & 0o777) !== 0o600; } catch { return false; } });
    add('perms-slot-creds', 'slot creds', bad.length ? 'warn' : 'ok', bad.length ? bad.map((n) => `${n} not 0o600`).join(', ') : 'all 0o600');
  }

  try {
    const age = Date.now() - fs.statSync(p.lockPath()).mtimeMs;
    add('lock', 'lock', age > STALE_MS ? 'warn' : 'info',
      age > STALE_MS ? `held, age ${Math.round(age)}ms (stale; prior crash?)` : `held, age ${Math.round(age)}ms`);
  } catch { add('lock', 'lock', 'ok', 'none'); }

  const missing = CORE_FILES.filter((rel) => { try { return fs.statSync(path.join(p.coreDir(), rel)).size === 0; } catch { return true; } });
  add('core-files', 'core files', missing.length ? 'error' : 'ok',
    `${CORE_FILES.length - missing.length}/${CORE_FILES.length} present`,
    missing.length ? `missing/empty: ${missing.join(', ')}` : undefined);

  try {
    const st = fs.statSync(p.auditLog());
    add('audit', 'audit log', 'info', `${Math.max(1, Math.round(st.size / 1024))} KB  ${log.tilde(p.auditLog())}`);
  } catch { add('audit', 'audit log', 'info', 'none yet'); }

  return { ok: !checks.some((c) => c.status === 'error'), generatedAt: new Date().toISOString(), checks };
}

function render(report) {
  const G = { ok: '✓', warn: '⚠', error: '✗', info: 'ℹ' };
  const lines = ['', '  claude-accounts doctor', ''];
  for (const c of report.checks) {
    const val = String(c.value).split('\n');
    lines.push(`  ${G[c.status] || ' '}  ${c.label.padEnd(15)} ${val[0]}${c.detail ? `  — ${c.detail}` : ''}`);
    for (const extra of val.slice(1)) lines.push(`  ${' '.repeat(20)}${extra}`);
  }
  const errs = report.checks.filter((c) => c.status === 'error').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  lines.push('', `  ${errs} error(s), ${warns} warning(s). Run with -v (or CLAUDE_ACCOUNTS_DEBUG=1) for stack traces.`, '');
  return lines.join('\n') + '\n';
}

function exitCode(report) {
  if (report.checks.some((c) => c.status === 'error')) return 4;
  if (report.checks.some((c) => c.status === 'warn')) return 3;
  return 0;
}

module.exports = { collect, render, exitCode };

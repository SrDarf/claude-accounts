#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const cp = require('node:child_process');

const RAW = 'https://raw.githubusercontent.com/SrDarf/claude-accounts/main';
const CORE_FILES = [
  'src/paths.js', 'src/fsutil.js', 'src/lock.js', 'src/i18n.js', 'src/vault.js',
  'src/switch.js', 'src/login.js', 'src/claude-path.js', 'src/menu.js', 'src/cli.js',
];
const WRAPPER_FILES = [
  'wrappers/claude.cmd', 'wrappers/claude.ps1.tmpl', 'wrappers/claude.sh.tmpl',
];
const START = '# >>> claude-accounts >>>';
const END = '# <<< claude-accounts <<<';
const HOME = os.homedir();
const CORE_DIR = path.join(HOME, '.claude-accounts');

// --- pretty output (Claude-ish terracotta accent) ---
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  accent: (s) => (useColor ? `\x1b[38;2;215;119;87m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
};
function logo() {
  console.log(`\n  ${C.accent(C.bold('claude-accounts'))} ${C.dim('installer')}\n`);
}
function step(msg) { console.log(`  ${C.accent('•')} ${msg}`); }
function done(msg) { console.log(`  ${C.green('✓')} ${msg}`); }
function progress(cur, total, label) {
  const w = 24;
  const ratio = total ? cur / total : 0;
  const filled = Math.round(ratio * w);
  const barStr = C.accent('█'.repeat(filled)) + C.dim('░'.repeat(w - filled));
  const pct = String(Math.round(ratio * 100)).padStart(3);
  if (process.stdout.isTTY) {
    process.stdout.write(`\r  ${barStr} ${pct}%  ${C.dim(label)}\x1b[K`);
    if (cur >= total) process.stdout.write('\n');
  } else if (cur >= total) {
    console.log(`  fetched ${total} files`);
  }
}

// --- installer i18n (runs before the runtime core exists) ---
const MSG = {
  en: {
    downloading: 'downloading core...',
    starting: 'starting...',
    found: (r) => `claude found: ${r}`,
    adopted: (n) => `current account registered as '${n}'`,
    installing: 'installing shell wrappers...',
    installed: 'wrappers installed',
    ready: (cmd) => `done! open a new shell and run ${cmd}`,
  },
  pt: {
    downloading: 'baixando core...',
    starting: 'iniciando...',
    found: (r) => `claude encontrado: ${r}`,
    adopted: (n) => `conta atual registrada como '${n}'`,
    installing: 'instalando wrappers de shell...',
    installed: 'wrappers instalados',
    ready: (cmd) => `pronto! abra um shell novo e rode ${cmd}`,
  },
};

function normLang(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.startsWith('pt')) return 'pt';
  if (s.startsWith('en')) return 'en';
  return null;
}

function argLang() {
  const a = process.argv.slice(2);
  const i = a.findIndex((x) => x === '--lang' || x.startsWith('--lang='));
  if (i === -1) return null;
  const v = a[i].includes('=') ? a[i].split('=').slice(1).join('=') : a[i + 1];
  return normLang(v);
}

function detectLang() {
  const env = process.env.CLAUDE_ACCOUNTS_LANG || process.env.LC_ALL || process.env.LANG || '';
  const n = normLang(env);
  if (n) return n;
  try { return normLang(Intl.DateTimeFormat().resolvedOptions().locale) || 'en'; } catch { return 'en'; }
}

// Arrow-key selector matching the account menu style (accent pointer, ↑/↓/enter).
// Self-contained: the installer runs before the runtime core is fetched.
function selectTTY(title, items) {
  return new Promise((resolve) => {
    let idx = 0;
    let height = 0;
    const stdin = process.stdin;
    const out = process.stdout;

    const render = () => {
      const lines = ['', `  ${C.accent(C.bold(title))}`, ''];
      items.forEach((it, i) => {
        const sel = i === idx;
        const ptr = sel ? C.accent('❯') : ' ';
        const label = sel ? C.accent(C.bold(it.label)) : it.label;
        lines.push(`  ${ptr} ${label}`);
      });
      lines.push('');
      lines.push(`  ${C.dim('↑/↓ · enter · esc')}`);
      if (height > 0) out.write(`\x1b[${height}A`);
      out.write(lines.map((l) => `\r\x1b[2K${l}`).join('\n'));
      height = lines.length - 1;
    };

    const cleanup = () => {
      out.write(`\x1b[${height + 1}B\r\x1b[?25h\n`);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (buf) => {
      const s = buf.toString();
      if (s === '\x1b[A' || s === 'k') { idx = (idx - 1 + items.length) % items.length; render(); }
      else if (s === '\x1b[B' || s === 'j') { idx = (idx + 1) % items.length; render(); }
      else if (s === '\r' || s === '\n') { cleanup(); resolve(items[idx].value); }
      else if (s === '\x1b' || s === '\x03') { cleanup(); resolve(items[0].value); }
    };

    out.write('\x1b[?25l');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    render();
  });
}

async function chooseLang() {
  const explicit = argLang() || normLang(process.env.CLAUDE_ACCOUNTS_LANG);
  if (explicit) return explicit;
  if (process.stdin.isTTY) {
    return selectTTY('Escolha o idioma / Choose language', [
      { label: 'Português (BR)', value: 'pt' },
      { label: 'English', value: 'en' },
    ]);
  }
  return detectLang();
}

function writeConfig(lang) {
  fs.mkdirSync(CORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CORE_DIR, 'config.json'), JSON.stringify({ lang }, null, 2));
}

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

async function fetchAll(startLabel) {
  const files = [...CORE_FILES, ...WRAPPER_FILES];
  progress(0, files.length, startLabel);
  let i = 0;
  for (const rel of files) {
    const body = await httpGet(`${RAW}/${rel}`);
    const dest = path.join(CORE_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    i += 1;
    progress(i, files.length, rel);
  }
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
  const psEsc = (s) => String(s).replace(/'/g, "''"); // literal ' inside a PS single-quoted string
  try {
    const cur = cp.execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\')"', { encoding: 'utf8' }).trim();
    if (!cur.split(';').includes(binDir)) {
      cp.execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path','${psEsc(binDir)};${psEsc(cur)}','User')"`);
    }
    // Persist the resolved real-claude path so the cmd shim finds it in fresh
    // shells. The shim reads %CLAUDE_ACCOUNTS_REAL% and otherwise falls back to a
    // hardcoded path that usually does not exist, breaking every cmd invocation.
    cp.execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('CLAUDE_ACCOUNTS_REAL','${psEsc(real)}','User')"`);
  } catch (e) { console.error(`[claude-accounts] PATH update skipped: ${e.message}`); }
  // record real path for the cmd shim in the current process too
  process.env.CLAUDE_ACCOUNTS_REAL = real;
}

async function main() {
  const maj = Number(process.version.match(/^v(\d+)/)[1]);
  if (maj < 18) { console.error('Node >= 18 required'); process.exit(1); }
  logo();
  const lang = await chooseLang();
  const M = MSG[lang];
  writeConfig(lang);
  step(M.downloading);
  await fetchAll(M.starting);
  // Reuse the runtime resolver now that the core is fetched, so the installer
  // and the wrappers agree on the real binary (and both honor CLAUDE_ACCOUNTS_REAL).
  const { resolveRealClaude } = require(path.join(CORE_DIR, 'src', 'claude-path.js'));
  const real = resolveRealClaude();
  done(M.found(C.dim(real)));
  try {
    const adopted = require(path.join(CORE_DIR, 'src', 'vault.js')).adoptCurrent();
    if (adopted) done(M.adopted(adopted));
  } catch { /* no live login yet — first menu run will adopt */ }
  step(M.installing);
  if (process.platform === 'win32') {
    installWindows(real);
  } else {
    installUnix(real);
  }
  done(M.installed);
  const readyMsg = M.ready(C.accent('claude --accounts'));
  console.log(`\n  ${C.green('✓')} ${C.bold(readyMsg)}\n`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n  ${C.accent('✗')} ${e.message}\n`); process.exit(1); });
}

module.exports = { upsertBlock, backupThenWrite, normLang, detectLang, CORE_FILES };

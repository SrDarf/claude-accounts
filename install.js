#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const cp = require('node:child_process');

const RAW = 'https://raw.githubusercontent.com/SrDarf/claude-accounts/main';
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
    installWindows(real);
  } else {
    installUnix(real);
  }
  console.log('[claude-accounts] done. Open a new shell and run: claude --accounts');
}

if (require.main === module) {
  main().catch((e) => { console.error(`[claude-accounts] ${e.message}`); process.exit(1); });
}

module.exports = { upsertBlock, backupThenWrite, resolveRealClaude };

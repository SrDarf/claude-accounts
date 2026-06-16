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

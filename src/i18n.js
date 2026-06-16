'use strict';
const fs = require('node:fs');
const p = require('./paths.js');

// Runtime user-facing strings. Installer keeps its own table (runs pre-fetch).
const STRINGS = {
  en: {
    menuTitle: 'Claude Accounts',
    menuAdd: '+ add account',
    menuRemove: '- remove account',
    menuActive: 'active',
    menuHint: '↑/↓ move · enter switch · esc cancel',
    promptName: 'New account name: ',
    activeNow: (n) => `Active account: ${n}`,
    already: (n) => `Already on '${n}'.`,
    removed: (n) => `removed: ${n}`,
    nothingCaptured: 'Nothing captured (login aborted).',
    nothingShort: 'Nothing captured.',
    added: (n) => `Added: ${n}`,
    cancelled: 'Cancelled.',
    usageSwitch: 'usage: switch <name>',
    usageRemove: 'usage: remove <name>',
    unknown: (c) => `unknown subcommand: ${c}`,
    invalidName: (n) => `invalid name: '${n}'`,
    exists: (n) => `account '${n}' already exists`,
  },
  pt: {
    menuTitle: 'Claude Accounts',
    menuAdd: '+ adicionar conta',
    menuRemove: '- remover conta',
    menuActive: 'ativa',
    menuHint: '↑/↓ navegar · enter trocar · esc sair',
    promptName: 'Nome da nova conta: ',
    activeNow: (n) => `Conta ativa: ${n}`,
    already: (n) => `Ja na conta '${n}'.`,
    removed: (n) => `removida: ${n}`,
    nothingCaptured: 'Nada capturado (login abortado).',
    nothingShort: 'Nada capturado.',
    added: (n) => `Adicionada: ${n}`,
    cancelled: 'Cancelado.',
    usageSwitch: 'uso: switch <nome>',
    usageRemove: 'uso: remove <nome>',
    unknown: (c) => `subcomando desconhecido: ${c}`,
    invalidName: (n) => `nome invalido: '${n}'`,
    exists: (n) => `conta '${n}' ja existe`,
  },
};

function norm(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.startsWith('pt')) return 'pt';
  if (s.startsWith('en')) return 'en';
  return null;
}

function detectLocale() {
  const env = process.env.CLAUDE_ACCOUNTS_LANG || process.env.LC_ALL || process.env.LANG || '';
  const n = norm(env);
  if (n) return n;
  try {
    return norm(Intl.DateTimeFormat().resolvedOptions().locale) || 'en';
  } catch {
    return 'en';
  }
}

function lang() {
  const fromEnv = norm(process.env.CLAUDE_ACCOUNTS_LANG);
  if (fromEnv) return fromEnv;
  try {
    const c = JSON.parse(fs.readFileSync(p.configPath(), 'utf8'));
    const n = norm(c.lang);
    if (n) return n;
  } catch { /* no config -> default */ }
  return 'en';
}

function t(key, ...args) {
  const tbl = STRINGS[lang()] || STRINGS.en;
  let s = tbl[key];
  if (s === undefined) s = STRINGS.en[key];
  if (s === undefined) return key;
  return typeof s === 'function' ? s(...args) : s;
}

module.exports = { t, lang, norm, detectLocale, STRINGS };

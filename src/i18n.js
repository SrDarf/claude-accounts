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
    removeTitle: 'Remove account',
    removeHint: '↑/↓ move · enter remove · esc cancel',
    confirmRemove: (n) => `Remove '${n}'? This deletes its stored login.`,
    confirmHint: 'enter confirm · esc cancel',
    confirmYes: 'Yes, remove',
    confirmNo: 'No, keep it',
    nothingToRemove: 'No accounts to remove.',
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
    unknownVault: (n) => `unknown account in vault: '${n}'`,
    invalidName: (n) => `invalid name: '${n}'`,
    exists: (n) => `account '${n}' already exists`,
  },
  pt: {
    menuTitle: 'Claude Accounts',
    menuAdd: '+ adicionar conta',
    menuRemove: '- remover conta',
    menuActive: 'ativa',
    menuHint: '↑/↓ navegar · enter trocar · esc sair',
    removeTitle: 'Remover conta',
    removeHint: '↑/↓ navegar · enter remover · esc cancelar',
    confirmRemove: (n) => `Remover '${n}'? Isso apaga o login guardado.`,
    confirmHint: 'enter confirmar · esc cancelar',
    confirmYes: 'Sim, remover',
    confirmNo: 'Nao, manter',
    nothingToRemove: 'Nenhuma conta para remover.',
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
    unknownVault: (n) => `conta desconhecida no cofre: '${n}'`,
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

// The on-disk language never changes within a single CLI process, so read and
// parse config.json at most once instead of on every t() lookup (the menu render
// calls t() many times). The env var is still checked first and uncached, so it
// stays live.
let _cfgLang;
let _cfgRead = false;
function configLang() {
  if (_cfgRead) return _cfgLang;
  _cfgRead = true;
  try {
    _cfgLang = norm(JSON.parse(fs.readFileSync(p.configPath(), 'utf8')).lang);
  } catch {
    _cfgLang = null; // no config -> default
  }
  return _cfgLang;
}

function lang() {
  const fromEnv = norm(process.env.CLAUDE_ACCOUNTS_LANG);
  if (fromEnv) return fromEnv;
  return configLang() || 'en';
}

function t(key, ...args) {
  const tbl = STRINGS[lang()] || STRINGS.en;
  let s = tbl[key];
  if (s === undefined) s = STRINGS.en[key];
  if (s === undefined) return key;
  return typeof s === 'function' ? s(...args) : s;
}

module.exports = { t, lang, norm, STRINGS };

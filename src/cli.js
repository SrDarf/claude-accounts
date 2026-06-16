#!/usr/bin/env node
'use strict';
const vault = require('./vault.js');
const { switchAccount } = require('./switch.js');
const { t } = require('./i18n.js');

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
      if (!rest[0]) { console.error(t('usageSwitch')); return 2; }
      const r = switchAccount(rest[0]);
      console.log(r.switched ? t('activeNow', r.account) : t('already', r.account));
      return 0;
    }
    case 'remove': {
      if (!rest[0]) { console.error(t('usageRemove')); return 2; }
      const fs = require('node:fs');
      const p = require('./paths.js');
      fs.rmSync(p.slotDir(rest[0]), { recursive: true, force: true });
      console.log(t('removed', rest[0]));
      return 0;
    }
    case 'add': {
      const { addAccount } = require('./login.js');
      const name = rest[0] || await prompt(t('promptName'));
      const r = await addAccount(name, {});
      console.log(r.added ? t('added', name) : t('nothingCaptured'));
      return r.added ? 0 : 1;
    }
    case 'menu': {
      return runInteractiveMenu();
    }
    default:
      console.error(t('unknown', cmd || '(vazio)'));
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

function emailMap() {
  const m = {};
  for (const n of vault.list()) m[n] = vault.email(n);
  return m;
}

async function runInteractiveMenu() {
  const { runMenu } = require('./menu.js');
  const choice = await runMenu(vault.list(), vault.getCurrent(), emailMap());
  if (choice === null) { console.log(t('cancelled')); return 1; }
  if (choice === '__add__') {
    const { addAccount } = require('./login.js');
    const name = await prompt(t('promptName'));
    const r = await addAccount(name, {});
    if (!r.added) { console.log(t('nothingShort')); return 1; }
    switchAccount(name);
    console.log(t('activeNow', name));
    return 0;
  }
  if (choice === '__remove__') {
    const sub = await runMenu(vault.list(), vault.getCurrent(), emailMap());
    if (sub && sub !== '__add__' && sub !== '__remove__') {
      const fs = require('node:fs');
      const p = require('./paths.js');
      fs.rmSync(p.slotDir(sub), { recursive: true, force: true });
      console.log(t('removed', sub));
    }
    return 0;
  }
  const r = switchAccount(choice);
  console.log(r.switched ? t('activeNow', r.account) : t('already', r.account));
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => { console.error(`[claude-accounts] ${e.message}`); process.exit(1); });

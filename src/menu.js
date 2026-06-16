'use strict';
const { t } = require('./i18n.js');

// Claude-ish terracotta accent (truecolor). Falls back gracefully on terminals
// that ignore SGR — text still readable, just uncolored.
const ACCENT = '\x1b[38;2;215;119;87m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function accent(s) { return `${ACCENT}${s}${RESET}`; }
function accentBold(s) { return `${ACCENT}${BOLD}${s}${RESET}`; }
function dim(s) { return `${DIM}${s}${RESET}`; }

function buildItems(names, current, emails = {}) {
  const accounts = names.map((n) => ({
    label: n, value: n, current: n === current, email: emails[n] || '',
  }));
  return [
    ...accounts,
    { label: t('menuAdd'), value: '__add__', current: false, email: '' },
    { label: t('menuRemove'), value: '__remove__', current: false, email: '' },
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

function renderLines(items, idx) {
  const names = items.filter((it) => !it.value.startsWith('__'));
  const labelW = names.reduce((m, it) => Math.max(m, it.label.length), 0);
  const lines = ['', `  ${accentBold(t('menuTitle'))}`, ''];

  items.forEach((it, i) => {
    if (it.value === '__add__') lines.push('');
    const selected = i === idx;
    const pointer = selected ? accent('❯') : ' ';
    const isAction = it.value.startsWith('__');
    if (isAction) {
      const text = selected ? accent(it.label) : dim(it.label);
      lines.push(`  ${pointer} ${text}`);
    } else {
      const padded = it.label.padEnd(labelW);
      const label = selected ? accentBold(padded) : padded;
      const mail = it.email ? `  ${dim(it.email)}` : '';
      const tag = it.current ? `   ${accent(`● ${t('menuActive')}`)}` : '';
      lines.push(`  ${pointer} ${label}${mail}${tag}`);
    }
  });

  lines.push('');
  lines.push(`  ${dim(t('menuHint'))}`);
  return lines;
}

function runMenu(names, current, emails = {}) {
  return new Promise((resolve) => {
    const items = buildItems(names, current, emails);
    let state = { idx: Math.max(0, names.indexOf(current)), n: items.length };
    const out = process.stdout;
    const stdin = process.stdin;
    let height = 0;

    const render = () => {
      const lines = renderLines(items, state.idx);
      if (height > 0) out.write(`\x1b[${height}A`); // back to top of previous draw
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

    out.write('\x1b[?25l');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    render();
  });
}

module.exports = { buildItems, reduceKey, renderLines, runMenu };

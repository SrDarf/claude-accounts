'use strict';
const { t } = require('./i18n.js');

// Claude-ish terracotta accent (truecolor). Falls back gracefully on terminals
// that ignore SGR — text still readable, just uncolored.
const ACCENT = '\x1b[38;2;215;119;87m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function accent(s) { return `${ACCENT}${s}${RESET}`; }
function accentBold(s) { return `${ACCENT}${BOLD}${s}${RESET}`; }
function dim(s) { return `${DIM}${s}${RESET}`; }
function red(s) { return `${RED}${s}${RESET}`; }

function buildItems(names, current, emails = {}, withActions = true) {
  const accounts = names.map((n) => ({
    label: n, value: n, current: n === current, email: emails[n] || '',
  }));
  if (!withActions) return accounts;
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

function renderLines(items, idx, opts = {}) {
  const title = opts.title || t('menuTitle');
  const hint = opts.hint || t('menuHint');
  const danger = !!opts.danger;
  const names = items.filter((it) => !it.value.startsWith('__'));
  const labelW = names.reduce((m, it) => Math.max(m, it.label.length), 0);
  const lines = ['', `  ${danger ? red(title) : accentBold(title)}`, ''];

  items.forEach((it, i) => {
    if (it.value === '__add__') lines.push('');
    const selected = i === idx;
    const pointer = selected ? (danger ? red('❯') : accent('❯')) : ' ';
    const isAction = it.value.startsWith('__');
    if (isAction) {
      const text = selected ? accent(it.label) : dim(it.label);
      lines.push(`  ${pointer} ${text}`);
    } else {
      const padded = it.label.padEnd(labelW);
      const label = selected ? (danger ? red(padded) : accentBold(padded)) : padded;
      const mail = it.email ? `  ${dim(it.email)}` : '';
      const tag = it.current ? `   ${accent(`● ${t('menuActive')}`)}` : '';
      lines.push(`  ${pointer} ${label}${mail}${tag}`);
    }
  });

  lines.push('');
  lines.push(`  ${dim(hint)}`);
  return lines;
}

function keyOf(s) {
  if (s === '\x1b[A' || s === 'k') return 'up';
  if (s === '\x1b[B' || s === 'j') return 'down';
  if (s === '\r' || s === '\n') return 'enter';
  if (s === '\x1b' || s === '\x03') return 'escape';
  return null;
}

// Shared raw-mode interactive loop. `view()` returns the lines to draw; `onKey`
// returns { value } to finish (resolving with value) or a falsy value to keep
// going. On exit it drains any buffered keystrokes and restores the terminal,
// so a fast keypress can't leak an echoed escape sequence between two views.
function interact(view, onKey) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const stdin = process.stdin;
    let height = 0;

    const draw = () => {
      const lines = view();
      if (height > 0) out.write(`\x1b[${height}A`); // back to top of previous draw
      out.write(lines.map((l) => `\r\x1b[2K${l}`).join('\n'));
      height = lines.length - 1;
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      try { while (stdin.read() !== null) { /* drain buffered input */ } } catch (_) {}
      stdin.setRawMode(false);
      out.write(`\x1b[${height + 1}B\r\x1b[?25h\n`);
    };

    const onData = (buf) => {
      const key = keyOf(buf.toString());
      if (!key) return;
      const r = onKey(key);
      if (r && 'value' in r) { cleanup(); resolve(r.value); return; }
      draw();
    };

    out.write('\x1b[?25l');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    draw();
  });
}

// Account picker. opts: { title, hint, danger, withActions }. Defaults render the
// switch menu; pass withActions:false + danger:true for the remove picker.
function runMenu(names, current, emails = {}, opts = {}) {
  const items = buildItems(names, current, emails, opts.withActions !== false);
  let state = { idx: Math.max(0, names.indexOf(current)), n: items.length };
  return interact(
    () => renderLines(items, state.idx, opts),
    (key) => {
      state = reduceKey(state, key);
      if (state.done === 'select') return { value: items[state.idx].value };
      if (state.done === 'cancel') return { value: null };
      return null;
    },
  );
}

// Yes/no confirmation. Defaults to "no" and destructive (red) styling. Resolves
// true only on an explicit Yes; esc/ctrl-c resolve false.
function confirm(message, opts = {}) {
  const danger = opts.danger !== false;
  const labels = [t('confirmNo'), t('confirmYes')];
  let state = { idx: 0, n: labels.length }; // default to the safe choice
  const view = () => {
    const lines = ['', `  ${danger ? red(message) : accentBold(message)}`, ''];
    labels.forEach((label, i) => {
      const selected = i === state.idx;
      const pointer = selected ? (danger && i === 1 ? red('❯') : accent('❯')) : ' ';
      const text = !selected ? dim(label) : ((danger && i === 1) ? red(label) : accentBold(label));
      lines.push(`  ${pointer} ${text}`);
    });
    lines.push('');
    lines.push(`  ${dim(t('confirmHint'))}`);
    return lines;
  };
  // Same reducer the account menu uses; for a two-item list up/down just toggle.
  return interact(view, (key) => {
    state = reduceKey(state, key);
    if (state.done === 'select') return { value: state.idx === 1 };
    if (state.done === 'cancel') return { value: false };
    return null;
  });
}

module.exports = { buildItems, reduceKey, renderLines, runMenu, confirm };

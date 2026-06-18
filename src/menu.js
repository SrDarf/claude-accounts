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

// Two-tone bar: accent for the filled portion, dim for the rest. Claude's /usage
// look, scaled to fit beside an account row.
function bar(pct, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${ACCENT}${'█'.repeat(filled)}${RESET}${DIM}${'░'.repeat(width - filled)}${RESET}`;
}

// Compact relative reset, e.g. "42m", "3h09m", "5d 4h". Returns t('usageNow')
// once the window has rolled over.
function fmtReset(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return t('usageNow');
  const mins = Math.floor(d / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${String(mins % 60).padStart(2, '0')}m`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return `${days}d${remH ? ` ${remH}h` : ''}`;
}

// Inline usage segment drawn on the SAME line as the account, e.g.
//   5h ██████░░ 62% ·3h08m   7d █░░░░░░░ 6% ·6d
// `u` is the per-account result from usage.getAll; missing/failed accounts get a
// dim placeholder so the column stays aligned.
function usageInline(u) {
  if (!u) return '';
  if (!u.ok) return dim(t('usageUnavailable'));
  const seg = (label, lim) => {
    if (!lim) return '';
    const pct = Math.round(lim.pct);
    const pctStr = `${pct}%`.padStart(4);
    const pctCol = pct >= 90 ? red(pctStr) : accent(pctStr);
    const reset = lim.resetsAt ? ` ${dim(`·${fmtReset(lim.resetsAt)}`)}` : '';
    return `${dim(label)} ${bar(lim.pct, 8)} ${pctCol}${reset}`;
  };
  return [seg('5h', u.session), seg('7d', u.week)].filter(Boolean).join('   ');
}

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
  const usage = opts.usage || null;
  const names = items.filter((it) => !it.value.startsWith('__'));
  const labelW = names.reduce((m, it) => Math.max(m, it.label.length), 0);
  const mailW = names.reduce((m, it) => Math.max(m, (it.email || '').length), 0);
  // Reserve a fixed-width column for the active tag so the usage bars line up
  // whether or not a given row carries the "● active" badge.
  const tagPlain = `● ${t('menuActive')}`;
  // Use the padded (bar) layout for ALL rows whenever ANY account has usage, so a
  // row with empty/failed usage doesn't fall back to a narrower layout and misalign.
  const anyUsage = !!usage && names.some((it) => usageInline(usage[it.value]) !== '');
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
      const usageStr = usage ? usageInline(usage[it.value]) : '';
      if (anyUsage) {
        // Pad the name+email+tag block to a stable width so every row's bars
        // start at the same column.
        const mailCell = mailW ? `  ${dim((it.email || '').padEnd(mailW))}` : '';
        const tagCell = `   ${it.current ? accent(tagPlain) : ' '.repeat(tagPlain.length)}`;
        lines.push(`  ${pointer} ${label}${mailCell}${tagCell}   ${usageStr}`);
      } else {
        const mail = it.email ? `  ${dim(it.email)}` : '';
        const tag = it.current ? `   ${accent(tagPlain)}` : '';
        lines.push(`  ${pointer} ${label}${mail}${tag}`);
      }
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

module.exports = { buildItems, reduceKey, renderLines, runMenu, confirm, bar, fmtReset, usageInline };

import { readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isStatePath } from './store.mjs';
import { blocked, within } from './workspace.mjs';

export async function completeReference(root, base, line) {
  const reference = /(?:^|\s)(@(?:"[^"]*|'[^']*|[^\s"'@]*))$/.exec(line)?.[1];
  if (!reference) return [[], line];
  const input = reference.slice(1).replace(/^["']/, '').replaceAll('\\', '/');
  const last = input.lastIndexOf('/') + 1;
  const directory = input.slice(0, last);
  const stem = input.slice(last);
  const target = resolve(base, directory || '.');
  if (!within(root, target) || blocked(target.slice(root.length)) || isStatePath(target)) return [[], reference];
  try {
    if (await realpath(target) !== target) return [[], reference];
    const caseFold = process.platform === 'win32' || process.platform === 'darwin';
    const comparable = text => caseFold ? text.toLowerCase() : text;
    const entries = await readdir(target, { withFileTypes: true });
    const matches = entries.filter(entry => {
      const visible = stem.startsWith('.') || !entry.name.startsWith('.');
      return visible && !blocked(entry.name) && !isStatePath(join(target, entry.name)) && (entry.isDirectory() || entry.isFile()) &&
        comparable(entry.name).startsWith(comparable(stem));
    }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60).map(entry => {
      const path = (directory + entry.name).split(sep).join('/') + (entry.isDirectory() ? '/' : '');
      const quote = reference[1] === "'" || path.includes('"') ? "'" : '"';
      if (path.includes(quote)) return null;
      const quoted = reference[1] === '"' || reference[1] === "'" || /[\s"']/.test(path);
      return '@' + (quoted ? quote + path + (entry.isDirectory() ? '' : quote) : path);
    }).filter(Boolean);
    return [matches, reference];
  } catch {
    return [[], reference];
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const doubleWidth = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Emoji_Presentation}\p{Regional_Indicator}\ufe0f\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;

function* columns(text) {
  let column = 0;
  const safe = text.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '');
  for (const { segment } of graphemes.segment(safe)) {
    const width = segment === '\t' ? 4 - column % 4 : doubleWidth.test(segment) ? 2 : /^\p{Mark}+$/u.test(segment) ? 0 : 1;
    const display = segment === '\t' ? ' '.repeat(width) : segment;
    yield { text: display, start: column, width };
    column += width;
  }
}

export function terminalWidth(text) {
  let width = 0;
  for (const part of columns(text)) width += part.width;
  return width;
}

export function terminalClip(text, width, offset = 0) {
  if (width <= 0) return '';
  if (offset && width === 1) return '…';
  const prefix = offset ? '…' : '';
  const visible = [];
  let used = prefix.length;
  for (const part of columns(text)) {
    if (part.start < offset) continue;
    if (used + part.width > width) {
      while (visible.length && used > width - 1) used -= visible.pop().width;
      return (prefix + visible.map(item => item.text).join('') + '…');
    }
    visible.push(part);
    used += part.width;
  }
  return prefix + visible.map(item => item.text).join('');
}

export function pageKey(name, pageSize, rows) {
  return {
    up: -1,
    down: 1,
    pageup: -pageSize,
    pagedown: pageSize,
    home: -rows,
    end: rows,
  }[name];
}

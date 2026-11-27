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

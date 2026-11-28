import { maxDraftLength } from './draft.mjs';

export class DraftEdits {
  constructor() {
    this.before = [];
    this.after = [];
  }

  change(current, action, index, text) {
    if (action === 'undo') return this.move(current, this.before, this.after);
    if (action === 'redo') return this.move(current, this.after, this.before);
    const lines = current.slice();
    if (action === 'dedent') {
      const sizes = lines.filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)[0].length);
      const width = sizes.length ? Math.min(...sizes) : 0;
      for (const [index, line] of lines.entries()) lines[index] = line.trim() ? line.slice(width) : '';
    } else {
      const at = Number(index) - 1;
      if (!Number.isInteger(at) || at < 0 || at >= lines.length + Number(action === 'insert'))
        throw new Error('Choose a valid draft line number.');
      if (action === 'set') lines[at] = text;
      else if (action === 'insert') lines.splice(at, 0, text);
      else if (action === 'drop') lines.splice(at, 1);
      else throw new Error('Use set, insert, drop, dedent, undo or redo.');
    }
    if (lines.join('\n').length > maxDraftLength) throw new Error('Draft exceeds 32,000 characters.');
    this.remember(current);
    return lines;
  }

  remember(lines) {
    this.before.push(lines.slice());
    if (this.before.length > 20) this.before.shift();
    this.after.length = 0;
  }

  move(lines, from, to) {
    if (!from.length) throw new Error('No draft edit to restore.');
    to.push(lines.slice());
    return from.pop();
  }
}

export function keyBindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Key bindings must be a JSON object.');
  const pairs = Object.entries(value);
  if (pairs.length > 16 || pairs.some(([key, command]) =>
    !/^alt\+[cdgiklmpqrstuvwyz]$/.test(key) || typeof command !== 'string' || !/^\/[a-z-]+(?: [^\r\n\x00-\x1f]{1,200})?$/.test(command)))
    throw new Error('Bind up to 16 available Alt keys to single-line chat commands.');
  return Object.fromEntries(pairs);
}

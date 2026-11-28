import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { decodeText, loadBytes, replaceText } from './workspace.mjs';
import { lock, sessionsDir } from './store.mjs';

const maxFile = 256 * 1024;
const maxReview = 1024 * 1024;

export class ReviewRequired extends Error {
  constructor(id) {
    super('Change set ' + id + ' is ready for review.');
    this.id = id;
  }
}

async function statOrMissing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function location(project, path) {
  if (typeof path !== 'string' || !path || path.length > 500 || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\\:\x00-\x1f*?"<>|]|[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error('Use a canonical workspace-relative path with forward slashes.');
  return project.scope(path);
}

async function parents(project, path, create, created) {
  const steps = path.split('/').slice(0, -1);
  let dir = project.root;
  for (const part of steps) {
    dir = join(dir, part);
    let info = await statOrMissing(dir);
    if (!info && create) {
      try {
        await mkdir(dir);
        created.push(dir);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      info = await statOrMissing(dir);
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir))
      throw new Error('Parent directory is outside the workspace, a symbolic link, or blocked by a file: ' + path);
    if (!info) break;
  }
}

async function snapshot(project, path, signal) {
  signal?.throwIfAborted();
  const absolute = location(project, path);
  await parents(project, path);
  const info = await statOrMissing(absolute);
  if (!info) return { text: null, mode: null };
  if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute)
    throw new Error('Select a regular workspace file: ' + path);
  const bytes = await loadBytes(absolute, maxFile, signal);
  decodeText(bytes);
  return { text: bytes.toString('utf8'), mode: process.platform === 'win32' ? null : info.mode & 0o777 };
}

export async function prepareReview(project, operations, readPaths, signal) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 40)
    throw new Error('Propose between 1 and 40 file operations.');
  const files = new Map();
  const find = async path => {
    location(project, path);
    const key = process.platform === 'linux' ? path : path.toLowerCase();
    if (files.has(key)) {
      const file = files.get(key);
      if (file.path !== path) throw new Error('Paths differ only by letter case: ' + path);
      return file;
    }
    const { text, mode } = await snapshot(project, path, signal);
    const file = { path, before: text, after: text, beforeMode: mode, afterMode: mode };
    files.set(key, file);
    if (files.size > 20) throw new Error('A change set can contain at most 20 files.');
    return file;
  };
  const requireRead = file => {
    if (file.after === null) throw new Error('File does not exist: ' + file.path);
    if (file.before !== null && !readPaths?.includes(file.path))
      throw new Error('Read the existing file before changing it: ' + file.path);
  };
  const defaultMode = process.platform === 'win32' ? null : 0o666 & ~process.umask();
  for (const operation of operations) {
    signal?.throwIfAborted();
    const { path, action, oldText, newText, to, startLine } = operation ?? {};
    const file = await find(path);
    switch (action) {
      case 'create':
        if (file.after !== null || file.move) throw new Error('File already exists or is part of a move: ' + path);
        if (typeof newText !== 'string' || newText.includes('\0') || !newText.isWellFormed() || Buffer.byteLength(newText) > maxFile)
          throw new Error('New files must be UTF-8 text up to 256 KiB.');
        file.after = newText;
        file.afterMode = file.beforeMode ?? defaultMode;
        break;
      case 'replace':
        requireRead(file);
        file.after = replaceText(Buffer.from(file.after), oldText, newText, maxFile, startLine).output;
        break;
      case 'delete':
        requireRead(file);
        if (file.move) throw new Error('File is already part of a move: ' + path);
        file.after = null;
        file.afterMode = null;
        break;
      case 'move': {
        requireRead(file);
        const destination = await find(to);
        if (file.move || file.before === null || destination.before !== null || destination.after !== null || destination.move)
          throw new Error('Move an existing file to a new, unused path.');
        destination.after = file.after;
        destination.afterMode = file.afterMode;
        destination.move = { from: file.path };
        file.move = { to: destination.path };
        file.after = null;
        file.afterMode = null;
        break;
      }
      default: throw new Error('Use create, replace, delete or move.');
    }
  }
  const changed = [...files.values()].filter(file => file.before !== file.after || file.beforeMode !== file.afterMode);
  const paths = changed.map(file => file.path);
  if (!paths.length) throw new Error('The proposal does not change any files.');
  const comparable = paths.map(path => process.platform === 'linux' ? path : path.toLowerCase());
  if (comparable.some(path => comparable.some(other => other.startsWith(path + '/'))))
    throw new Error('A file path is also used as a directory in this change set.');
  if (changed.reduce((size, file) => size + Buffer.byteLength(file.before ?? '') + Buffer.byteLength(file.after ?? ''), 0) > maxReview)
    throw new Error('The combined before-and-after contents exceed 1 MiB.');
  return { id: randomUUID().slice(0, 8), files: changed, state: 'pending' };
}

function side(file, key) {
  const text = file[key];
  const mode = text === null ? null : file[key + 'Mode'] ?? file.mode ?? null;
  return { text, mode };
}

function matches(current, expected) {
  return current.text === expected.text && (expected.mode === null || current.mode === expected.mode);
}

export function selectedFiles(review, paths = []) {
  if (review.state === 'applying' && review.selection) {
    const saved = review.files.filter(file => review.selection.includes(file.path));
    if (!paths.length) return saved;
    const requested = choose(review.files, paths);
    if (requested.length !== saved.length || requested.some(file => !saved.includes(file)))
      throw new Error('This apply must resume with its original file selection.');
    return saved;
  }
  return choose(review.files, paths);
}

function choose(files, paths) {
  if (!paths.length) return files;
  const selected = new Set();
  for (const path of paths) {
    const file = files.find(item => item.path === path);
    if (!file) throw new Error('No pending change for ' + path);
    selected.add(path);
    if (file.move) selected.add(file.move.from ?? file.move.to);
  }
  return files.filter(file => selected.has(file.path));
}

async function write(project, file, target, expected, created) {
  const path = location(project, file.path);
  await parents(project, file.path, expected.text === null, created);
  if (target.text === null) {
    if (!matches(await snapshot(project, file.path), expected))
      throw new Error('File changed while applying the proposal: ' + file.path);
    await unlink(path);
    return;
  }
  const temporary = join(dirname(path), '.xcode-change-' + randomUUID());
  const mode = target.mode ?? 0o666;
  const handle = await open(temporary, 'wx', mode);
  try {
    try {
      await handle.writeFile(target.text);
      if (target.mode !== null) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const latest = await snapshot(project, file.path);
    if (!matches(latest, expected)) throw new Error('File changed while applying the proposal: ' + file.path);
    if (expected.text === null) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function ownHunks(review, path) {
  return review.hunkSelections && Object.hasOwn(review.hunkSelections, path) ? review.hunkSelections[path] : undefined;
}

export function appliedReviewFiles(review, paths = []) {
  return selectedFiles(review, paths).map(file => {
    const chosen = ownHunks(review, file.path);
    if (!chosen) return file;
    const ops = diffOperations(textLines(file.before), textLines(file.after));
    const ranges = diffRanges(ops);
    const selected = new Set(chosen);
    const output = [];
    let current = 0;
    for (const [index, [sign, text]] of ops.entries()) {
      while (current < ranges.length && index >= ranges[current].end) current++;
      const take = selected.has(current + 1) && index >= (ranges[current]?.start ?? Infinity);
      if (sign === ' ' || (take ? sign === '+' : sign === '-')) output.push(text);
    }
    return { ...file, after: output.join('') };
  });
}

export function reviewHunks(review, path) {
  const file = review.files.find(file => file.path === path);
  if (!file || file.before === null || file.after === null || file.move)
    throw new Error('Select a modified text file. Created, deleted and moved files are selected as a whole.');
  const ops = diffOperations(textLines(file.before), textLines(file.after));
  return hunks(ops).filter(line => line.startsWith('@@ '));
}

export function chooseHunks(review, path, values) {
  if (review.state === 'applying') throw new Error('Finish the interrupted apply before changing hunk selection.');
  const count = reviewHunks(review, path).length;
  const choices = [...new Set(values.map(Number))];
  const reset = values.length === 1 && values[0] === 'all';
  if (!reset && (!choices.length || choices.some(index => !Number.isInteger(index) || index < 1 || index > count)))
    throw new Error('Select hunk numbers from 1 to ' + count + ', or all.');
  const selections = { ...review.hunkSelections };
  if (reset) delete selections[path];
  review.hunkSelections = reset ? selections : { ...selections, [path]: choices };
}

async function inspectReview(project, files, recovery) {
  const applied = [];
  const conflicts = [];
  for (const file of files) {
    const before = side(file, 'before');
    let current;
    try {
      current = await snapshot(project, file.path);
    } catch {
      conflicts.push({ path: file.path, reason: 'File cannot be read as a regular workspace file' });
      continue;
    }
    if (matches(current, before)) continue;
    if (recovery && matches(current, side(file, 'after'))) {
      applied.push(file);
      continue;
    }
    const reason = current.text === null ? 'File was removed' :
      before.text === null ? 'Target already exists' :
      current.text !== before.text ? 'Contents changed' : 'Permissions changed';
    conflicts.push({ path: file.path, reason });
  }
  return { applied, conflicts };
}

export async function reviewConflicts(project, review, paths = []) {
  return (await inspectReview(project, appliedReviewFiles(review, paths), review.state === 'applying')).conflicts;
}

export async function reviewRecovery(project, review) {
  const files = appliedReviewFiles(review);
  const status = await inspectReview(project, files, review.state === 'applying');
  const conflicts = new Map(status.conflicts.map(item => [item.path, item.reason]));
  const applied = new Set(status.applied.map(file => file.path));
  return files.map(file => ({ path: file.path, state: conflicts.has(file.path) ? 'conflict' : applied.has(file.path) ? 'applied' : 'pending',
    ...(conflicts.has(file.path) ? { reason: conflicts.get(file.path) } : {}) }));
}

export function conflictSummary(conflicts) {
  if (!conflicts.length) return '';
  return 'Files changed after the proposal was prepared:\n' +
    conflicts.map(({ path, reason }) => '  ' + path + ' · ' + reason).join('\n');
}

export async function applyReview(project, review, save, paths = []) {
  const key = createHash('sha256').update(process.platform === 'win32' ? project.root.toLowerCase() : project.root).digest('hex').slice(0, 24);
  const files = appliedReviewFiles(review, paths);
  const unlock = await lock(sessionsDir, 'workspace-' + key);
  const recovery = review.state === 'applying';
  let applied;
  const created = [];
  try {
    const inspection = await inspectReview(project, files, recovery);
    if (inspection.conflicts.length) throw new Error(conflictSummary(inspection.conflicts));
    applied = inspection.applied;
    review.state = 'applying';
    review.selection = files.map(file => file.path);
    await save();
    for (const file of files) {
      if (applied.includes(file)) continue;
      await write(project, file, side(file, 'after'), side(file, 'before'), created);
      applied.push(file);
    }
    return review.selection;
  } catch (error) {
    if (!applied) throw error;
    const failures = [];
    for (const file of applied.reverse()) {
      try {
        await write(project, file, side(file, 'before'), side(file, 'after'), created);
      } catch (cause) {
        failures.push(cause.message);
      }
    }
    for (const dir of created.reverse()) {
      await rmdir(dir).catch(cause => {
        if (cause.code !== 'ENOENT' && cause.code !== 'ENOTEMPTY') failures.push(cause.message);
      });
    }
    // Preserve the approved journal if an interrupted apply was not fully checked.
    if (!failures.length && !recovery) {
      review.state = 'pending';
      delete review.selection;
      await save();
    }
    if (failures.length || recovery)
      throw new Error(error.message + '\nReview ' + review.id + ' is retained for recovery.' +
        (failures.length ? '\nRollback issues: ' + failures.join('; ') : ''));
    throw error;
  } finally {
    await unlock();
  }
}

export function inverseReview(change) {
  return {
    id: change.id,
    state: 'pending',
    files: change.files.map(file => ({
      path: file.path,
      before: file.after,
      beforeMode: side(file, 'after').mode,
      after: file.before,
      afterMode: side(file, 'before').mode,
    })),
  };
}

function textLines(text) {
  return text?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffOperations(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < Math.min(before.length, after.length) - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  const left = before.slice(head, before.length - tail);
  const right = after.slice(head, after.length - tail);
  const ops = before.slice(0, head).map(line => [' ', line]);
  const width = right.length + 1;
  // Bound the LCS table. Oversized replacements still show all changed text.
  const table = left.length && right.length && (left.length + 1) * width <= 300000
    ? new Uint16Array((left.length + 1) * width) : null;
  if (table) {
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        const at = i * width + j;
        table[at] = left[i] === right[j] ? 1 + table[at + width + 1] :
          Math.max(table[at + width], table[at + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      const at = i * width + j;
      if (i < left.length && j < right.length && left[i] === right[j]) {
        ops.push([' ', left[i++]]);
        j++;
      } else if (i < left.length && (j === right.length || table[at + width] >= table[at + 1])) {
        ops.push(['-', left[i++]]);
      } else {
        ops.push(['+', right[j++]]);
      }
    }
  } else {
    for (const line of left) ops.push(['-', line]);
    for (const line of right) ops.push(['+', line]);
  }
  for (const line of before.slice(before.length - tail)) ops.push([' ', line]);
  return ops;
}

function diffRanges(ops) {
  const ranges = [];
  for (let at = 0; at < ops.length; at++) {
    if (ops[at][0] === ' ') continue;
    const start = Math.max(0, at - 3);
    const end = Math.min(ops.length, at + 4);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = end;
    else ranges.push({ start, end });
  }
  return ranges;
}

function hunks(ops) {
  const ranges = diffRanges(ops);
  const output = [];
  let index = 0, oldBase = 0, newBase = 0;
  for (const { start, end } of ranges) {
    for (; index < start; index++) {
      oldBase += Number(ops[index][0] !== '+');
      newBase += Number(ops[index][0] !== '-');
    }
    const rows = ops.slice(start, end);
    const oldCount = rows.filter(([sign]) => sign !== '+').length;
    const newCount = rows.filter(([sign]) => sign !== '-').length;
    output.push('@@ -' + (oldBase + Number(oldCount > 0)) + ',' + oldCount +
      ' +' + (newBase + Number(newCount > 0)) + ',' + newCount + ' @@');
    for (const [prefix, line] of rows) {
      output.push(prefix + line.replace(/\n$/, '').replace(/\r/g, '␍'));
      if (!line.endsWith('\n')) output.push('\\ No newline at end of file');
    }
  }
  return output;
}

export function reviewDiff(review, filePath) {
  const files = filePath ? choose(review.files, [filePath]) : review.files;
  return files.flatMap(file => [
    ...(file.move?.to ? ['rename ' + file.path + ' → ' + file.move.to] :
      file.move?.from ? ['rename ' + file.move.from + ' → ' + file.path] : []),
    '--- ' + (file.before === null ? '/dev/null' : file.path),
    '+++ ' + (file.after === null ? '/dev/null' : file.path),
    ...hunks(diffOperations(textLines(file.before), textLines(file.after))),
    '',
  ]);
}

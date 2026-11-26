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
  for (const operation of operations) {
    signal?.throwIfAborted();
    const { path, action, oldText, newText } = operation ?? {};
    location(project, path);
    const key = process.platform === 'linux' ? path : path.toLowerCase();
    let file = files.get(key);
    if (file && file.path !== path) throw new Error('Paths differ only by letter case: ' + path);
    if (!file) {
      const { text, mode } = await snapshot(project, path, signal);
      file = { path, before: text, after: text, mode };
      files.set(key, file);
      if (files.size > 20) throw new Error('A change set can contain at most 20 files.');
    }
    if (action === 'create') {
      if (file.after !== null) throw new Error('File already exists: ' + path);
      if (typeof newText !== 'string' || newText.includes('\0') || !newText.isWellFormed() || Buffer.byteLength(newText) > maxFile)
        throw new Error('New files must be UTF-8 text up to 256 KiB.');
      file.after = newText;
    } else if (action === 'replace') {
      if (file.after === null) throw new Error('File does not exist: ' + path);
      if (file.before !== null && !readPaths?.includes(path))
        throw new Error('Read the existing file before replacing text: ' + path);
      file.after = replaceText(Buffer.from(file.after), oldText, newText, maxFile).output;
    } else {
      throw new Error('Use the create or replace action.');
    }
  }
  const changed = [...files.values()].filter(file => file.before !== file.after);
  const paths = changed.map(file => file.path);
  if (!paths.length) throw new Error('The proposal does not change any files.');
  if (paths.some(path => paths.some(other => other.startsWith(path + '/'))))
    throw new Error('A file path is also used as a directory in this change set.');
  if (changed.reduce((size, file) => size + Buffer.byteLength(file.before ?? '') + Buffer.byteLength(file.after), 0) > maxReview)
    throw new Error('The combined before-and-after contents exceed 1 MiB.');
  return { id: randomUUID().slice(0, 8), files: changed, state: 'pending' };
}

function expect(current, file, recovery) {
  if (current.text === file.before && current.mode === file.mode) return 'original';
  if (recovery && current.text === file.after && (file.before === null || current.mode === file.mode)) return 'applied';
  throw new Error('File changed after the proposal was prepared: ' + file.path);
}

async function write(project, file, content, current, options) {
  const path = location(project, file.path);
  await parents(project, file.path, current === null, options.created);
  if (content === null) {
    const latest = await snapshot(project, file.path);
    if (latest.text !== current) throw new Error('Cannot roll back a file changed outside xcode: ' + file.path);
    await unlink(path);
    return;
  }
  const temporary = join(dirname(path), '.xcode-change-' + randomUUID());
  const mode = file.mode ?? 0o666;
  const handle = await open(temporary, 'wx', mode);
  try {
    try {
      await handle.writeFile(content);
      if (file.mode !== null) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const latest = await snapshot(project, file.path);
    if (latest.text !== current || (current !== null && file.before !== null && latest.mode !== file.mode))
      throw new Error('File changed while applying the proposal: ' + file.path);
    if (current === null) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function applyReview(project, review, save) {
  const key = createHash('sha256').update(process.platform === 'win32' ? project.root.toLowerCase() : project.root).digest('hex').slice(0, 24);
  const unlock = await lock(sessionsDir, 'workspace-' + key);
  const recovery = review.state === 'applying';
  const applied = [];
  const created = [];
  try {
    for (const file of review.files) {
      if (expect(await snapshot(project, file.path), file, recovery) === 'applied') applied.push(file);
    }
    review.state = 'applying';
    await save();
    for (const file of review.files) {
      if (applied.includes(file)) continue;
      await write(project, file, file.after, file.before, { created });
      applied.push(file);
    }
    return review.files.map(file => file.path);
  } catch (error) {
    const failures = [];
    for (const file of applied.reverse()) {
      try {
        await write(project, file, file.before, file.after, { created });
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

export function reviewDiff(review, filePath) {
  const files = filePath ? review.files.filter(file => file.path === filePath) : review.files;
  if (!files.length) throw new Error('No pending change for ' + filePath);
  const lines = text => text?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const display = (line, prefix) => {
    const body = prefix + line.replace(/\n$/, '').replace(/\r/g, '␍');
    return line.endsWith('\n') ? [body] : [body, '\\ No newline at end of file'];
  };
  return files.flatMap(file => {
    const before = lines(file.before);
    const after = lines(file.after);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < Math.min(before.length, after.length) - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
    const start = Math.max(0, head - 3);
    const trailing = Math.min(3, tail);
    const oldEnd = before.length - tail;
    const newEnd = after.length - tail;
    return [
      '--- ' + (file.before === null ? '/dev/null' : file.path),
      '+++ ' + file.path,
      '@@ -' + (before.length ? start + 1 : 0) + ',' + (oldEnd - start + trailing) +
        ' +' + (start + 1) + ',' + (newEnd - start + trailing) + ' @@',
      ...before.slice(start, head).flatMap(line => display(line, ' ')),
      ...before.slice(head, oldEnd).flatMap(line => display(line, '-')),
      ...after.slice(head, newEnd).flatMap(line => display(line, '+')),
      ...after.slice(newEnd, newEnd + trailing).flatMap(line => display(line, ' ')),
      '',
    ];
  });
}

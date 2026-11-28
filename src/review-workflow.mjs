import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appliedReviewFiles, asGitPatch, chooseHunks } from './changes.mjs';
import { note } from './session-organize.mjs';
import { verifiedFile } from './workspace.mjs';
import { loadBytes } from './workspace.mjs';

const git = promisify(execFile);

export function addReviewComment(review, path, line, value) {
  if (review.state === 'applying' || !review.files.some(file => file.path === path)) throw new Error('Choose an editable proposal file.');
  const number = Number(line);
  if (!Number.isSafeInteger(number) || number < 1 || !value.trim()) throw new Error('Provide a positive source line and review note.');
  if ((review.comments?.length ?? 0) >= 80) throw new Error('Maximum 80 notes per review.');
  review.comments = [...(review.comments ?? []), { path, line: number, text: note(value, 400) }];
}

export function addReviewGroup(review, values) {
  if (review.state === 'applying' || values.length < 2) throw new Error('Choose at least two pending files to approve together.');
  const group = [...new Set(values.map(value => value.split('#hunks=')[0]))];
  if (group.length < 2 || !group.every(path => review.files.some(file => file.path === path))) throw new Error('Unknown file in review group.');
  const preview = { ...review };
  for (const value of values) {
    const [path, hunks] = value.split('#hunks=');
    if (hunks) chooseHunks(preview, path, hunks.split(','));
  }
  review.hunkSelections = preview.hunkSelections;
  review.groups = [...(review.groups ?? []), group];
}

export function effectiveChange(change) {
  const inverse = change.reversals?.flatMap(entry => entry.files) ??
    (change.undoneAt ? change.files.map(file => ({ path: file.path, after: file.before, afterMode: file.beforeMode })) : []);
  const timeline = new Map(inverse.map(file => [file.path, file]));
  return change.files.map(file => {
    const state = timeline.get(file.path);
    return state ? { ...file, after: state.after, afterMode: state.afterMode } : file;
  });
}

export function reversalFor(change, operation, selections = []) {
  const current = new Map(effectiveChange(change).map(file => [file.path, file]));
  const redo = operation === 'redo';
  const files = change.files.flatMap(file => {
    const latest = current.get(file.path);
    const after = redo ? file.after : file.before;
    const afterMode = (redo ? file.afterMode : file.beforeMode) ?? file.mode ?? null;
    const beforeMode = latest.afterMode ?? latest.mode ?? null;
    if (latest.after === after && beforeMode === afterMode) return [];
    return [{ path: file.path, before: latest.after, beforeMode, after, afterMode,
      ...(file.move ? { move: file.move } : {}) }];
  });
  if (!files.length) throw new Error('No eligible files to ' + operation + '.');
  const review = { id: change.id, state: 'pending', operation, files, groups: change.groups };
  for (const value of selections) {
    const [path, hunks] = value.split('#hunks=');
    if (hunks) chooseHunks(review, path, hunks.split(','));
  }
  const chosen = selections.map(value => value.split('#hunks=')[0]);
  if (chosen.length) review.files = appliedReviewFiles(review, chosen).map(file => files.find(item => item.path === file.path));
  return review;
}

export async function threeWay(root, review, path) {
  const file = appliedReviewFiles(review, [path]).find(file => file.path === path);
  if (!file || file.before === null || file.after === null) throw new Error('Choose an edited file for three-way preview.');
  const current = await verifiedFile(root, path);
  const text = await loadBytes(current.path, 256 * 1024);
  const temp = await mkdtemp(join(tmpdir(), 'xcode-merge-preview-'));
  try {
    for (const [name, contents] of [['current', text], ['base', file.before], ['proposal', file.after]])
      await writeFile(join(temp, name), contents, { mode: 0o600 });
    try {
      const result = await git('git', ['merge-file', '-p', '--diff3', '-L', 'current', '-L', 'base', '-L', 'proposal',
        'current', 'base', 'proposal'], { cwd: temp, maxBuffer: 1024 * 1024, timeout: 12000 });
      return { conflicts: false, text: result.stdout };
    } catch (error) {
      if (Number.isInteger(error.code) && error.code > 0 && error.code < 128 && typeof error.stdout === 'string' && error.stdout.includes('<<<<<<<'))
        return { conflicts: true, text: error.stdout };
      throw new Error('Could not build a local merge preview.');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function reviewReport(review, checks = []) {
  const selected = new Set((review.markedPaths?.length === 0 ? [] : appliedReviewFiles(review, review.markedPaths ?? [])).map(file => file.path));
  return ['# ' + (review.label ?? 'Change ' + review.id), review.description ?? '',
    ...review.files.map(file => '- ' + file.path + ' · ' + (selected.has(file.path) ? 'selected' : 'held')),
    ...((review.comments ?? []).map(item => '- ' + item.path + ':' + item.line + ' · ' + item.text)),
    ...checks.map(item => '- Check ' + item.name + ' · ' + item.status)].filter(Boolean).join('\n');
}

export async function gitChange(root, change, { stage, worktree, branch }) {
  const directory = await mkdtemp(join(tmpdir(), 'xcode-approved-change-'));
  const patch = join(directory, 'change.patch');
  const run = (cwd, args) => git('git', args, { cwd, maxBuffer: 1024 * 1024, timeout: 30000 });
  try {
    await writeFile(patch, asGitPatch(change.files), { mode: 0o600 });
    if (stage) {
      await run(root, ['apply', '--cached', '--check', patch]);
      await run(root, ['apply', '--cached', patch]);
    } else {
      const target = resolve(root, worktree);
      if (!branch) throw new Error('Choose a branch name with --branch.');
      await run(root, ['check-ref-format', '--branch', branch]);
      await run(root, ['worktree', 'add', '-b', branch, '--', target, 'HEAD']);
      await run(target, ['apply', '--check', patch]).catch(() => {
        throw new Error('The new worktree was created, but its base conflicts with the approved patch.');
      });
      await run(target, ['apply', patch]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function patchCheck(root, input) {
  const file = resolve(input);
  await loadBytes(file, 1024 * 1024);
  const options = { cwd: root, maxBuffer: 512 * 1024, timeout: 15000 };
  const preview = await git('git', ['apply', '--stat', '--', file], options);
  try {
    await git('git', ['apply', '--check', '--', file], options);
    return { applicable: true, preview: preview.stdout };
  } catch (error) {
    return { applicable: false, preview: preview.stdout, reason: error.stderr?.slice(0, 2500) };
  }
}

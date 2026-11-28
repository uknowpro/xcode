import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, lstat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJson, saveJson, storage } from './store.mjs';
import { readText, verifiedFile, Workspace, within } from './workspace.mjs';

const git = promisify(execFile);
const source = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|cs|cpp|c|h)$/i;
const declared = /^\s*(?:(?:export|default|public|private|protected|async|static|final)\s+)*(?:class|interface|def|func|fn|function|type|enum|struct|record|const|let|var)\s+([\w$]+)/;
const packagePath = file => file === 'package.json' || file.endsWith('/package.json');
const slash = path => path.replaceAll('\\', '/');

export async function gitWork(root, args, signal) {
  const { stdout } = await git('git', args, { cwd: root, signal, maxBuffer: 2 * 1024 * 1024, timeout: 15000 });
  return stdout;
}

export async function updateSourceIndex(root, signal) {
  const folder = join(storage, 'indexes');
  const file = join(folder, createHash('sha256').update(root).digest('hex') + '.json');
  const cache = await readJson(file, {}).catch(() => ({}));
  const paths = (await new Workspace(root).files(signal)).files.filter(file => source.test(file) && !/\.min\.js$/i.test(file)).slice(0, 3000);
  const records = [];
  let revised = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const stat = await lstat(resolve(root, path)).catch(() => null);
    if (!stat?.isFile() || stat.size > 256 * 1024) continue;
    const stamp = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
    const item = Object.hasOwn(cache, path) ? cache[path] : undefined;
    if (item?.stamp === stamp) { records.push([path, item]); continue; }
    const text = await readText(root, path, signal, 256 * 1024).catch(() => '');
    const symbols = [];
    for (const [line, row] of text.split('\n').entries()) {
      const name = declared.exec(row)?.[1];
      if (name) symbols.push({ name, line: line + 1 });
      if (symbols.length === 100) break;
    }
    records.push([path, { stamp, symbols }]);
    revised++;
  }
  const entries = Object.fromEntries(records);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (revised || Object.keys(cache).length !== records.length) await saveJson(file, entries);
  return { scanned: records.length, revised, entries };
}

export async function sourceHistory(root, path, line) {
  const file = await verifiedFile(root, path);
  const rel = slash(relative(root, file.path));
  const history = (await gitWork(root, ['log', '-30', '--follow', '--format=%h%x09%ad%x09%s', '--date=short', '--', rel])).trim().split('\n').filter(Boolean);
  let blame;
  if (line !== undefined) {
    const number = Number(line);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Choose a positive source line.');
    blame = (await gitWork(root, ['blame', '--line-porcelain', '-L', number + ',' + number, '--', rel])).split('\n').slice(0, 7);
  }
  return { path: rel, history, blame };
}

export async function treeChanges(root, base) {
  const commit = (await gitWork(root, ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'])).trim();
  const before = (await gitWork(root, ['merge-base', 'HEAD', commit])).trim();
  return { base: before, paths: (await gitWork(root, ['diff', '--name-only', '-z', before, 'HEAD'])).split('\0').filter(Boolean) };
}

export async function verifyAnchor(root, path, line, revision, text) {
  if (!Number.isSafeInteger(line) || line < 1) throw new Error('Choose a positive source line.');
  const file = await verifiedFile(root, path);
  const current = (await readText(root, path)).split(/\r?\n/);
  if (!text && revision) {
    const commit = (await gitWork(root, ['rev-parse', '--verify', '--end-of-options', revision + '^{commit}'])).trim();
    const previous = await gitWork(root, ['show', commit + ':' + slash(relative(root, file.path))]);
    text = previous.split(/\r?\n/)[line - 1];
  }
  if (!text?.trim()) throw new Error('An anchor needs a reference commit or exact text.');
  if (current[line - 1]?.trim() === text.trim()) return { status: 'unchanged', line };
  const candidates = current.flatMap((row, index) => row.trim() === text.trim() ? [index + 1] : []).slice(0, 20);
  return candidates.length === 1 ? { status: 'moved', line: candidates[0] } : { status: 'needs-review', candidates };
}

export async function typeScriptPaths(root, signal) {
  try {
    const raw = await readText(root, 'tsconfig.json', signal, 128 * 1024);
    const tokens = /"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
    const config = JSON.parse(raw.replace(tokens, token => token.startsWith('/') ? '' : token).replace(/,(?=\s*[}\]])/g, ''));
    const { baseUrl = '.', paths } = config.compilerOptions ?? {};
    const base = resolve(root, baseUrl);
    if (!within(root, base)) return {};
    return { base, paths };
  } catch (error) {
    signal?.throwIfAborted();
    return {};
  }
}

export function importTargets(root, path, specifier, aliases) {
  if (specifier.startsWith('.')) return [resolve(root, dirname(path), specifier)];
  const matches = [];
  for (const [key, targets] of Object.entries(aliases.paths ?? {})) {
    if (!Array.isArray(targets)) continue;
    const [prefix, suffix] = key.split('*');
    const wildcard = suffix !== undefined;
    if (wildcard ? !specifier.startsWith(prefix) || !specifier.endsWith(suffix) : specifier !== key) continue;
    const captured = wildcard ? specifier.slice(prefix.length, specifier.length - suffix.length) : '';
    for (const target of targets) if (typeof target === 'string') matches.push(resolve(aliases.base, target.replace('*', captured)));
  }
  return matches.filter(path => within(root, path));
}

export async function packageImpact(root, selected, signal) {
  const workspace = new Workspace(root);
  const graph = new Map();
  for (const path of (await workspace.files(signal)).files.filter(packagePath).slice(0, 350)) {
    try {
      const data = JSON.parse(await readText(root, path, signal, 128 * 1024));
      if (typeof data.name === 'string') graph.set(data.name, { path: dirname(path),
        edges: Object.keys({ ...data.dependencies, ...data.peerDependencies, ...data.devDependencies }) });
    } catch (error) { signal?.throwIfAborted(); }
  }
  const cycles = new Set(), seen = new Set();
  const visit = (name, trail) => {
    const prior = trail.indexOf(name);
    if (prior >= 0) { cycles.add(trail.slice(prior).sort().join(' → ')); return; }
    if (!graph.has(name) || seen.has(name)) return;
    for (const next of graph.get(name).edges) visit(next, [...trail, name]);
    seen.add(name);
  };
  for (const name of graph.keys()) visit(name, []);
  const affected = new Set(selected ? [selected] : []);
  for (let previous = -1; previous < affected.size;) {
    previous = affected.size;
    for (const [name, node] of graph) if (node.edges.some(edge => affected.has(edge))) affected.add(name);
  }
  return { cycles: [...cycles], affected: [...affected].filter(name => graph.has(name)).map(name => ({ name, path: graph.get(name).path })) };
}

export const languageKey = path => ({ '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.go': 'go', '.rs': 'rust' })[extname(path).toLowerCase()];

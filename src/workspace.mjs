import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isStatePath } from './store.mjs';
import { importTargets, typeScriptPaths } from './source-index.mjs';

const exec = promisify(execFile);
const ignored = new Set(['.git', '.xcode', 'node_modules', '.venv', '__pycache__', 'vendor', 'dist', 'build', 'coverage']);
const slash = value => value.split(sep).join('/');
export const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

export function blocked(path) {
  return path.split(/[\\/]/).some(part =>
    ignored.has(part.toLowerCase()) ||
    /^(?:\.env(?:[.-].*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.ssh|\.aws|\.gnupg|\.kube|\.docker|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(part));
}

export async function verifiedFile(root, path, signal) {
  signal?.throwIfAborted();
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('A file path is required.');
  const target = resolve(root, path);
  if (!within(root, target) || blocked(relative(root, target)) || isStatePath(target)) throw new Error('Path is outside the workspace or excluded.');
  const resolved = await realpath(target);
  if (resolved !== target || !within(root, resolved) || blocked(relative(root, resolved)) || isStatePath(resolved))
    throw new Error('Symbolic links and paths outside the workspace are excluded.');
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error('Select a regular file.');
  return { path: resolved, info };
}

export async function loadBytes(path, max, signal) {
  signal?.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max) throw new Error('File exceeds the supported size.');
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    if (filled > max) throw new Error('File exceeds the supported size.');
    return buffer.subarray(0, filled);
  } finally {
    await file.close();
  }
}

export function decodeText(bytes) {
  if (bytes.includes(0)) throw new Error('Binary files require an attachment type.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text can be read as source.');
  }
}

export function replaceText(bytes, oldText, newText, max, startLine) {
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string' || oldText === newText)
    throw new Error('Provide exact original and replacement text.');
  const original = decodeText(bytes);
  const normal = original.replace(/\r\n/g, '\n');
  const expected = oldText.replace(/\r\n/g, '\n');
  if (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) throw new Error('startLine must be a positive line number.');
  const locations = [];
  const hints = [];
  let line = 1, current = 0;
  for (let match = normal.indexOf(expected); match >= 0; match = normal.indexOf(expected, match + 1)) {
    while (current < match) if (normal[current++] === '\n') line++;
    if (hints.length < 8) hints.push(line);
    if (startLine === undefined || startLine === line) locations.push({ index: match, line });
    if (locations.length >= 2 && hints.length >= 8) break;
    if (startLine !== undefined && line > startLine) break;
  }
  if (locations.length !== 1) throw new Error('Original text must match exactly once' +
    (hints.length ? '. Candidate lines: ' + [...new Set(hints)].join(', ') + '. Use a longer excerpt or startLine.' : '.'));
  const index = locations[0].index;
  line = locations[0].line;
  function sourceOffset(target) {
    let actual = 0;
    for (let normalized = 0; normalized < target; normalized++, actual++) {
      if (original[actual] === '\r' && original[actual + 1] === '\n') actual++;
    }
    return actual;
  }
  const offset = sourceOffset(index);
  const end = sourceOffset(index + expected.length);
  const replacement = original.includes('\r\n') ? newText.replace(/\r?\n/g, '\r\n') : newText;
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' : '';
  const output = bom + original.slice(0, offset) + replacement + original.slice(end);
  if (Buffer.byteLength(output) > max || output.includes('\0') || !output.isWellFormed()) throw new Error('Edited file exceeds the supported UTF-8 text limits.');
  return { output, line };
}

export async function readText(root, path, signal, max = 1024 * 1024) {
  return decodeText(await loadBytes((await verifiedFile(root, path, signal)).path, max, signal));
}

export async function worktrees(root) {
  let stdout;
  try {
    ({ stdout } = await exec('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, maxBuffer: 1024 * 1024 }));
  } catch {
    throw new Error('Git could not list worktrees for this project.');
  }
  const result = [];
  let current;
  for (const field of stdout.split('\0')) {
    if (field.startsWith('worktree ')) {
      const path = field.slice(9);
      const location = await realpath(path).catch(() => path);
      current = { path: location, current: location === root };
      result.push(current);
    } else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (current && field === 'detached') current.detached = true;
    else if (current && field.startsWith('locked')) current.locked = true;
    else if (!field) current = undefined;
  }
  return result;
}

export async function projectRoot(directory) {
  const current = await realpath(directory);
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: current });
    return await realpath(stdout.trim());
  } catch {
    // Git metadata also works when Git itself is unavailable.
    for (let dir = current; ; dir = dirname(dir)) {
      const metadata = join(dir, '.git');
      const info = await lstat(metadata).catch(() => null);
      if (info?.isDirectory() && (await lstat(join(metadata, 'HEAD')).catch(() => null))?.isFile()) return dir;
      if (info?.isFile()) {
        const pointer = (await loadBytes(metadata, 4096).catch(() => Buffer.alloc(0))).toString('utf8');
        if (pointer.startsWith('gitdir: ')) return dir;
      }
      if (dirname(dir) === dir) return current;
    }
  }
}

async function walk(root, signal) {
  const files = [];
  let visits = 0;
  async function visit(dir, parentRules) {
    signal?.throwIfAborted();
    const rules = [...parentRules];
    for (const name of ['.gitignore', '.ignore', '.rgignore']) {
      const text = await readText(root, join(dir, name), signal, 128 * 1024).catch(() => '');
      for (const line of text.split(/\r?\n/)) {
        const rule = line.trim();
        if (rule && !rule.startsWith('#')) rules.push({ dir, rule });
      }
    }
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (++visits > 25000) break;
      if (entry.name.startsWith('.') || blocked(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (isStatePath(path)) continue;
      let skip = false;
      for (const { dir: base, rule } of rules) {
        const negated = rule.startsWith('!');
        const raw = negated ? rule.slice(1) : rule;
        if (raw.endsWith('/') && !entry.isDirectory()) continue;
        const pattern = raw.replace(/^\//, '').replace(/\/$/, '');
        const candidate = raw.startsWith('/') || pattern.includes('/') ? slash(relative(base, path)) : entry.name;
        if (pattern && matchesGlob(candidate, pattern)) skip = !negated;
      }
      if (skip) continue;
      if (entry.isDirectory()) await visit(path, rules);
      if (entry.isFile()) files.push(slash(relative(root, path)));
    }
  }
  await visit(root, []);
  return { files, truncated: visits > 25000 };
}

async function inventory(root, signal) {
  const result = stdout => {
    const paths = [...new Set(stdout.split('\0').filter(Boolean).map(slash))]
      .filter(path => !blocked(path) && !isStatePath(resolve(root, path))).sort();
    return { files: paths.slice(0, 25000), truncated: paths.length > 25000 };
  };
  try {
    const options = { cwd: root, signal, maxBuffer: 4 * 1024 * 1024 };
    const listed = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], options);
    const deleted = new Set((await exec('git', ['ls-files', '-z', '--deleted', '--', '.'], options)).stdout.split('\0'));
    return result(listed.stdout.split('\0').filter(path => !deleted.has(path)).join('\0'));
  } catch (error) {
    signal?.throwIfAborted();
  }
  try {
    const { stdout } = await exec('rg', ['--files', '--null', '--no-config', '--no-messages', '--no-require-git'], {
      cwd: root, signal, maxBuffer: 4 * 1024 * 1024,
    });
    return result(stdout);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 1) return { files: [], truncated: false };
    if (!['ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code)) throw error;
    return walk(root, signal);
  }
}

const outline = /^\s*(?:(?:export|default|public|private|protected|static|async|abstract|final)\s+)*(?:function|fn|func|def|class|interface|type|struct|enum|trait|record|module)\s+([A-Za-z_$][\w$]*)/;
const importPath = /(?:from\s*|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g;

function excerpt(text, start, count) {
  const lines = text.split('\n');
  const first = Math.max(1, Number.isSafeInteger(start) ? start : 1);
  const length = Math.min(200, Math.max(1, Number.isSafeInteger(count) ? count : 80));
  const rows = [];
  let size = 0;
  for (let line = first; line <= Math.min(lines.length, first + length - 1); line++) {
    const row = String(line) + ' ' + lines[line - 1].trimEnd().slice(0, 350);
    if (size + row.length + 1 > 14000) break;
    rows.push(row);
    size += row.length + 1;
  }
  const next = first + rows.length;
  return { totalLines: lines.length, lines: rows.join('\n'), ...(next <= lines.length ? { nextStart: next } : {}) };
}

export class Workspace {
  constructor(root, excludes = []) {
    this.root = root;
    this.excludes = excludes;
    this.readCache = new Map();
  }

  async files(signal) {
    this.cachedFiles ??= inventory(this.root, signal).then(result => ({
      ...result, files: result.files.filter(path => !this.excluded(resolve(this.root, path))),
    }));
    try {
      return await this.cachedFiles;
    } catch (error) {
      this.cachedFiles = undefined;
      throw error;
    }
  }

  async search({ query, pattern = '**', path = '.', offset = 0, start = 1 }, signal) {
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Enter a search string up to 300 characters.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(start) || start < 1)
      throw new Error('Search offsets must be nonnegative with a positive starting line.');
    const { files, truncated } = await this.files(signal);
    const scope = this.scope(path);
    const selected = files.filter(file => within(scope, resolve(this.root, file)) && matchesGlob(file, pattern));
    const needle = query.toLowerCase();
    const matches = [];
    let scanned = 0;
    let next;
    for (let index = offset; index < selected.length; index++) {
      signal?.throwIfAborted();
      if (scanned >= 2500) { next = { offset: index, start: 1 }; break; }
      scanned++;
      const file = selected[index];
      const text = await readText(this.root, file, signal).catch(() => null);
      signal?.throwIfAborted();
      if (!text) continue;
      const lines = text.split('\n');
      for (let line = index === offset ? start : 1; line <= lines.length; line++) {
        const entry = lines[line - 1];
        const column = entry.toLowerCase().indexOf(needle);
        if (column < 0) continue;
        matches.push({ path: file, line, text: entry.trimEnd().slice(Math.max(0, column - 80), column + 240) });
        if (matches.length === 60) {
          next = line < lines.length ? { offset: index, start: line + 1 } :
            index + 1 < selected.length ? { offset: index + 1, start: 1 } : undefined;
          break;
        }
      }
      if (matches.length === 60) break;
    }
    return { matches, scanned, truncated: truncated || Boolean(next), ...(next ? { next } : {}) };
  }

  async searchRegex({ query, pattern = '**', path = '.' }, signal) {
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Enter a regex up to 300 characters.');
    const scope = this.scope(path);
    if (await realpath(scope) !== scope) throw new Error('Search scope must be a regular workspace directory.');
    let stdout;
    try {
      ({ stdout } = await exec('rg', ['--json', '--no-config', '--no-messages', '-i', '--glob', pattern, '--', query, '.'],
        { cwd: scope, signal, maxBuffer: 2 * 1024 * 1024, timeout: 15000 }));
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 1) return { matches: [], truncated: false };
      if (error.code === 'ENOENT') throw new Error('Regex and symbol search require ripgrep (rg).');
      throw new Error('Regex search failed. Check the pattern or narrow its scope.');
    }
    const matches = [];
    for (const line of stdout.split('\n')) {
      if (!line.includes('"type":"match"')) continue;
      const row = JSON.parse(line).data;
      if (!row?.path?.text || !row?.lines?.text) continue;
      const file = slash(relative(this.root, resolve(scope, row.path.text)));
      if (blocked(file) || !within(this.root, resolve(this.root, file)) || isStatePath(resolve(this.root, file))) continue;
      matches.push({ path: file, line: row.line_number, text: row.lines.text.trimEnd().slice(0, 320) });
      if (matches.length === 60) return { matches, truncated: true };
    }
    return { matches, truncated: false };
  }

  async symbol({ name, path }, signal) {
    if (typeof name !== 'string' || !/^[A-Za-z_$][\w$]{0,80}$/.test(name)) throw new Error('Enter a JavaScript or TypeScript identifier.');
    const escape = name.replaceAll('$', '\\$');
    const search = await this.searchRegex({ query: '(^|[^A-Za-z0-9_$])' + escape + '([^A-Za-z0-9_$]|$)',
      path, pattern: '*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}' }, signal);
    const declaration = new RegExp('\\b(?:function|class|const|let|var|interface|type|enum|namespace)\\s+' + escape + '(?![\\w$])');
    const exact = new RegExp('(^|[^A-Za-z0-9_$])' + escape + '([^A-Za-z0-9_$]|$)');
    const matches = search.matches.filter(item => exact.test(item.text));
    return { definitions: matches.filter(item => declaration.test(item.text)),
      references: matches.filter(item => !declaration.test(item.text)), truncated: search.truncated };
  }

  excluded(path) {
    const candidate = slash(relative(this.root, path));
    return this.excludes.some(pattern => matchesGlob(candidate, pattern) ||
      (pattern.endsWith('/**') && candidate === pattern.slice(0, -3)));
  }

  scope(path = '.') {
    if (typeof path !== 'string' || path.includes('\0')) throw new Error('Invalid directory.');
    const scope = resolve(this.root, path);
    if (!within(this.root, scope) || blocked(relative(this.root, scope)) || isStatePath(scope) || this.excluded(scope)) throw new Error('Scope is outside the workspace or excluded.');
    return scope;
  }

  async glob({ pattern = '**', path = '.', offset = 0, count = 120 }, signal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 1 || count > 120)
      throw new Error('File listing needs a nonnegative offset and 1–120 paths per page.');
    const scope = this.scope(path);
    const { files, truncated } = await this.files(signal);
    const matches = files.filter(file => within(scope, resolve(this.root, file)) && matchesGlob(file, pattern));
    const paths = matches.slice(offset, offset + count);
    const more = offset + paths.length < matches.length;
    return { paths, truncated: truncated || more, ...(more ? { nextOffset: offset + paths.length } : {}) };
  }

  async read({ path, start, count }, signal) {
    const file = await verifiedFile(this.root, this.scope(path), signal);
    const { ino, size, mtimeMs, ctimeMs } = file.info;
    const revision = [ino, size, mtimeMs, ctimeMs, start, count].join(':');
    const saved = this.readCache.get(file.path);
    if (saved?.revision === revision) return { ...saved.result, unchanged: true };
    const text = decodeText(await loadBytes(file.path, 1024 * 1024, signal));
    const result = { path: slash(relative(this.root, file.path)), ...excerpt(text, start, count) };
    this.readCache.delete(file.path);
    this.readCache.set(file.path, { revision, result });
    if (this.readCache.size > 8) this.readCache.delete(this.readCache.keys().next().value);
    return result;
  }

  async guides(path = '.', signal) {
    const inside = this.scope(path);
    const info = await lstat(inside).catch(() => null);
    let dir = info?.isDirectory() ? inside : dirname(inside);
    const found = [];
    for (; within(this.root, dir); dir = dirname(dir)) {
      try {
        found.unshift(await this.read({ path: join(dir, 'AGENTS.md') }, signal));
      } catch {
        signal?.throwIfAborted();
      }
      if (dir === this.root || dirname(dir) === dir) break;
    }
    return found;
  }

  async changed(signal) {
    try {
      const { stdout } = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: this.root, signal, maxBuffer: 1024 * 1024,
      });
      const paths = [];
      const rows = stdout.split('\0');
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const path = slash(row.slice(3));
        if (path && !blocked(path) && !isStatePath(resolve(this.root, path))) paths.push(path);
        if (/[RC]/.test(row.slice(0, 2))) index++;
      }
      return paths;
    } catch (error) {
      signal?.throwIfAborted();
      return [];
    }
  }

  async revision(signal) {
    this.catalogRevision ??= exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: this.root, signal, maxBuffer: 4096 })
      .then(result => result.stdout.trim()).catch(() => undefined);
    const revision = await this.catalogRevision;
    signal?.throwIfAborted();
    return revision;
  }

  async packages(path = '.', signal) {
    let directory = this.scope(path);
    if (!(await lstat(directory)).isDirectory()) directory = dirname(directory);
    let owner = directory, selected;
    while (within(this.root, owner)) {
      const file = join(owner, 'package.json');
      try { selected = JSON.parse(await readText(this.root, file, signal, 128 * 1024)); break; }
      catch { signal?.throwIfAborted(); }
      if (owner === this.root) break;
      owner = dirname(owner);
    }
    if (!selected) return { package: null, dependencies: [] };
    const depends = new Set(Object.keys({ ...selected.dependencies, ...selected.devDependencies, ...selected.peerDependencies }));
    const matches = [];
    const { files } = await this.files(signal);
    for (const file of files.filter(path => path.endsWith('/package.json')).slice(0, 300)) {
      try {
        const content = JSON.parse(await readText(this.root, file, signal, 128 * 1024));
        if (depends.has(content.name)) matches.push({ name: content.name, path: file.slice(0, -'/package.json'.length) });
      } catch { signal?.throwIfAborted(); }
    }
    return { package: { name: selected.name ?? null, path: slash(relative(this.root, owner)) || '.' }, dependencies: matches };
  }

  async map({ query = '', path }, signal) {
    const { files, truncated } = await this.files(signal);
    const terms = String(query).toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.filter(word => word.length > 1).slice(0, 12) ?? [];
    const rank = text => terms.filter(term => text.toLowerCase().includes(term)).length;
    const sources = files.filter(file => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift)$/i.test(file));
    const scope = path ? await this.packages(path, signal) : null;
    const prefixes = scope?.package ? [scope.package.path, ...scope.dependencies.map(item => item.path)] : [];
    const changed = new Set(await this.changed(signal));
    const stem = path => path.split('/').at(-1).replace(/\.[^.]+$/, '').replace(/(?:[._-](?:spec|test)|Tests?)$/i, '').toLowerCase();
    const related = new Set([...changed].map(stem));
    const selected = sources.map(file => ({ file, score: rank(file) * 4 + (prefixes.some(prefix => prefix === '.' || file.startsWith(prefix + '/')) ? 4 : 0) + (changed.has(file) ? 3 : related.has(stem(file)) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file))
      .slice(0, 240);
    const seen = new Set(sources);
    const aliases = await typeScriptPaths(this.root, signal);
    const items = [];
    for (const { file, score } of selected) {
      signal?.throwIfAborted();
      const source = await readText(this.root, file, signal, 192 * 1024).catch(() => '');
      const symbols = [];
      const imports = new Set();
      let line = 0;
      for (const text of source.split('\n')) {
        line++;
        const name = outline.exec(text)?.[1];
        if (name) symbols.push({ name, line });
        for (const match of text.matchAll(importPath)) {
          const candidates = importTargets(this.root, file, match[1], aliases).map(path => slash(relative(this.root, path)));
          const target = candidates.flatMap(location => [location, location.replace(/\.js$/, '.ts'),
            ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'].map(suffix => location + suffix)])
            .find(candidate => seen.has(candidate));
          if (target && target !== file) imports.add(target);
        }
      }
      if (symbols.length || imports.size) items.push({
        path: file,
        symbols: symbols.sort((a, b) => rank(b.name) - rank(a.name)).slice(0, 8),
        imports: [...imports].slice(0, 8),
        score: score * 3 + Math.max(0, ...symbols.map(symbol => rank(symbol.name))),
      });
    }
    return {
      files: items.sort((a, b) => b.score - a.score).slice(0, 20).map(({ score, ...item }) => item),
      truncated: truncated || sources.length > selected.length || items.length > 20,
    };
  }
}

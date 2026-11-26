import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

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
  if (!within(root, target) || blocked(relative(root, target))) throw new Error('Path is outside the workspace or excluded.');
  const resolved = await realpath(target);
  if (resolved !== target || !within(root, resolved) || blocked(relative(root, resolved)))
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

export async function readText(root, path, signal, max = 1024 * 1024) {
  return decodeText(await loadBytes((await verifiedFile(root, path, signal)).path, max, signal));
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
  try {
    const { stdout } = await exec('rg', ['--files', '--null', '--no-config', '--no-messages', '--no-require-git'], {
      cwd: root, signal, maxBuffer: 4 * 1024 * 1024,
    });
    const paths = stdout.split('\0').filter(Boolean).map(slash).filter(path => !blocked(path)).sort();
    return { files: paths.slice(0, 25000), truncated: paths.length > 25000 };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 1) return { files: [], truncated: false };
    if (!['ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code)) throw error;
    return walk(root, signal);
  }
}

const outline = /^\s*(?:(?:export|default|public|private|protected|static|async|abstract|final)\s+)*(?:function|fn|func|def|class|interface|type|struct|enum|trait|record|module)\s+([A-Za-z_$][\w$]*)/;
const importPath = /(?:from\s*|import\s*\(?\s*|require\(\s*)['"](\.[^'"]+)['"]/g;

function excerpt(text, start, count) {
  const lines = text.split('\n');
  const first = Math.min(lines.length, Math.max(1, Number.isInteger(start) ? start : 1));
  const length = Math.min(200, Math.max(1, Number.isInteger(count) ? count : 80));
  return {
    totalLines: lines.length,
    lines: lines.slice(first - 1, first + length - 1).map((line, index) =>
      String(first + index) + ' ' + line.trimEnd().slice(0, 350)).join('\n').slice(0, 14000),
  };
}

export class Workspace {
  constructor(root) {
    this.root = root;
  }

  async files(signal) {
    this.cachedFiles ??= inventory(this.root, signal);
    try {
      return await this.cachedFiles;
    } catch (error) {
      this.cachedFiles = undefined;
      throw error;
    }
  }

  async search({ query, pattern = '**', path = '.' }, signal) {
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new Error('Enter a search string up to 300 characters.');
    const { files, truncated } = await this.files(signal);
    const scope = this.scope(path);
    const selected = files.filter(file => within(scope, resolve(this.root, file)) && matchesGlob(file, pattern));
    const needle = query.toLowerCase();
    const matches = [];
    let scanned = 0;
    for (const file of selected) {
      signal?.throwIfAborted();
      if (scanned++ >= 2500 || matches.length >= 60) break;
      const text = await readText(this.root, file, signal).catch(() => null);
      if (!text) continue;
      let line = 0;
      for (const entry of text.split('\n')) {
        line++;
        const offset = entry.toLowerCase().indexOf(needle);
        if (offset < 0) continue;
        matches.push({ path: file, line, text: entry.trimEnd().slice(Math.max(0, offset - 80), offset + 240) });
        if (matches.length >= 60) break;
      }
    }
    return { matches, truncated: truncated || matches.length >= 60 || selected.length > 2500 };
  }

  scope(path = '.') {
    if (typeof path !== 'string' || path.includes('\0')) throw new Error('Invalid directory.');
    const scope = resolve(this.root, path);
    if (!within(this.root, scope) || blocked(relative(this.root, scope))) throw new Error('Scope is outside the workspace or excluded.');
    return scope;
  }

  async glob({ pattern = '**', path = '.' }, signal) {
    const scope = this.scope(path);
    const { files, truncated } = await this.files(signal);
    const matches = files.filter(file => within(scope, resolve(this.root, file)) && matchesGlob(file, pattern));
    return { paths: matches.slice(0, 120), truncated: truncated || matches.length > 120 };
  }

  async read({ path, start, count }, signal) {
    const file = await verifiedFile(this.root, path, signal);
    const text = decodeText(await loadBytes(file.path, 1024 * 1024, signal));
    return { path: slash(relative(this.root, file.path)), ...excerpt(text, start, count) };
  }

  async edit({ path, oldText, newText }, signal) {
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string' || oldText === newText)
      throw new Error('Provide exact original and replacement text.');
    const file = await verifiedFile(this.root, path, signal);
    const bytes = await loadBytes(file.path, 1024 * 1024, signal);
    const original = decodeText(bytes);
    const normal = original.replace(/\r\n/g, '\n');
    const expected = oldText.replace(/\r\n/g, '\n');
    const index = normal.indexOf(expected);
    if (index < 0 || normal.indexOf(expected, index + 1) >= 0) throw new Error('Original text must match exactly once.');
    const line = normal.slice(0, index).split('\n').length;
    function sourceOffset(target) {
      let actual = 0;
      for (let normalized = 0; normalized < target; normalized++, actual++) {
        if (original[actual] === '\r' && original[actual + 1] === '\n') actual++;
      }
      return actual;
    }
    const offset = sourceOffset(index);
    const originalEnd = sourceOffset(index + expected.length);
    const replacement = original.includes('\r\n') ? newText.replace(/\r?\n/g, '\r\n') : newText;
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' : '';
    const output = bom + original.slice(0, offset) + replacement + original.slice(originalEnd);
    if (Buffer.byteLength(output) > 1024 * 1024) throw new Error('Edited file exceeds the supported size.');
    const temporary = join(dirname(file.path), '.' + basename(file.path) + '.xcode-' + randomUUID());
    const handle = await open(temporary, 'wx', file.info.mode & 0o777);
    try {
      try {
        await handle.writeFile(output);
        await handle.chmod(file.info.mode & 0o777);
      } finally {
        await handle.close();
      }
      const latest = await verifiedFile(this.root, path, signal);
      if (latest.info.ino !== file.info.ino || !(await loadBytes(latest.path, 1024 * 1024, signal)).equals(bytes))
        throw new Error('File changed while preparing the edit. Read it again.');
      await rename(temporary, file.path);
    } finally {
      await rm(temporary, { force: true });
    }
    return { path: slash(relative(this.root, file.path)), line };
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

  async map({ query = '' }, signal) {
    const { files, truncated } = await this.files(signal);
    const terms = String(query).toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.filter(word => word.length > 1).slice(0, 12) ?? [];
    const rank = text => terms.filter(term => text.toLowerCase().includes(term)).length;
    const sources = files.filter(file => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift)$/i.test(file));
    const selected = sources.map(file => ({ file, score: rank(file) }))
      .sort((a, b) => b.score - a.score || a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file))
      .slice(0, 240);
    const seen = new Set(sources);
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
          const location = slash(relative(this.root, resolve(this.root, dirname(file), match[1])));
          const target = [location, location.replace(/\.js$/, '.ts'), ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']
            .map(suffix => location + suffix)].find(candidate => seen.has(candidate));
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

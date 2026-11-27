import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const storage = resolve(process.env.XCODE_HOME || join(homedir(), '.xcode'));
export const sessionsDir = join(storage, 'sessions');

function canonicalStateRoot(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalStateRoot(parent), basename(path));
  }
}

const stateRoots = new Set([storage, canonicalStateRoot(storage)]);

export function isStatePath(path) {
  for (const root of stateRoots) {
    const first = relative(root, path).split(sep)[0];
    if (/^(?:sessions|(?:settings|tokens)\.json(?:\..*)?|settings\.lock(?:\..*)?)$/i.test(first)) return true;
  }
  return false;
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in ' + path, { cause: error });
    throw error;
  }
}

export async function saveJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function lock(directory, name) {
  const path = join(directory, name + '.lock');
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await readFile(path, 'utf8').catch(() => ''));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (cause) {
        if (cause.code === 'ESRCH') {
          // Leave locks from a dead process recoverable without removing another process's lock.
          throw new Error('Previous process exited with a lock. Remove ' + path + ' after confirming it is inactive.');
        }
      }
    }
    throw new Error('Already open in another xcode process: ' + name);
  }
  try {
    await file.writeFile(String(process.pid));
  } catch (error) {
    await file.close().finally(() => rm(path, { force: true }));
    throw error;
  }
  await file.close();
  return () => rm(path, { force: true });
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(label + ' must be a JSON object.');
  return value;
}

export async function settings() {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const path = join(storage, 'settings.json');
  const config = objectValue(await readJson(path, {}), 'settings.json');
  for (const key of ['profiles', 'harnesses', 'projectChecks', 'harnessChecks']) {
    if (config[key] != null) objectValue(config[key], 'settings.json field ' + key);
  }
  config.profiles ??= {};
  config.harnesses ??= {};
  if (config.defaultProfile != null && typeof config.defaultProfile !== 'string')
    throw new Error('settings.json field defaultProfile must be a profile name.');
  return config;
}

export async function updateSettings(change) {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const unlock = await lock(storage, 'settings');
  try {
    const config = await settings();
    await change(config);
    await saveJson(join(storage, 'settings.json'), config);
  } finally {
    await unlock();
  }
}

function validToken(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Invalid API token. Use xcode setup to update it.');
  return value;
}

export async function tokenFor(name) {
  if (process.env.XCODE_API_TOKEN !== undefined) return validToken(process.env.XCODE_API_TOKEN);
  const tokens = objectValue(await readJson(join(storage, 'tokens.json'), {}), 'tokens.json');
  return Object.hasOwn(tokens, name) ? validToken(tokens[name]) : '';
}

export async function setToken(name, token) {
  const path = join(storage, 'tokens.json');
  const tokens = objectValue(await readJson(path, {}), 'tokens.json');
  await saveJson(path, { ...tokens, [name]: validToken(token) });
}

export function sessionPath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid session ID.');
  return join(sessionsDir, id + '.json');
}

export async function readSession(id) {
  const path = sessionPath(id);
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile()) throw new Error('Session file must be a regular file.');
  const session = await readJson(path, null);
  if (!session || session.id !== id || typeof session.root !== 'string' ||
    typeof session.title !== 'string' || typeof session.updated !== 'string' ||
    !Array.isArray(session.queue) || !Array.isArray(session.turns))
    throw new Error('Session file has an invalid structure.');
  return session;
}

export async function listSessions(root, onProblem = () => {}) {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const files = await readdir(sessionsDir);
  const sessions = [];
  for (const file of files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
    try {
      const session = await readSession(file.slice(0, -5));
      if (session?.root === root) sessions.push(session);
    } catch (error) {
      onProblem(file, error);
    }
  }
  return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const storage = resolve(process.env.XCODE_HOME || join(homedir(), '.xcode'));
export const sessionsDir = join(storage, 'sessions');

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

export async function settings() {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const config = await readJson(join(storage, 'settings.json'), { profiles: {}, harnesses: {} });
  config.profiles ??= {};
  config.harnesses ??= {};
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

export async function tokenFor(name) {
  const tokens = await readJson(join(storage, 'tokens.json'), {});
  return process.env.XCODE_API_TOKEN ?? (Object.hasOwn(tokens, name) ? tokens[name] : '');
}

export async function setToken(name, token) {
  const path = join(storage, 'tokens.json');
  const tokens = await readJson(path, {});
  await saveJson(path, { ...tokens, [name]: token });
}

export function sessionPath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid session ID.');
  return join(sessionsDir, id + '.json');
}

export async function listSessions(root) {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const files = await readdir(sessionsDir);
  const sessions = [];
  for (const file of files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
    const session = await readJson(join(sessionsDir, file), null);
    if (session?.root === root) sessions.push(session);
  }
  return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

import { realpathSync } from 'node:fs';
import { readCredential, writeCredential } from './keychain.mjs';
import { createHash, randomUUID } from 'node:crypto';
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
    if (/^(?:sessions|keychain|indexes|(?:settings|tokens|capabilities)\.json(?:\..*)?|(?:settings|capabilities)\.lock(?:\..*)?)$/i.test(first)) return true;
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

async function fileToken(name) {
  const tokens = objectValue(await readJson(join(storage, 'tokens.json'), {}), 'tokens.json');
  return Object.hasOwn(tokens, name) ? validToken(tokens[name]) : '';
}

export async function savedToken(name, config = null) {
  config ??= await settings();
  if (config.credentialBackends?.[name] !== 'keychain') return fileToken(name);
  if (config.emptyCredentials?.[name] === true) return '';
  return validToken(await readCredential(storage, name));
}

export async function tokenFor(name) {
  if (process.env.XCODE_API_TOKEN !== undefined) return validToken(process.env.XCODE_API_TOKEN);
  return savedToken(name);
}

async function setFileToken(name, token) {
  const path = join(storage, 'tokens.json');
  const tokens = objectValue(await readJson(path, {}), 'tokens.json');
  await saveJson(path, { ...tokens, [name]: validToken(token) });
}

export async function setToken(name, token, config) {
  const value = validToken(token);
  if (config?.credentialBackends?.[name] !== 'keychain') return setFileToken(name, value);
  if (value) await writeCredential(storage, name, value, saveJson);
  else await writeCredential(storage, name, '', saveJson).catch(() => {});
  config.emptyCredentials = { ...config.emptyCredentials, [name]: !value };
}

export async function selectCredentialBackend(name, backend) {
  if (!['file', 'keychain'].includes(backend)) throw new Error('Choose file or keychain token storage.');
  await updateSettings(async config => {
    const previous = config.credentialBackends?.[name] ?? 'file';
    if (previous === backend) return;
    const token = await savedToken(name, config);
    config.credentialBackends = { ...config.credentialBackends, [name]: backend };
    await setToken(name, token, config);
  });
  if (backend === 'keychain') {
    await updateSettings(async config => {
      if (config.credentialBackends?.[name] === 'keychain') await setFileToken(name, '');
    });
  }
}

export function sessionPath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid session ID.');
  return join(sessionsDir, id + '.json');
}

function missing(error) {
  if (error.code === 'ENOENT') return null;
  throw error;
}

const recentTurnCount = 12;
const archivedRefs = new WeakMap();
const wireRefs = new WeakMap();
const isReference = ref => typeof ref === 'string' && /^[0-9a-f-]{36}$/.test(ref);
const recordsDir = id => sessionPath(id).replace(/\.json$/, '.records');

export async function readSessionRecord(id) {
  const path = sessionPath(id);
  const info = await lstat(path).catch(missing);
  if (!info) return null;
  if (!info.isFile()) throw new Error('Session file must be a regular file.');
  const session = await readJson(path, null);
  if (!session || session.id !== id || typeof session.root !== 'string' ||
    typeof session.title !== 'string' || typeof session.updated !== 'string' ||
    !Array.isArray(session.queue) || !Array.isArray(session.turns) ||
    (session.olderTurns !== undefined && (!Array.isArray(session.olderTurns) || !session.olderTurns.every(isReference))))
    throw new Error('Session file has an invalid structure.');
  return session;
}

async function readRecord(id, ref) {
  if (!isReference(ref)) throw new Error('Invalid conversation record reference.');
  const path = join(recordsDir(id), ref + '.json');
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('Conversation record is not a regular file.');
  return readJson(path, null);
}

async function saveRecord(map, id, key, value) {
  const cached = map.get(key);
  if (cached?.id === id) return cached.ref;
  const ref = randomUUID();
  await mkdir(recordsDir(id), { recursive: true, mode: 0o700 });
  await saveJson(join(recordsDir(id), ref + '.json'), value);
  map.set(key, { id, ref });
  return ref;
}

async function readOlderTurn(id, ref) {
  const turn = await readRecord(id, ref);
  if (!turn || typeof turn !== 'object') throw new Error('Invalid saved turn.');
  archivedRefs.set(turn, { id, ref });
  return turn;
}

export async function readSession(id) {
  const record = await readSessionRecord(id);
  if (!record) return null;
  const { olderTurns = [], ...session } = record;
  const turns = [];
  for (const ref of olderTurns) turns.push(await readOlderTurn(id, ref));
  for (const entry of session.turns) {
    if (!entry?.wireRef) { turns.push(entry); continue; }
    const { wireRef, ...turn } = entry;
    turn.wire = await readRecord(id, wireRef);
    wireRefs.set(turn, { id, ref: wireRef });
    turns.push(turn);
  }
  return { ...session, turns };
}

export async function readSessionPage(id, before, count = 8) {
  const record = await readSessionRecord(id);
  if (!record) return null;
  const older = record.olderTurns ?? [];
  const total = older.length + record.turns.length;
  const end = before === undefined ? total : Number(before) - 1;
  const size = Number(count);
  if (!Number.isInteger(end) || end < 0 || end > total || !Number.isInteger(size) || size < 1 || size > 20)
    throw new Error('Provide a turn number and a page size from 1 to 20.');
  const start = Math.max(0, end - size);
  const entries = [];
  for (let index = start; index < end; index++) {
    const turn = index < older.length ? await readOlderTurn(id, older[index]) : record.turns[index - older.length];
    entries.push({ number: index + 1, turn });
  }
  return { root: record.root, entries, ...(start ? { nextBefore: start + 1 } : {}) };
}

async function separateTurnRecords(session) {
  const boundary = Math.max(0, session.turns.length - recentTurnCount);
  const olderTurns = [];
  const turns = [];
  for (let index = 0; index < session.turns.length; index++) {
    const entry = session.turns[index];
    if (index < boundary) {
      olderTurns.push(await saveRecord(archivedRefs, session.id, entry, entry));
    } else if (entry?.wire) {
      const { wire, ...turn } = entry;
      turns.push({ ...turn, wireRef: await saveRecord(wireRefs, session.id, entry, wire) });
    } else {
      turns.push(entry);
    }
  }
  return { ...session, turns, ...(olderTurns.length ? { olderTurns } : {}) };
}

function summarizeSession(session) {
  const pending = session.queue[0];
  const last = session.turns.at(-1);
  return {
    id: session.id, root: session.root, title: session.title, updated: session.updated,
    pendingCount: session.queue.length, pinned: Boolean(session.pinned), archived: Boolean(session.archived),
    tags: session.tags, trashed: session.trashed,
    queue: pending ? [{ review: pending.review ? { state: pending.review.state } : null, failure: Boolean(pending.failure) }] : [],
    turns: last ? [{ status: last.status, verificationFailed: Boolean(last.verificationFailed) }] : [],
    undoInProgress: Boolean(session.undoInProgress),
  };
}

const recordKey = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
const indexPath = id => sessionPath(id).replace(/\.json$/, '.summary');

async function writeSummary(id, info, summary) {
  // The session remains the source of truth. An unwritable index never discards a saved session.
  await saveJson(indexPath(id), { record: recordKey(info), summary }).catch(() => {});
}

function projectSessions(root) {
  return join(sessionsDir, 'projects', createHash('sha256').update(root).digest('hex'));
}

async function indexProject(session) {
  const directory = projectSessions(session.root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const marker of [join(directory, session.id), sessionPath(session.id).replace(/\.json$/, '.project')]) {
    try {
      const file = await open(marker, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export async function writeSession(session, { separated = false } = {}) {
  const path = sessionPath(session.id);
  await saveJson(path, separated ? session : await separateTurnRecords(session));
  const info = await lstat(path).catch(() => null);
  if (info) await writeSummary(session.id, info, summarizeSession(session));
  await indexProject(session).catch(() => {});
}

async function sessionSummary(id) {
  const path = sessionPath(id);
  const record = await lstat(path).catch(missing);
  if (!record) return null;
  if (!record.isFile()) throw new Error('Session file must be a regular file.');
  const index = await lstat(indexPath(id)).catch(() => null);
  if (index?.isFile() && index.size <= 16384) {
    const cached = await readJson(indexPath(id), null).catch(() => null);
    const entry = cached?.summary;
    if (cached?.record === recordKey(record) && entry?.id === id && typeof entry.root === 'string' &&
      typeof entry.title === 'string' && typeof entry.updated === 'string' &&
      Number.isSafeInteger(entry.pendingCount) && Array.isArray(entry.queue) && Array.isArray(entry.turns))
      return entry;
  }
  const session = await readSessionRecord(id);
  if (!session) return null;
  const summary = summarizeSession(session);
  const current = await lstat(path).catch(missing);
  if (current?.isFile() && recordKey(record) === recordKey(current)) await writeSummary(id, current, summary);
  return summary;
}

export async function listSessions(root, onProblem = () => {}) {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const files = new Set(await readdir(sessionsDir));
  const indexes = await readdir(projectSessions(root)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const ids = new Set((indexes ?? []).filter(name => /^[0-9a-f-]{36}$/.test(name)));
  for (const name of files) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const id = name.slice(0, -5);
    if (!indexes || !files.has(id + '.project')) ids.add(id);
  }
  const sessions = [];
  for (const id of ids) {
    try {
      const session = await sessionSummary(id);
      if (!session) continue;
      if (!files.has(id + '.project') || !indexes) await indexProject(session).catch(() => {});
      if (session.root === root) sessions.push(session);
    } catch (error) {
      onProblem(id + '.json', error);
    }
  }
  return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

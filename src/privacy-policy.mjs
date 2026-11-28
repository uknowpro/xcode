import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { appendFile, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative } from 'node:path';
import { promisify } from 'node:util';
import { modelEndpoint, modelPolicy } from './model-profile.mjs';
import { redactSecrets } from './checks.mjs';
import { lock, storage } from './store.mjs';

const derive = promisify(scrypt);
const auditPath = root => join(storage, 'audit', createHash('sha256').update(root).digest('hex') + '.jsonl');
export const policyAt = (config, root) => config.dataPolicy?.[root] ?? {};
export const destination = profile => {
  const endpoint = modelEndpoint(profile, modelPolicy(profile));
  return endpoint.origin + endpoint.pathname;
};

export function noNetwork(policy) {
  if (policy.offline) throw new Error('This workspace is in local-only mode.');
}

export function allowModel(policy, profile) {
  noNetwork(policy);
  if (policy.restrictDestinations && !policy.endpoints?.includes(destination(profile)))
    throw new Error('Confirm this destination with xcode policy allow-profile <name> before sending.');
}

function ruleMatches(root, path, rule) {
  const pathname = relative(root, path).replaceAll('\\', '/');
  return matchesGlob(pathname, rule.pattern) || (rule.pattern.endsWith('/**') && pathname === rule.pattern.slice(0, -3));
}

export function inspectTransfer(policy, root, path, content, token) {
  const rules = (policy.inspect ?? []).filter(rule => ruleMatches(root, path, rule));
  const masked = redactSecrets(content, [token]);
  const changed = masked !== content;
  if (rules.some(rule => rule.action === 'deny' || rule.action === 'block-match' && changed))
    throw new Error('This data is blocked by a workspace transfer rule.');
  const count = changed ? Math.max(1, masked.split('[redacted]').length - content.split('[redacted]').length) : 0;
  return { text: masked, count, kind: 'credential-like text', applied: rules.map(rule => rule.action) };
}

export async function audit(root, event) {
  const path = auditPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let release;
  try { release = await lock(dirname(path), createHash('sha256').update(root).digest('hex')); }
  catch { return; }
  try {
    if ((await lstat(path).catch(() => null))?.size > 1024 * 1024) {
      await rm(path + '.2', { force: true });
      await rename(path + '.1', path + '.2').catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rename(path, path + '.1');
    }
    await appendFile(path, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  } finally { await release(); }
}

export async function recentAudit(root, generation = 0) {
  if (!Number.isInteger(generation) || generation < 0 || generation > 2) throw new Error('Log generation must be 0, 1 or 2.');
  const file = await open(auditPath(root) + (generation ? '.' + generation : ''), 'r').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return [];
  try {
    const stat = await file.stat();
    const start = Math.max(0, stat.size - 128 * 1024);
    const bytes = Buffer.alloc(stat.size - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    return bytes.subarray(0, bytesRead).toString('utf8').split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).slice(-100);
  } finally { await file.close(); }
}

const scheme = 'xcode-session-aes256-gcm-v1';
function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Provide a passphrase between 12 and 1,024 characters.');
}

export async function encryptBackup(value, password) {
  passwordCheck(password);
  const salt = randomBytes(16), nonce = randomBytes(12);
  const key = await derive(password, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(scheme));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { format: scheme, salt: salt.toString('base64'), nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  } finally { key.fill(0); }
}

export async function decryptBackup(value, password) {
  passwordCheck(password);
  if (value?.format !== scheme || [value.salt, value.nonce, value.tag, value.data].some(text =>
    typeof text !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(text))) throw new Error('Unsupported encrypted backup.');
  const salt = Buffer.from(value.salt, 'base64'), nonce = Buffer.from(value.nonce, 'base64'), tag = Buffer.from(value.tag, 'base64');
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw new Error('Encrypted backup header is invalid.');
  const key = await derive(password, salt, 32);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(scheme));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new Error('The passphrase is incorrect or the backup is damaged.'); }
  finally { key.fill(0); }
}

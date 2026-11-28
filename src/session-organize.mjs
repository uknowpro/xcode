import { isAbsolute } from 'node:path';
import { sessionStoredBytes } from './storage-inspect.mjs';

export function sessionTag(text) {
  const value = text.trim().toLowerCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,31}$/u.test(value)) throw new Error('Use a tag of up to 32 letters, numbers or separators.');
  return value;
}

export function note(text, limit = 1200) {
  const value = text.trim();
  if (value.length > limit || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new Error('Note is too long or contains control characters.');
  return value;
}

export function portableTurn(value, origin, root, sourceRoot) {
  if (!value || typeof value.prompt !== 'string' || typeof value.answer !== 'string') return undefined;
  const map = text => root && sourceRoot && isAbsolute(sourceRoot) ? text.replaceAll(sourceRoot, root) : text;
  return {
    prompt: map(value.prompt).slice(0, 32000), answer: map(value.answer).slice(0, 256000),
    status: value.status === 'stopped' ? 'stopped' : 'complete', source: origin,
    completed: [], attachments: [], changed: [], tools: [], checks: [],
  };
}

export function retentionPolicy(values, existing = {}) {
  const number = (field, max) => {
    const value = Number(values[field] ?? existing[field] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid retention value for ' + field + '.');
    return value;
  };
  return { days: number('days', 3650), count: number('count', 10000), mib: number('mib', 1048576), 'trash-days': number('trash-days', 3650) };
}

export async function retentionCandidates(entries, policy, now = Date.now()) {
  const result = [];
  let count = 0, bytes = 0;
  for (const entry of entries) {
    if (entry.trashed) {
      if (policy['trash-days'] && now - Date.parse(entry.trashed) > policy['trash-days'] * 86400000)
        result.push({ id: entry.id, title: entry.title, action: 'purge', reason: 'trash age' });
      continue;
    }
    bytes += await sessionStoredBytes(entry.id);
    count++;
    if (entry.pinned || entry.pendingCount || entry.undoInProgress) continue;
    const age = policy.days && now - Date.parse(entry.updated) > policy.days * 86400000;
    const limit = policy.count && count > policy.count;
    const size = policy.mib && bytes > policy.mib * 1048576;
    if (age || limit || size) result.push({ id: entry.id, title: entry.title, action: 'trash', reason: age ? 'age' : limit ? 'count' : 'record size' });
  }
  return result;
}

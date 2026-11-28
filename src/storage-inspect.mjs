import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentSize } from './attachments.mjs';
import { listSessions, lock, readSessionRecord, sessionPath, sessionsDir, writeSession } from './store.mjs';

async function size(path) {
  try {
    const info = await lstat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let bytes = 0;
    for (const entry of await readdir(path)) bytes += await size(join(path, entry));
    return bytes;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function storageUsage(root) {
  const usage = { sessions: 0, archived: 0, conversationBytes: 0, pendingAttachmentBytes: 0, draftBytes: 0, cacheBytes: 0 };
  for (const item of await listSessions(root)) {
    const base = sessionPath(item.id).slice(0, -5);
    const record = await readSessionRecord(item.id);
    if (!record || record.root !== root) continue;
    usage.sessions++;
    usage.archived += Number(Boolean(record.archived));
    usage.conversationBytes += await size(base + '.json') + await size(base + '.records');
    usage.draftBytes += await size(base + '.draft.json');
    usage.cacheBytes += await size(base + '.summary');
    for (const job of record.queue)
      for (const attachment of job.attachments ?? []) usage.pendingAttachmentBytes += attachmentSize(attachment);
  }
  return usage;
}

export async function cleanStorage(root, type, id) {
  const base = sessionPath(id).slice(0, -5);
  const unlock = await lock(sessionsDir, id);
  try {
    const session = await readSessionRecord(id);
    if (!session || session.root !== root) throw new Error('Session is no longer available in this project.');
    if (type === 'cache') await rm(base + '.summary', { force: true });
    else if (type === 'draft') await rm(base + '.draft.json', { force: true });
    else if (type === 'attachments') {
      let removed = 0;
      for (const job of session.queue) {
        if (job.harness || job.review || !job.attachments?.length) continue;
        removed += job.attachments.length;
        job.attachments = [];
      }
      if (removed) await writeSession(session, { separated: true });
      return removed;
    } else if (type === 'archive') {
      if (!session.archived || session.queue.length || session.undoInProgress)
        throw new Error('Archive the completed session before removing it.');
      await rm(base + '.json');
      for (const suffix of ['.summary', '.draft.json', '.project', '.records'])
        await rm(base + suffix, { force: true, recursive: suffix === '.records' });
    } else throw new Error('Use --clean cache, draft, attachments or archive.');
  } finally {
    await unlock();
  }
}

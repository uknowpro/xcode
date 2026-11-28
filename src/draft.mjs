import { lstat, rm } from 'node:fs/promises';
import { readJson, saveJson, sessionPath } from './store.mjs';

export const maxDraftLength = 32000;
const maxDraftBytes = 512 * 1024;
const draftPath = id => sessionPath(id).replace(/\.json$/, '.draft.json');

export async function readDraft(id) {
  const path = draftPath(id);
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.size > maxDraftBytes) throw new Error('Saved draft has an invalid size or file type.');
  const draft = await readJson(path, null);
  if (draft === null) return null;
  if (typeof draft.line !== 'string' || draft.line.length > maxDraftLength ||
      (draft.paste !== null && (!Array.isArray(draft.paste) || draft.paste.some(line => typeof line !== 'string') ||
       draft.paste.join('\n').length > maxDraftLength)) ||
      !Array.isArray(draft.attachments) || draft.attachments.some(path => typeof path !== 'string'))
    throw new Error('Saved draft has an invalid structure.');
  return draft;
}

export async function writeDraft(id, draft) {
  const path = draftPath(id);
  if (!draft.line && !draft.paste?.length && !draft.attachments.length) return rm(path, { force: true });
  if (Buffer.byteLength(JSON.stringify(draft, null, 2)) + 1 > maxDraftBytes)
    throw new Error('Draft is too large to save.');
  await saveJson(path, draft);
}

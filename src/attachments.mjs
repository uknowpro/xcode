import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isStatePath } from './store.mjs';
import { blocked, decodeText, loadBytes, verifiedFile } from './workspace.mjs';

const exec = promisify(execFile);
const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export const maxAttachments = 8;
export const maxAttachmentBytes = 12 * 1024 * 1024;
export const attachmentSize = item => Buffer.byteLength(JSON.stringify(item)) + 1;

export function splitArgs(input) {
  const parts = [];
  // Preserve Windows backslashes. Quotes delimit paths containing spaces.
  const token = /"([^"]*)"|'([^']*)'|[^\s"']+/g;
  let consumed = 0;
  for (const match of input.matchAll(token)) {
    if (input.slice(consumed, match.index).trim()) throw new Error('Close the quote around the path.');
    parts.push(match[1] ?? match[2] ?? match[0]);
    consumed = match.index + match[0].length;
  }
  if (input.slice(consumed).trim()) throw new Error('Close the quote around the path.');
  return parts;
}

export function explicitReferences(prompt) {
  return [...prompt.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s"'@]+))/g)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter(path => path !== '' && !path.includes('@'));
}

function parseAttachment(input) {
  const marker = /#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(input);
  if (!marker) return { file: input };
  const first = Number(marker[1]), last = Number(marker[2] ?? marker[1]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || last - first >= 1000)
    throw new Error('Select up to 1,000 text lines with #Lstart-Lend.');
  return { file: input.slice(0, marker.index), range: { first, last } };
}

async function attachmentFile(root, input, signal, { explicit = false, base = root } = {}) {
  const { file, range } = parseAttachment(input);
  let path;
  if (explicit) {
    const absolute = resolve(base, file);
    path = await realpath(absolute);
    if (blocked(absolute) || blocked(path) || isStatePath(absolute) || isStatePath(path) || !(await lstat(path)).isFile()) throw new Error('File excluded or unsupported.');
  } else {
    ({ path } = await verifiedFile(root, resolve(base, file), signal));
  }
  return { path, range };
}

export async function inspectAttachment(root, input, signal) {
  const { path, range } = await attachmentFile(root, input, signal, { explicit: true });
  return { name: basename(path), bytes: range ? null : (await lstat(path)).size, range };
}

async function attachmentLines(path, range, signal) {
  const limit = 16 * 1024 * 1024;
  const stream = createReadStream(path, { end: limit - 1, signal });
  let line = 1, size = 0;
  const chunks = [];
  for await (const data of stream) {
    let start = 0;
    while (start < data.length) {
      const boundary = data.indexOf(10, start);
      const end = boundary < 0 ? data.length : boundary + 1;
      if (line >= range.first) {
        size += end - start;
        if (size > 512 * 1024) throw new Error('Selected text exceeds 512 KiB. Attach a smaller line range.');
        chunks.push(data.subarray(start, end));
      }
      if (boundary >= 0 && ++line > range.last) return decodeText(Buffer.concat(chunks, size));
      start = end;
    }
  }
  if (stream.bytesRead >= limit) throw new Error('The selected lines extend beyond the 16 MiB scan limit.');
  if (!size) throw new Error('The selected lines are outside the file.');
  return decodeText(Buffer.concat(chunks, size));
}

export async function attach(root, input, profile, signal, options) {
  const { path, range } = await attachmentFile(root, input, signal, options);
  const name = basename(path);
  const type = extname(path).toLowerCase();
  if (range) {
    if (Object.hasOwn(images, type) || type === '.pdf') throw new Error('Line ranges apply to UTF-8 text files.');
    const text = await attachmentLines(path, range, signal);
    return { name, parts: [textPart(name, text, 'UTF-8 lines ' + range.first + '–' + range.last)] };
  }
  if (Object.hasOwn(images, type)) {
    if (!profile.imageInput) throw new Error('This profile has image input disabled. Use /inputs image on if your model supports it.');
    const bytes = await loadBytes(path, 5 * 1024 * 1024, signal);
    return { name, parts: [{ type: 'image_url', image_url: { url: 'data:' + images[type] + ';base64,' + bytes.toString('base64') } }] };
  }
  if (type === '.pdf') {
    const bytes = await loadBytes(path, 5 * 1024 * 1024, signal);
    if (profile.pdfInput) {
      return { name, parts: [{ type: 'file', file: { filename: name, file_data: 'data:application/pdf;base64,' + bytes.toString('base64') } }] };
    }
    try {
      const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '25', path, '-'], {
        signal, maxBuffer: 512 * 1024, timeout: 12000,
      });
      if (!stdout.trim()) throw new Error('No extractable PDF text.');
      return { name, parts: [textPart(name, stdout, 'PDF text, first 25 pages')] };
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'ENOENT') throw new Error('Install pdftotext for local PDF extraction or select a profile with native PDF input.');
      throw new Error('PDF text extraction failed. Use a supported model for native PDF input or attach UTF-8 text.');
    }
  }
  const bytes = await loadBytes(path, 512 * 1024, signal);
  return { name, parts: [textPart(name, decodeText(bytes), 'UTF-8 text')] };
}

function textPart(name, content, method) {
  const limit = 24000;
  return { type: 'text', text: 'Attachment ' + JSON.stringify(name) + ' (' + method + '):\n' +
    content.slice(0, limit) + (content.length > limit ? '\n[Attachment truncated]' : '') };
}

export function userMessage(prompt, attachments) {
  if (!attachments.length) return { role: 'user', content: prompt };
  return {
    role: 'user',
    content: [{ type: 'text', text: prompt }, ...attachments.flatMap(item => item.parts)],
  };
}

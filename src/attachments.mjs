import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { blocked, decodeText, loadBytes, verifiedFile } from './workspace.mjs';

const exec = promisify(execFile);
const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

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

export async function attach(root, input, profile, signal, { explicit = false, base = root } = {}) {
  let path;
  if (explicit) {
    const absolute = resolve(base, input);
    path = await realpath(absolute);
    if (blocked(absolute) || blocked(path) || !(await lstat(path)).isFile()) throw new Error('File excluded or unsupported.');
  } else {
    ({ path } = await verifiedFile(root, resolve(base, input), signal));
  }
  const name = basename(path);
  const type = extname(path).toLowerCase();
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

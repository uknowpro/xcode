import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { verifiedFile } from './workspace.mjs';

export async function openLocation(root, location, env = process.env) {
  const match = /^(.*?)(?::([1-9]\d*))?$/.exec(location ?? '');
  const path = match?.[1];
  if (!path) throw new Error('Use a workspace path with an optional :line.');
  const { path: file } = await verifiedFile(root, path);
  const editor = env.XCODE_EDITOR ?? env.VISUAL ?? env.EDITOR;
  if (!editor) throw new Error('Set XCODE_EDITOR to a local editor executable.');
  if (editor.includes('\0')) throw new Error('Invalid editor executable.');
  const name = basename(editor).replace(/\.exe$/i, '').toLowerCase();
  const line = match[2];
  let args = [file];
  if (line && ['code', 'code-insiders', 'cursor', 'codium'].includes(name)) args = ['--goto', file + ':' + line];
  else if (line && ['vim', 'nvim', 'vi', 'nano', 'emacs'].includes(name)) args = ['+' + line, file];
  return new Promise((resolve, reject) => {
    const child = spawn(editor, args, { shell: false, windowsHide: true, stdio: 'inherit' });
    child.on('error', () => reject(new Error('Could not launch the configured editor.')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Editor exited with code ' + code + '.')));
  });
}

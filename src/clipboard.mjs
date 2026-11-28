import { spawn } from 'node:child_process';

export function clipboardCommands(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return [['pbcopy']];
  if (platform === 'win32') return [['clip.exe']];
  return [
    ...(env.WAYLAND_DISPLAY ? [['wl-copy']] : []),
    ...(env.DISPLAY ? [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']] : []),
  ];
}

export function responseSelection(answer, block) {
  if (typeof answer !== 'string' || !answer) throw new Error('No completed response to copy.');
  if (block === undefined) return answer;
  const parsed = Number(block);
  const code = [...answer.matchAll(/^( {0,3})(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\2[ \t]*$/gm)];
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > code.length)
    throw new Error('Select a code block from 1 to ' + code.length + '.');
  return code[parsed - 1][3].replace(/\r?\n$/, '');
}

async function sendClipboard(command, input) {
  return new Promise(resolve => {
    const [file, ...args] = command;
    const child = spawn(file, args, {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      signal: AbortSignal.timeout(3000),
    });
    child.on('error', () => resolve(false));
    child.on('close', exit => resolve(exit === 0));
    child.stdin.on('error', () => resolve(false));
    child.stdin.end(input);
  });
}

export async function copyClipboard(text) {
  const payload = process.platform === 'win32' ? Buffer.from('\ufeff' + text, 'utf16le') : text;
  for (const command of clipboardCommands()) if (await sendClipboard(command, payload)) return;
  throw new Error('No supported desktop clipboard is available. Use the terminal copy shortcut.');
}

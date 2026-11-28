import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const service = 'uknowpro.xcode';

function invoke(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal: AbortSignal.timeout(15000) });
    const output = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) child.kill();
      else output.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Error('The operating system credential service is unavailable.')));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(output).toString('utf8').trimEnd()) :
      reject(new Error('The operating system credential request failed.')));
    child.stdin.end(input);
  });
}

function windows(action, input) {
  const prefix = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $inputText=[Console]::In.ReadToEnd(); ';
  const script = action === 'encrypt'
    ? 'ConvertFrom-SecureString (ConvertTo-SecureString $inputText -AsPlainText -Force)'
    : '$ptr=[Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode((ConvertTo-SecureString $inputText)); ' +
      'try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }';
  return invoke('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prefix + script], input);
}

export async function readCredential(storage, name) {
  if (process.platform === 'darwin') return invoke('security', ['find-generic-password', '-a', name, '-s', service, '-w']);
  if (process.platform === 'linux') return invoke('secret-tool', ['lookup', 'application', service, 'profile', name]);
  if (process.platform === 'win32') return windows('decrypt', JSON.parse(await readFile(join(storage, 'keychain', name + '.enc'), 'utf8')));
  throw new Error('Keychain storage is unavailable on this platform.');
}

export async function writeCredential(storage, name, token, saveEncrypted) {
  if (process.platform === 'darwin') {
    const escaped = token.replace(/[\\"]/g, char => '\\' + char);
    const instruction = token ? 'add-generic-password -a "' + name + '" -s "' + service + '" -U -w "' + escaped + '"' :
      'delete-generic-password -a "' + name + '" -s "' + service + '"';
    await invoke('security', ['-i'], instruction + '\nquit\n');
    if (token && await readCredential(storage, name) !== token) throw new Error('Could not verify the saved Keychain credential.');
  } else if (process.platform === 'linux') {
    if (token) await invoke('secret-tool', ['store', '--label=xcode API token', 'application', service, 'profile', name], token);
    else await invoke('secret-tool', ['clear', 'application', service, 'profile', name]);
  } else if (process.platform === 'win32') {
    const directory = join(storage, 'keychain');
    const path = join(directory, name + '.enc');
    if (!token) return rm(path, { force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await saveEncrypted(path, await windows('encrypt', token));
  } else throw new Error('Keychain storage is unavailable on this platform.');
}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const defaultTimeout = 120;
const outputLimit = 12000;
export const checkName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;

export function projectChecks(config, root) {
  return Object.hasOwn(config.projectChecks ?? {}, root) ? config.projectChecks[root] : {};
}

export function defineCheck(argv, timeout = defaultTimeout) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 32 ||
    argv.some(arg => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0')) || !argv[0]?.trim())
    throw new Error('Provide an executable and up to 31 arguments.');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
    throw new Error('Check timeout must be 1–600 seconds.');
  return { argv, timeout };
}

function kill(child, signal = 'SIGTERM') {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // The CLI owns this process tree. No command or arguments come from the model.
    const stopper = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    stopper.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function resolveCommand(argv) {
  if (argv[0] === 'node') return [process.execPath, ...argv.slice(1)];
  if (process.platform === 'win32' && argv[0].toLowerCase() === 'npm') {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(npmCli)) return [process.execPath, npmCli, ...argv.slice(1)];
  }
  return argv;
}

export async function runCheck(root, checks, name, signal) {
  if (typeof name !== 'string' || !checkName.test(name) || !Object.hasOwn(checks, name))
    throw new Error('Unknown project check. Configure it with xcode check add.');
  const { argv, timeout } = defineCheck(checks[name].argv, checks[name].timeout);
  signal?.throwIfAborted();
  const [file, ...args] = resolveCommand(argv);
  const started = Date.now();
  const env = { ...process.env };
  delete env.XCODE_API_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    let stopReason;
    let force;
    function stop(reason) {
      if (stopReason) return;
      stopReason = reason;
      kill(child);
      if (process.platform !== 'win32') force = setTimeout(() => kill(child, 'SIGKILL'), 1000);
    }
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed out'), timeout * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const key of ['stdout', 'stderr']) {
      child[key].setEncoding('utf8');
      child[key].on('data', text => { output[key] = (output[key] + text).slice(-outputLimit); });
    }
    child.on('error', error => {
      cleanup();
      reject(new Error('Unable to start "' + name + '"' + (error.code ? ' (' + error.code + ')' : '') + '.'));
    });
    child.on('close', (exitCode, exitSignal) => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason);
      resolve({
        name, command: argv, timeout, durationMs: Date.now() - started, exitCode, exitSignal,
        status: stopReason ?? (exitCode === 0 ? 'passed' : 'failed'), ...output,
      });
    });
  });
}

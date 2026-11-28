import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Workspace } from './workspace.mjs';
import { checkLimit } from './limits.mjs';

const defaultTimeout = 120;
const outputLimit = 12000;
export const checkName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;

export function projectChecks(config, root) {
  const checks = config.projectChecks?.[root];
  return checks && typeof checks === 'object' && !Array.isArray(checks) ? checks : {};
}

export function defineCheck(argv, timeout = defaultTimeout, directory = '.') {
  if (!Array.isArray(argv) || !argv.length || argv.length > 32 ||
    argv.some(arg => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0')) || !argv[0]?.trim())
    throw new Error('Provide an executable and up to 31 arguments.');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600)
    throw new Error('Check timeout must be 1–600 seconds.');
  if (typeof directory !== 'string' || !directory || directory.includes('\0') || isAbsolute(directory) ||
      directory.split(/[\\/]/).includes('..')) throw new Error('Check directory must be relative to the workspace.');
  return { argv, timeout, ...(directory !== '.' ? { directory } : {}) };
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

export function checkKey(argv, timeout, directory) {
  return createHash('sha256').update(JSON.stringify([argv, timeout, ...(directory && directory !== '.' ? [directory] : [])])).digest('hex');
}

export function redactSecrets(value, secrets = []) {
  let safe = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) safe = safe.replaceAll(secret, '[redacted]');
  }
  return safe.replace(/\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{35,})\b/g,
    '[redacted]');
}

export async function runCheck(root, checks, name, signal, options = {}) {
  return checkLimit.run(signal, () => runRegisteredCheck(root, checks, name, signal, options));
}

async function runRegisteredCheck(root, checks, name, signal, { secrets = [] } = {}) {
  if (typeof name !== 'string' || !checkName.test(name) || !Object.hasOwn(checks, name))
    throw new Error('Unknown project check. Configure it with xcode check add.');
  const { argv, timeout, directory } = defineCheck(checks[name]?.argv, checks[name]?.timeout, checks[name]?.directory);
  const cwd = new Workspace(root).scope(directory);
  if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error('Check directory is unavailable or is a symbolic link.');
  signal?.throwIfAborted();
  const [file, ...args] = resolveCommand(argv);
  const started = Date.now();
  const env = { ...process.env };
  delete env.XCODE_API_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    const cut = { stdout: false, stderr: false };
    const protectedValues = [...secrets, process.env.XCODE_API_TOKEN];
    // Keep extra trailing bytes so a token split at the retention boundary can still be erased.
    const maxSecretLength = Math.max(256, ...protectedValues.map(value => value?.length ?? 0));
    const captureLimit = outputLimit + maxSecretLength;
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
      child[key].on('data', text => {
        const combined = output[key] + text;
        cut[key] ||= combined.length > outputLimit;
        output[key] = combined.slice(-captureLimit);
      });
    }
    child.on('error', error => {
      cleanup();
      reject(new Error('Unable to start "' + name + '"' + (error.code ? ' (' + error.code + ')' : '') + '.'));
    });
    child.on('close', (exitCode, exitSignal) => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason);
      resolve({
        name, command: argv.map(arg => redactSecrets(arg, protectedValues)), commandKey: checkKey(argv, timeout, directory),
        timeout, ...(directory ? { directory } : {}), durationMs: Date.now() - started, exitCode, exitSignal,
        status: stopReason ?? (exitCode === 0 ? 'passed' : 'failed'),
        stdout: redactSecrets(output.stdout, protectedValues).slice(-outputLimit),
        stderr: redactSecrets(output.stderr, protectedValues).slice(-outputLimit),
        ...(cut.stdout || cut.stderr ? { truncated: cut } : {}),
      });
    });
  });
}

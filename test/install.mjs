import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run test:install.');
const scratch = await mkdtemp(join(tmpdir(), 'xcode-install-'));
const env = { ...process.env, npm_config_cache: join(scratch, 'cache') };

async function npmRun(...args) {
  return exec(process.execPath, [npm, ...args], { env, timeout: 60000 });
}

try {
  const packed = await npmRun('pack', '--json', '--pack-destination', scratch);
  const [manifest] = JSON.parse(packed.stdout);
  await npmRun('install', '--offline', '--no-audit', '--ignore-scripts', '--prefix', scratch, join(scratch, manifest.filename));
  const version = await npmRun('exec', '--offline', '--prefix', scratch, '--', 'xcode', '--version');
  assert.equal(version.stdout.trim(), manifest.version);
  console.log('Installed xcode ' + manifest.version + ' and ran the CLI shim.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

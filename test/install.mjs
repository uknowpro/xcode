import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run test:install.');
const scratch = await mkdtemp(join(tmpdir(), 'xcode-install-'));
const state = join(scratch, 'state');
const baseline = join(scratch, 'baseline');
const prefix = join(scratch, 'app');
const workspace = join(scratch, 'workspace');
const env = { ...process.env, npm_config_cache: join(scratch, 'cache'), XCODE_HOME: state };
delete env.XCODE_API_TOKEN;
// Verify installation over the preceding main version.
const baselineCommit = 'eb6ff37b5ddc3d03b250fce7784d45d9ed287ca6';
let worktreeAdded = false;
let endpoint;

function npmRun(args, { cwd, input } = {}) {
  const run = exec(process.execPath, [npm, ...args], { cwd, env, timeout: 60000 });
  if (input !== undefined) run.child.stdin.end(input);
  return run;
}

async function pack(cwd) {
  const { stdout } = await npmRun(['pack', '--json', '--pack-destination', scratch], { cwd });
  return JSON.parse(stdout)[0];
}

async function install(manifest) {
  await npmRun(['install', '--offline', '--no-audit', '--ignore-scripts', '--prefix', prefix, join(scratch, manifest.filename)]);
  const { stdout } = await cli(['--version']);
  assert.equal(stdout.trim(), manifest.version);
}

function cli(args, input) {
  return npmRun(['exec', '--offline', '--prefix', prefix, '--', 'xcode', ...args], { input });
}

try {
  await mkdir(workspace);
  await exec('git', ['worktree', 'add', '--detach', baseline, baselineCommit]);
  worktreeAdded = true;
  const oldPackage = await pack(baseline);
  await install(oldPackage);

  endpoint = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    if (req.headers.authorization !== 'Bearer upgrade-test-token') {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve, reject) => {
    endpoint.on('error', reject);
    endpoint.listen(0, '127.0.0.1', resolve);
  });

  const address = 'http://127.0.0.1:' + endpoint.address().port + '/v1';
  await cli(['profile', 'set', 'upgrade', '--endpoint', address, '--model', 'fixture', '--token-stdin'], 'upgrade-test-token\n');
  await cli(['ask', '--cwd', workspace, 'Retain this existing session']);
  const tokenFile = join(state, 'tokens.json');
  const savedTokens = await readFile(tokenFile, 'utf8');
  const settingsFile = join(state, 'settings.json');
  const savedSettings = await readFile(settingsFile, 'utf8');
  const sessionsDir = join(state, 'sessions');
  const [session] = (await readdir(sessionsDir)).filter(name => name.endsWith('.json'));
  const sessionPath = join(sessionsDir, session);
  const savedSession = await readFile(sessionPath, 'utf8');
  const oldSessions = await cli(['sessions', '--cwd', workspace]);
  assert.match(oldSessions.stdout, /Retain this existing session/);

  const current = await pack(process.cwd());
  await install(current);
  const diagnostic = await cli(['profile', 'test', '--only', 'chat']);
  assert.match(diagnostic.stdout, /CHAT PASS/);
  assert.equal(await readFile(tokenFile, 'utf8'), savedTokens);
  assert.equal(await readFile(settingsFile, 'utf8'), savedSettings);
  assert.equal(await readFile(sessionPath, 'utf8'), savedSession);
  assert.equal((await cli(['sessions', '--cwd', workspace])).stdout, oldSessions.stdout);
  console.log('Installed xcode ' + current.version + ' over ' + oldPackage.version + ' and preserved its profile, token and session.');
} finally {
  if (endpoint?.listening) {
    endpoint.closeAllConnections();
    await new Promise(resolve => endpoint.close(resolve));
  }
  try {
    if (worktreeAdded) await exec('git', ['worktree', 'remove', baseline]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

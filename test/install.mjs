import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
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
const baselineCommit = '67679a1e6d038a3417587f1a6c1b1aedc5c8b391';
let worktreeAdded = false;
let endpoint;

function npmRun(args, { cwd, input } = {}) {
  const run = exec(process.execPath, [npm, ...args], { cwd, env, timeout: Number(process.env.XCODE_TEST_TIMEOUT_MS ?? 60000) });
  if (input !== undefined) run.child.stdin.end(input);
  return run;
}

async function pack(cwd) {
  const { stdout } = await npmRun(['pack', '--json', '--pack-destination', scratch], { cwd });
  const manifest = JSON.parse(stdout)[0];
  assert.ok(manifest.files.some(file => file.path === 'src/cli.mjs'));
  assert.ok(!manifest.files.some(file => /(?:^|\/)(?:\.xcode|\.env(?:\..*)?|tokens\.json|settings\.json|sessions)(?:\/|$)/.test(file.path)));
  return manifest;
}

async function install(manifest, target = prefix) {
  await npmRun(['install', '--offline', '--no-audit', '--ignore-scripts', '--prefix', target, join(scratch, manifest.filename)]);
  const { stdout } = await npmRun(['exec', '--offline', '--prefix', target, '--', 'xcode', '--version']);
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
  const starting = performance.now();
  await install(current, join(scratch, 'clean-install'));
  const installMs = Math.round(performance.now() - starting);
  const upgrading = performance.now();
  await install(current);
  const upgradeMs = Math.round(performance.now() - upgrading);
  const diagnostic = await cli(['profile', 'test', '--only', 'chat']);
  assert.match(diagnostic.stdout, /CHAT PASS/);
  assert.equal(await readFile(tokenFile, 'utf8'), savedTokens);
  assert.equal(await readFile(settingsFile, 'utf8'), savedSettings);
  assert.equal(await readFile(sessionPath, 'utf8'), savedSession);
  assert.equal((await cli(['sessions', '--cwd', workspace])).stdout, oldSessions.stdout);
  console.log('Installed xcode ' + current.version + ' over ' + oldPackage.version + ' and preserved its profile, token and session.');
  const legacy = JSON.parse(savedSession);
  legacy.turns.push(...Array.from({ length: 15 }, (_, index) => ({
    prompt: 'Recovery fixture ' + index, answer: 'Recovery answer ' + index,
    status: 'complete', completed: [], changed: [], tools: [], checks: [], attachments: [],
  })));
  await writeFile(sessionPath, JSON.stringify(legacy));
  await cli(['session', 'pin', 'latest', '--cwd', workspace]);
  assert.ok(JSON.parse(await readFile(sessionPath, 'utf8')).olderTurns.length > 0);
  const backup = join(scratch, 'portable-session.json');
  await cli(['session', 'backup', 'latest', '--cwd', workspace, '--output', backup]);
  const compatible = await readFile(backup, 'utf8');
  assert.equal(JSON.parse(compatible).turns.length, legacy.turns.length);
  assert.equal(JSON.parse(compatible).turns[0].prompt, legacy.turns[0].prompt);
  await writeFile(sessionPath, compatible);
  await install(oldPackage);
  assert.match((await cli(['sessions', '--cwd', workspace])).stdout, /Retain this existing session/);
  const downgraded = await cli(['profile', 'test', '--only', 'chat']);
  assert.match(downgraded.stdout, /CHAT PASS/);
  if (process.env.XCODE_INSTALL_REPORT) await writeFile(process.env.XCODE_INSTALL_REPORT, JSON.stringify({
    installMs, upgradeMs, installPassed: true, upgradePassed: true, rollbackPassed: true,
  }, null, 2) + '\n');
  console.log('Downgraded to xcode ' + oldPackage.version + ' and restored its compatible session backup.');
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

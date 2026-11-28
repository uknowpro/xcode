import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
if (!process.env.npm_execpath) throw new Error('Run npm run package:release.');
const directory = resolve(process.argv[2] || 'dist');
await mkdir(directory, { recursive: true });
const { stdout } = await run(process.execPath, [process.env.npm_execpath, 'pack', '--offline', '--json', '--pack-destination', directory]);
const [packed] = JSON.parse(stdout);
const bytes = await readFile(join(directory, packed.filename));
const sha = createHash('sha256').update(bytes).digest('hex');
await writeFile(join(directory, 'SHA256SUMS'), sha + '  ' + packed.filename + '\n');
const validation = await mkdtemp(join(tmpdir(), 'xcode-reproduce-package-'));
try {
  await run(process.execPath, [process.env.npm_execpath, 'pack', '--offline', '--json', '--pack-destination', validation]);
  const digest = createHash('sha256').update(await readFile(join(validation, packed.filename))).digest('hex');
  if (digest !== sha) throw new Error('The second build produced a different archive.');
} finally { await rm(validation, { recursive: true, force: true }); }
const git = await run('git', ['rev-parse', 'HEAD']).catch(() => null);
const status = await run('git', ['status', '--porcelain', '--untracked-files=no']).catch(() => null);
const npm = await run(process.execPath, [process.env.npm_execpath, '--version']);
const manifest = { version: 1, package: packed.filename, packageBytes: bytes.length, sha256: sha, reproducible: true,
  commit: git?.stdout.trim() ?? null, worktreeDirty: Boolean(status?.stdout.trim()),
  environment: { node: process.versions.node, npm: npm.stdout.trim(), platform: process.platform, arch: process.arch } };
await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ package: packed.filename, bytes: bytes.length, sha256: sha }));

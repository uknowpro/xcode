import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
console.log(JSON.stringify({ package: packed.filename, bytes: bytes.length, sha256: sha }));

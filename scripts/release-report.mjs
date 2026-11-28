import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'dist');
const report = {};
for (const file of ['release-manifest.json', 'workspace-benchmark.json', 'install-report.json']) {
  try { Object.assign(report, JSON.parse(await readFile(join(directory, file), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(join(directory, 'release-report.json'), JSON.stringify(report, null, 2) + '\n');

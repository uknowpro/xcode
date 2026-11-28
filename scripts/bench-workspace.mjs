import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' } } });
const { Workspace } = values.source ? await import(pathToFileURL(join(resolve(values.source), 'src/workspace.mjs')).href) :
  await import('../src/workspace.mjs');
const root = await mkdtemp(join(tmpdir(), 'xcode-search-bench-'));
try {
  for (let part = 0; part < 10; part++) {
    const directory = join(root, 'module-' + part);
    await mkdir(directory);
    for (let row = 0; row < 100; row++) {
      await writeFile(join(directory, 'file-' + row + '.ts'), row === 0 ? 'export const needle = true;' : 'export const row = ' + row + ';');
    }
  }
  const workspace = new Workspace(root);
  const duration = from => Number((performance.now() - from).toFixed(2));
  const start = performance.now();
  let first;
  const match = await workspace.search({ query: 'needle', onMatch: () => { first ??= duration(start); } });
  const elapsed = duration(start);
  const controller = new AbortController();
  let stopped;
  const stop = () => { stopped = performance.now(); controller.abort(); };
  setTimeout(stop, 10).unref();
  let cancellationMs;
  try { await new Workspace(root).search({ query: 'never present' }, controller.signal); }
  catch (error) {
    if (!controller.signal.aborted) throw error;
    cancellationMs = duration(stopped);
  }
  const report = { fixtureFiles: 1000, matches: match.matches.length, firstResultMs: first ?? elapsed,
    firstResultMode: first === undefined ? 'completion' : 'first-match', elapsedMs: elapsed, cancellationMs, peakRssKiB: process.resourceUsage().maxRSS };
  const output = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(resolve(values.output), output);
  process.stdout.write(output);
} finally { await rm(root, { recursive: true, force: true }); }

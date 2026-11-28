import { readFile } from 'node:fs/promises';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Pass the previous and candidate release report files.');
const before = JSON.parse(await readFile(beforePath, 'utf8'));
const after = JSON.parse(await readFile(afterPath, 'utf8'));
const fields = [
  ['packageBytes', 1.6, 65536], ['firstResultMs', 1.5, 40], ['cancellationMs', 1.5, 40],
  ['peakRssKiB', 1.4, 16384], ['installMs', 1.5, 1000], ['upgradeMs', 1.5, 1000],
];
const comparisons = fields.map(([field, ratio, grace]) => {
  const a = before[field], b = after[field];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { field, status: 'missing' };
  const limit = Math.max(a * ratio, a + grace);
  return { field, previous: a, candidate: b, limit, status: b <= limit ? 'pass' : 'regressed' };
});
for (const field of ['installPassed', 'upgradePassed', 'rollbackPassed']) {
  comparisons.push({ field, previous: before[field] ?? null, candidate: after[field] ?? null,
    status: after[field] === true ? 'pass' : after[field] === false ? 'regressed' : 'missing' });
}
process.exitCode = comparisons.some(row => row.status === 'regressed') ? 1 : 0;
console.log(JSON.stringify({ version: 1, comparisons }, null, 2));

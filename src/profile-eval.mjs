import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from './agent.mjs';

class EvaluationCheckpoint extends Error {}

export async function evaluateProfile(profile, token, { timeout = 120000 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xcode-profile-eval-')));
  const start = performance.now();
  const results = { search: false, read: false, resume: false, check: false, citation: false };
  let job = {
    prompt: 'Use grep to locate the fixture constant invoiceLimit, then use read on its source, and run the registered unit check. Cite the exact filename and line where invoiceLimit is exported. Complete the three tool actions before answering.',
    attachments: [], completed: [], changed: [], tools: [],
    harness: { stages: [{ name: 'Fixture', instruction: 'Use grep, read, and run_check. The unit check is named unit.', tools: ['grep', 'read', 'run_check'] }] },
  };
  const test = 'import assert from "node:assert/strict";\nimport { invoiceLimit } from "./invoice.mjs";\nassert.equal(invoiceLimit, 7);\n';
  const config = {
    harnesses: {},
    projectChecks: { [root]: { unit: { argv: ['node', 'fixture.test.mjs'], timeout: 20 } } },
  };
  const session = { root, turns: [], harness: 'profile-eval', checks: true };
  const signal = AbortSignal.timeout(timeout);
  let error;
  let checkpoint = false;
  let answer = '';
  try {
    await writeFile(join(root, 'invoice.mjs'), '// Profile evaluation fixture\n\nexport const invoiceLimit = 7;\n');
    await writeFile(join(root, 'fixture.test.mjs'), test);
    const run = save => runJob({ session, job, config, profile, token, signal, emit: () => {}, save, isolated: true });
    try {
      answer = await run(async () => {
        if (job.stageHistory?.length) {
          checkpoint = true;
          throw new EvaluationCheckpoint();
        }
      });
    } catch (cause) {
      if (!(cause instanceof EvaluationCheckpoint)) throw cause;
      job = JSON.parse(JSON.stringify(job));
      answer = await run(async () => {});
      results.resume = true;
    }
  } catch (cause) {
    error = cause.name === 'TimeoutError' ? 'Evaluation timed out.' : cause.message;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  results.search = job.tools.some(tool => tool.name === 'grep' && tool.matches > 0 && !tool.error);
  results.read = job.readPaths?.includes('invoice.mjs') ?? false;
  results.check = job.checks?.some(check => check.name === 'unit' && check.exitCode === 0 && check.status === 'passed') ?? false;
  results.citation = /invoice\.mjs:3\b/.test(answer);
  return {
    ...results, checkpoint, durationMs: Math.round(performance.now() - start),
    metrics: {
      toolCalls: job.tools.length,
      checkMs: (job.checks ?? []).reduce((sum, check) => sum + check.durationMs, 0),
    },
    ...(error ? { error } : {}),
  };
}

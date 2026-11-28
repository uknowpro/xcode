import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkName, runCheck, redactSecrets } from './checks.mjs';
import { checkLocations } from './repair.mjs';
import { loadBytes, verifiedFile } from './workspace.mjs';
import { lock, readJson, saveJson, storage } from './store.mjs';

const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const location = root => join(storage, 'check-plans', signature(root));

export function checkSettings(checks, name, options) {
  if (!Object.hasOwn(checks, name)) throw new Error('Unknown registered check.');
  const after = [...new Set(options.after ?? checks[name].after ?? [])];
  if (after.length > 30 || after.some(item => item === name || !Object.hasOwn(checks, item))) throw new Error('Invalid check dependency.');
  const idleSeconds = Number(options['idle-seconds'] ?? checks[name].idleSeconds ?? 0);
  if (!Number.isSafeInteger(idleSeconds) || idleSeconds < 0 || idleSeconds > 600) throw new Error('Invalid check idle limit.');
  const reportFormat = options['report-format'] ?? checks[name].reportFormat;
  const reportFile = options['report-file'] ?? checks[name].reportFile;
  if (reportFormat !== undefined && (!['json', 'junit'].includes(reportFormat) || !reportFile))
    throw new Error('A report needs a file and json or junit format.');
  const { after: _after, idleSeconds: _idle, ...old } = checks[name];
  return { ...old, ...(after.length ? { after } : {}), ...(idleSeconds ? { idleSeconds } : {}),
    ...(reportFormat ? { reportFormat, reportFile } : {}) };
}

export function checkPlan(root, checks, names) {
  if (!Array.isArray(names) || !names.length) throw new Error('Choose registered checks to plan.');
  const rows = [], visited = new Set(), visiting = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error('Cyclic check dependencies at ' + name);
    if (visited.has(name)) return;
    if (typeof name !== 'string' || !checkName.test(name) || !Object.hasOwn(checks, name)) throw new Error('Unknown registered check: ' + name);
    if (visited.size + visiting.size >= 100) throw new Error('Check plan exceeds 100 jobs.');
    const spec = checks[name];
    const after = spec.after ?? [];
    if (!Array.isArray(after)) throw new Error('Invalid saved dependency list.');
    visiting.add(name);
    for (const parent of after) visit(parent);
    visiting.delete(name);
    visited.add(name);
    rows.push({ name, after, command: signature(spec) });
  }
  for (const name of names) visit(name);
  return { schemaVersion: 1, workspace: signature(root), id: randomUUID(), names, rows };
}

function number(value, fallback, max) {
  const input = Number(value ?? fallback);
  if (!Number.isSafeInteger(input) || input < 1 || input > max) throw new Error('Invalid check run count or concurrency.');
  return input;
}

async function reportEvidence(root, check, secrets) {
  if (!check.reportFile || !check.reportFormat) return {};
  const target = await verifiedFile(root, resolve(root, check.directory ?? '.', check.reportFile));
  const data = (await loadBytes(target.path, 512 * 1024)).toString('utf8');
  const limited = text => redactSecrets(String(text ?? ''), secrets).slice(0, 300);
  if (check.reportFormat === 'json') {
    const document = JSON.parse(data);
    const entries = Array.isArray(document) ? document : document.tests ?? [];
    if (!Array.isArray(entries)) throw new Error('Invalid JSON test report.');
    return { reportBytes: target.info.size, failures: entries.filter(row => ['fail', 'failed', 'error'].includes(row?.status))
      .slice(0, 100).map(row => ({ test: limited(row.name), message: limited(row.message), location: limited(row.location) })) };
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(data)) throw new Error('Unsupported XML document declaration.');
  const failures = [];
  for (const row of data.matchAll(/<testcase\b([^>]*?)>([\s\S]*?)<\/testcase>/gi)) {
    const outcome = /<(?:failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/i.exec(row[2]);
    if (!outcome) continue;
    const field = (text, name) => new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(text)?.[1];
    failures.push({ test: limited(field(row[1], 'name')), message: limited(field(outcome[1], 'message') ?? outcome[2]),
      location: limited([field(row[1], 'file'), field(row[1], 'line')].filter(Boolean).join(':')) });
    if (failures.length >= 100) break;
  }
  return { reportBytes: target.info.size, failures };
}

export async function checkWithEvidence(root, checks, name, signal, options = {}) {
  const result = await runCheck(root, checks, name, signal, options);
  const warnings = ((result.stdout ?? '') + '\n' + (result.stderr ?? '')).match(/^.*\bwarning\b.*$/gim)?.length ?? 0;
  const evidence = await reportEvidence(root, checks[name], options.secrets ?? []).catch(() => ({ reportUnavailable: true }));
  return { ...result, warnings, locations: checkLocations(result), ...evidence };
}

export async function savedCheckRun(root, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Choose a saved check run ID.');
  const state = await readJson(join(location(root), id + '.json'), null);
  if (!state || state.plan.workspace !== signature(root)) throw new Error('Check run not found in this workspace.');
  return state;
}

export async function executeCheckPlan(root, checks, plan, { signal, secrets, onEvent, parallel, resume = false, logs = false } = {}) {
  const expected = checkPlan(root, checks, plan.names);
  if (plan.schemaVersion !== 1 || plan.workspace !== expected.workspace || JSON.stringify(plan.rows) !== JSON.stringify(expected.rows) ||
    !/^[0-9a-f-]{36}$/.test(plan.id)) throw new Error('Plan does not match the current registered checks.');
  const directory = location(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = await lock(directory, plan.id);
  const path = join(directory, plan.id + '.json');
  try {
    const saved = await readJson(path, null);
    if (saved && !resume) throw new Error('Plan has a saved run. Use resume-plan with its ID.');
    const state = saved ?? { schemaVersion: 1, plan, results: {} };
    state.results = Object.assign(Object.create(null), state.results);
    const max = number(parallel, 1, 4);
    const todo = plan.rows.filter(row => !state.results[row.name] || ['interrupted', 'blocked'].includes(state.results[row.name].status));
    await saveJson(path, state);
    while (todo.length) {
      signal?.throwIfAborted();
      const batch = todo.filter(row => row.after.every(name => state.results[name] && !['interrupted', 'blocked'].includes(state.results[name].status) ||
        state.results[name]?.status === 'blocked' && !todo.some(item => item.name === name))).slice(0, max);
      if (!batch.length) throw new Error('Saved plan contains unsatisfied dependencies.');
      const results = await Promise.all(batch.map(async row => {
        if (row.after.some(name => state.results[name]?.status !== 'passed')) return { name: row.name, status: 'blocked' };
        onEvent?.({ type: 'start', name: row.name });
        try {
          return await checkWithEvidence(root, checks, row.name, signal, {
            secrets, logFile: logs ? join(directory, plan.id + '-' + row.name + '.log') : undefined,
            onProgress: bytes => onEvent?.({ type: 'progress', name: row.name, bytes }),
          });
        } catch {
          return { name: row.name, status: signal?.aborted ? 'interrupted' : 'error' };
        }
      }));
      for (const row of results) {
        state.results[row.name] = row;
        todo.splice(todo.findIndex(item => item.name === row.name), 1);
        onEvent?.({ type: 'finish', name: row.name, status: row.status, locations: row.locations });
      }
      await saveJson(path, state);
    }
    return state;
  } finally { await unlock(); }
}

export function comparePlans(before, after) {
  const metrics = items => Object.values(items).reduce((out, row) => ({
    durationMs: out.durationMs + (row.durationMs ?? 0), warnings: out.warnings + (row.warnings ?? 0),
    reportBytes: out.reportBytes + (row.reportBytes ?? 0),
  }), { durationMs: 0, warnings: 0, reportBytes: 0 });
  const old = metrics(before.results), newer = metrics(after.results);
  return Object.fromEntries(Object.keys(old).map(key => [key, { before: old[key], after: newer[key], delta: newer[key] - old[key] }]));
}

export async function repeatedCheck(root, checks, name, repeat, signal, options) {
  const results = [];
  for (let i = 0; i < number(repeat, 3, 5); i++) results.push(await checkWithEvidence(root, checks, name, signal, options));
  const outcomes = new Set(results.map(row => JSON.stringify([row.status, row.exitCode, row.failures?.map(item => item.test)])));
  return { flakyCandidate: outcomes.size > 1, runs: results.map(row => ({ status: row.status, exitCode: row.exitCode,
    durationMs: row.durationMs, warnings: row.warnings, failures: row.failures })) };
}

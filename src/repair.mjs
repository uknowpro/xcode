import { checkKey, runCheck } from './checks.mjs';

export function latestChecks(checks) {
  const latest = new Map();
  for (const check of checks ?? []) latest.set(check.name, check);
  return [...latest.values()];
}

export function checkLocations(check) {
  const text = (check.stderr ?? '') + '\n' + (check.stdout ?? '');
  return [...new Set(text.match(/(?:^|[\s(])([\w./\\-]+\.[\w-]+:\d+(?::\d+)?)/gm)
    ?.map(value => value.trim().replace(/^\(/, '')) ?? [])].slice(0, 8);
}

export function compareCheckRuns(checks) {
  const pairs = new Map();
  for (const check of checks) {
    const previous = pairs.get(check.name)?.at(-1);
    pairs.set(check.name, previous ? [previous, check] : [check]);
  }
  return [...pairs].filter(([_name, pair]) => pair.length === 2).map(([name, [before, after]]) =>
    name + ' · ' + before.status + ' → ' + after.status +
    (after.exitCode == null ? '' : ' · exit ' + after.exitCode) +
    ' · ' + checkLocations(after).slice(0, 3).join(', ')).map(line => line.replace(/ · $/, ''));
}

export function checkEvidence(check, limit = 1200) {
  const lines = ((check.stderr ?? '') + '\n' + (check.stdout ?? '')).split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  const paths = [...new Set(lines.flatMap(line => line.match(/(?:[\w./\\-]+\.[\w-]+):\d+(?::\d+)?/g) ?? []))].slice(0, 4);
  const message = lines.slice(-12).join('\n').slice(-limit);
  return check.name + ' · ' + check.status + (check.exitCode == null ? '' : ' · exit ' + check.exitCode) +
    (paths.length ? '\nLocations: ' + paths.join(', ') : '') +
    (check.truncated ? '\nShowing the end of limited output.' : '') + (message ? '\n' + message : '');
}

export function stagePlan(job) {
  return job.plan ?? job.harness.stages;
}

export function scheduleRepair(job, index, session) {
  const stage = stagePlan(job)[index];
  const limit = stage.repairAttempts ?? 0;
  const failure = latestChecks(job.checks?.filter(check => check.stageIndex === index));
  const checks = failure.filter(check => check.status === 'failed' && Number.isInteger(check.exitCode) && check.exitCode !== 0);
  if (!checks.length || !limit || !session.write || !session.checks) return undefined;
  const attempt = (stage.repairAttempt ?? 0) + 1;
  if (attempt > limit) return { exhausted: true, names: checks.map(check => check.name) };
  const repairIndex = index + 1;
  const evidence = checks.map(check => checkEvidence(check)).join('\n\n');
  const savedChecks = checks.map(({ name, command, commandKey, timeout }) => ({ name, command, commandKey, timeout }));
  job.plan ??= [...job.harness.stages];
  job.plan.splice(repairIndex, 0, {
    name: 'Repair ' + attempt,
    instruction: 'Investigate these observed test failures. Read the relevant source lines and propose a focused fix if evidence supports it. ' +
      'Wait for review. When the user declines, report the failure and its likely cause.\n\n' + evidence,
    tools: ['glob', 'grep', 'read', 'project_guides', 'repo_map', 'propose_changes', 'edit'],
    repairFor: { attempt, names: savedChecks.map(check => check.name) },
  }, {
    name: 'Recheck ' + attempt,
    instruction: 'Report the automatically re-run checks and their exit status. Use the recorded output as evidence and identify remaining failures.',
    tools: ['glob', 'grep', 'read', 'project_guides'],
    repairAttempt: attempt,
    repairAttempts: limit,
    recheck: { repairIndex, checks: savedChecks },
  });
  return { attempt, names: savedChecks.map(check => check.name) };
}

export async function recheck(stage, job, session, configured, { signal, save, emit, stageIndex, token }) {
  if (!stage.recheck) return null;
  const approvals = job.approvals ?? [];
  if (!approvals.some(approval => approval.stageIndex === stage.recheck.repairIndex && approval.files.length))
    return { skipped: 'No repair was approved and applied. The previous verification still failed.' };
  if (!session.checks) return { skipped: 'Automatic rerun skipped because checks are disabled for this session.' };
  for (const original of stage.recheck.checks) {
    const check = Object.hasOwn(configured, original.name) ? configured[original.name] : null;
    const same = check && (original.commandKey
      ? checkKey(check.argv, check.timeout, check.directory) === original.commandKey
      : JSON.stringify(check.argv) === JSON.stringify(original.command) &&
        (original.timeout === undefined || original.timeout === check.timeout));
    if (!same)
      return { skipped: 'The registered command for ' + original.name + ' changed. Run the current check explicitly.' };
  }
  job.checks ??= [];
  const results = [];
  for (const original of stage.recheck.checks) {
    signal.throwIfAborted();
    let result = job.checks.find(check => check.stageIndex === stageIndex && check.automatic && check.name === original.name);
    if (!result) {
      result = { ...await runCheck(session.root, configured, original.name, signal, { secrets: [token] }), stageIndex, automatic: true };
      job.checks.push(result);
      await save();
      emit({ type: 'note', text: 'Recheck · ' + checkEvidence(result, 550) });
    }
    results.push(result);
  }
  return { results };
}

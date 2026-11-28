import { readFile } from 'node:fs/promises';
import { diagnose } from './diagnostic.mjs';
import { modelEndpoint, modelPolicy } from './model-profile.mjs';
import { latestChecks } from './repair.mjs';

const failurePhases = new Set(['request', 'dns', 'connect', 'tls', 'auth', 'http', 'response', 'stream']);
const stages = new Set(['chat', 'sse', 'tools']);
const outcomes = new Set(['pass', 'fail', 'skip']);

function safeFailure(value) {
  if (!failurePhases.has(value?.phase)) return undefined;
  const httpStatus = Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
    ? value.httpStatus : undefined;
  return {
    phase: value.phase, ...(httpStatus ? { httpStatus } : {}),
    ...(value.code === 'TIMEOUT' ? { timedOut: true } : {}),
  };
}

function profileSummary(profile) {
  if (!profile) return { state: 'missing' };
  try {
    const policy = modelPolicy(profile);
    const endpoint = modelEndpoint(profile, policy);
    return {
      state: 'configured', transport: endpoint.protocol === 'https:' ? 'https' : 'http',
      protocol: policy.protocol, adapter: policy.adapter, preset: policy.preset,
      thinking: policy.thinking, effort: policy.effort, requestTimeoutSeconds: policy.requestTimeout,
      tools: profile.tools !== false, imageInput: profile.imageInput === true, pdfInput: profile.pdfInput === true,
    };
  } catch {
    return { state: 'invalid' };
  }
}

export async function buildReport({ session, state, profile, configuration, unreadableSessions, probe }) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const model = profileSummary(profile);
  const pending = session?.queue[0];
  const history = pending?.checks ?? session?.turns.at(-1)?.checks;
  const checks = latestChecks(Array.isArray(history) ? history.filter(check => typeof check?.name === 'string') : []);
  const result = {
    schemaVersion: 1,
    version,
    runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch },
    configuration,
    model,
    unreadableSessions,
    session: session ? {
      state, turns: session.turns.length, pendingMessages: session.queue.length,
      checks: { total: checks.length, passed: checks.filter(check => check.status === 'passed').length },
      failure: safeFailure(pending?.failureInfo),
    } : null,
  };
  if (probe) {
    if (model.state !== 'configured') result.probe = { state: 'profile-unavailable' };
    else {
      try {
        const tests = await diagnose(profile, await probe.token(), { only: probe.only });
        result.probe = { state: 'completed', tests: tests.filter(item => stages.has(item.name) && outcomes.has(item.status))
          .map(item => ({ name: item.name, status: item.status, failure: safeFailure(item) })) };
      } catch {
        result.probe = { state: 'unavailable' };
      }
    }
  }
  return result;
}

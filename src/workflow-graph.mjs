import { createHash } from 'node:crypto';
import { validateAnswer } from './json-contract.mjs';

export class WorkflowGate extends Error {
  constructor(stage) {
    super('Approval required before stage ' + stage.name);
    this.stage = stage;
  }
}

export function workflowRevision(harness) {
  return createHash('sha256').update(JSON.stringify(harness)).digest('hex').slice(0, 12);
}

export function revisionsFor(config, name) {
  return Object.hasOwn(config.harnessRevisions ?? {}, name) ? config.harnessRevisions[name] : {};
}

export function rememberRevision(config, name, harness) {
  const revisions = { ...revisionsFor(config, name), [workflowRevision(harness)]: harness };
  const entries = Object.entries(revisions);
  config.harnessRevisions = { ...config.harnessRevisions, [name]: Object.fromEntries(entries) };
}

export function revisionOf(config, name, active, requested) {
  if (!requested || requested === workflowRevision(active)) return active;
  const revisions = revisionsFor(config, name);
  if (!Object.hasOwn(revisions, requested)) throw new Error('Unknown harness revision.');
  return revisions[requested];
}

export function validateWorkflow(harness, defaultTools) {
  const stages = new Map(), artifacts = new Map(), finishedGroups = new Set();
  let group;
  for (const stage of harness.stages) {
    if (stages.has(stage.name)) throw new Error('Duplicate stage name: ' + stage.name);
    for (const field of ['after', 'consumes']) {
      if (stage[field] !== undefined && (!Array.isArray(stage[field]) || stage[field].some(item => typeof item !== 'string')))
        throw new Error(field + ' must be a list in ' + stage.name);
    }
    for (const parent of stage.after ?? []) {
      if (!stages.has(parent)) throw new Error('Missing, forward or cyclic stage dependency: ' + parent);
      if (stage.parallel && stages.get(parent).parallel === stage.parallel) throw new Error('Parallel stages cannot depend on each other.');
    }
    for (const name of stage.consumes ?? []) if (!artifacts.has(name)) throw new Error('Missing upstream artifact: ' + name);
    if (!['always', 'checks-passed', 'checks-failed'].includes(stage.when ?? 'always')) throw new Error('Unknown condition for ' + stage.name);
    for (const [field, cap] of [['maxSeconds', 1800], ['maxTools', 100]]) {
      if (stage[field] !== undefined && (!Number.isInteger(stage[field]) || stage[field] < 1 || stage[field] > cap))
        throw new Error('Invalid ' + field + ' in ' + stage.name);
    }
    if (stage.approval !== undefined && typeof stage.approval !== 'boolean') throw new Error('Approval must be true or false.');
    if (stage.artifact) {
      const { name, schema } = stage.artifact;
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(name) || artifacts.has(name) || schema === undefined)
        throw new Error('Artifacts need a unique name and schema.');
      artifacts.set(name, stage.name);
    }
    if (group && group !== stage.parallel) finishedGroups.add(group);
    group = stage.parallel;
    if (group && (typeof group !== 'string' || finishedGroups.has(group) || stage.approval || stage.when && stage.when !== 'always' ||
      stage.artifact || stage.consumes?.length || stage.repairAttempts ||
      (stage.tools ?? defaultTools).some(tool => !defaultTools.includes(tool))))
      throw new Error('Parallel stages must be adjacent and read-only with independent output.');
    stages.set(stage.name, stage);
  }
  return harness;
}

export function stageApplies(stage, checks) {
  if (!stage.when || stage.when === 'always') return true;
  if (!checks.length) return false;
  const failed = checks.some(check => check.status !== 'passed');
  return stage.when === 'checks-failed' ? failed : !failed;
}

export function resolveArtifact(stage, answer) {
  if (!stage.artifact) return undefined;
  return { name: stage.artifact.name, value: validateAnswer(stage.artifact.schema, answer) };
}

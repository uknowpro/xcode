import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { blocked, readText, within } from './workspace.mjs';
import { storage } from './store.mjs';
import { projectChecks } from './checks.mjs';

export const roles = {
  cloud: 'Trace account, identity, network and availability boundaries. Identify failure domains and rollout risks.',
  devops: 'Trace the delivery pipeline and dependencies. Identify deployment checks, rollback conditions and recovery steps.',
  backend: 'Check API contracts, callers, persistence, transactions and retries.',
  frontend: 'Check focus, keyboard access, layouts and loading, empty and error states.',
  'full-stack': 'Trace user actions through the UI, APIs and persistence. Check end-to-end behavior.',
  data: 'Trace schema, lineage and data quality. Check for duplicates and plan reprocessing.',
  sre: 'Tie findings to user impact, detection, recovery and operational ownership.',
  qa: 'Map requirements to happy-path, boundary and failure cases with observable outcomes.',
  writer: 'Preserve source facts, define the audience and verify instructions with cited references.',
};

export const readTools = ['glob', 'grep', 'read', 'project_guides', 'repo_map', 'skill_read'];
const changeTools = ['propose_changes', 'edit'];
const step = (name, instruction, tools = readTools, done = 'Report the evidence and unresolved items.') => ({
  name, instruction, tools, done,
});

const verification = [...readTools, 'verify_edits', 'run_check'];

export const presets = {
  default: {
    description: 'A single stage for general local work',
    stages: [step('Work', 'Follow the user request and reference files you used.', [...readTools, ...changeTools])],
  },
  'deepseek-flash': {
    description: 'Focused code exploration with DeepSeek Flash',
    stages: [
      step('Locate', 'Search the workspace with short targeted queries. Read only the relevant source ranges, then identify the evidence and any gaps.', readTools, 'Record paths and line numbers.'),
      step('Answer', 'Use the evidence from the previous stage. Search again only when a missing fact could change the answer.', readTools, 'Cite the relevant paths and state what remains unverified.'),
    ],
  },
  'deepseek-flash-code': {
    description: 'Staged code changes with bounded exploration and reviewed verification',
    role: 'backend',
    stages: [
      step('Locate', 'Identify the smallest set of files and related tests. Cite exact paths.', ['grep', 'read', 'project_guides']),
      step('Edit', 'Propose a focused patch using the recorded evidence; keep reasoning and prior tool results intact.', ['read', 'project_guides', 'propose_changes']),
      step('Verify', 'Run a registered check and report observed results and remaining risks.', ['read', 'verify_edits', 'run_check']),
    ],
  },
  'small-model': {
    description: 'Compact code investigation with two tools per stage',
    stages: [
      step('Find', 'Find only the closest match and read its relevant lines.', ['grep', 'read']),
      step('Explain', 'Use the recorded evidence. Give a short answer with the path and line.', ['read']),
    ],
  },
  'code-review': {
    description: 'Investigate a change and report findings',
    role: 'backend',
    stages: [
      step('Inspect', 'Trace the code and affected callers.'),
      step('Review', 'Rank actionable findings by impact. Cite paths and line numbers.', readTools, 'Give findings with evidence and identify checks that still need to run.'),
    ],
  },
  implement: {
    description: 'Investigate, propose a reviewable change set, and verify',
    role: 'full-stack',
    stages: [
      step('Investigate', 'Read instructions and identify the smallest viable change.'),
      step('Implement', 'Propose targeted edits or new files as one change set. Wait for the review decision.', [...readTools, ...changeTools], 'Report the paths affected.'),
      { ...step('Verify', 'Read back changes, check whitespace and run an enabled project check when applicable.', verification, 'Report verified results and remaining checks.'), repairAttempts: 2 },
    ],
  },
  infrastructure: {
    description: 'Review Terraform, Kubernetes and deployment boundaries',
    role: 'cloud',
    stages: [
      step('Inventory', 'Find the declarations for networks, workloads, identity and deployment.'),
      step('Analyze', 'Trace dependencies and boundaries. Cite the declarations and list validation steps.'),
    ],
  },
  'bug-fix': {
    description: 'Trace a defect, fix its cause, and run a targeted regression check',
    role: 'backend',
    stages: [
      step('Reproduce', 'Trace the failing path from evidence. Use an enabled check when its scope covers the defect.', verification),
      step('Fix', 'Propose the smallest source and regression-test changes that address the root cause.', [...readTools, ...changeTools]),
      { ...step('Retest', 'Run the registered regression check if enabled and report what it verifies.', verification), repairAttempts: 2 },
    ],
  },
  refactor: {
    description: 'Preserve public contracts while simplifying an implementation',
    role: 'full-stack',
    stages: [
      step('Baseline', 'Inventory callers, behavior and invariants. Use an enabled baseline check if relevant.', verification),
      step('Refactor', 'Propose a coherent change set. Preserve public interfaces and migration behavior.', [...readTools, ...changeTools]),
      step('Compare', 'Compare the approved diff to the baseline and run enabled verification.', verification),
    ],
  },
  'api-review': {
    description: 'Review API behavior, compatibility and error handling',
    role: 'backend',
    stages: [
      step('Trace contracts', 'Inspect routes and schemas. Trace callers, authorization boundaries and persistence.'),
      step('Review gaps', 'Report compatibility, idempotency, and failure-handling findings with references.', verification),
    ],
  },
  'terraform-review': {
    description: 'Review Terraform or OpenTofu changes, dependencies and blast radius',
    role: 'cloud',
    stages: [
      step('Inventory', 'Read module calls, providers, variables and outputs. Trace identities and network boundaries.'),
      step('Assess', 'Identify replacement, state or migration risks tied to declarations. Use only configured local validation checks.', verification),
    ],
  },
  'terraform-change': {
    description: 'Propose and verify Terraform or OpenTofu module changes',
    role: 'devops',
    stages: [
      step('Plan changes', 'Map module inputs, defaults, state addresses and dependants. Establish rollback conditions.'),
      step('Propose', 'Prepare changes that preserve resource identity where possible. Use the review workflow.', [...readTools, ...changeTools]),
      step('Validate', 'Run relevant enabled formatting or validation checks and report their actual exit status.', verification),
    ],
  },
  'kubernetes-upgrade': {
    description: 'Review Helm and Kubernetes manifests for a version upgrade',
    role: 'sre',
    stages: [
      step('Inventory APIs', 'Identify the source/target versions and trace manifests, Helm templates, CRDs and admission rules.'),
      step('Assess compatibility', 'Separate removed APIs, behavior changes, dependencies, and rollout risks. Report missing cluster context.'),
      step('Verify', 'Use configured manifest checks and report what remains to verify in the target cluster.', verification),
    ],
  },
  'kubernetes-rollout': {
    description: 'Review and propose safer Kubernetes workload changes',
    role: 'devops',
    stages: [
      step('Trace rollout', 'Review selectors, availability budgets, probes, permissions, and Helm values.'),
      step('Propose', 'Prepare manifest or Helm changes for approval and describe rollback.', [...readTools, ...changeTools]),
      step('Validate', 'Run enabled rendering or validation checks and describe the tested scope.', verification),
    ],
  },
  documentation: {
    description: 'Read source material and draft documentation',
    role: 'writer',
    stages: [
      step('Collect', 'Locate relevant files, instructions and examples.'),
      step('Draft', 'Write task-oriented documentation and cite the source material.', [...readTools, ...changeTools]),
    ],
  },
};

export function harnessFor(config, name) {
  const harness = Object.hasOwn(config.harnesses, name) ? config.harnesses[name] :
    Object.hasOwn(presets, name) ? presets[name] : undefined;
  if (!harness) throw new Error('Unknown harness: ' + name);
  if (!Array.isArray(harness.stages) || harness.stages.length < 1 || harness.stages.length > 8)
    throw new Error('A harness must define 1–8 stages.');
  if (harness.role && !Object.hasOwn(roles, harness.role) && typeof harness.role !== 'string')
    throw new Error('A role must be a preset name or text.');
  for (const stage of harness.stages) {
    if (typeof stage?.name !== 'string' || !stage.name.trim() || typeof stage.instruction !== 'string' ||
      (stage.done !== undefined && typeof stage.done !== 'string') ||
      (stage.repairAttempts !== undefined && (!Number.isInteger(stage.repairAttempts) || stage.repairAttempts < 0 || stage.repairAttempts > 3)) ||
      (stage.tools !== undefined && (!Array.isArray(stage.tools) ||
        stage.tools.some(tool => ![...readTools, ...changeTools, 'verify_edits', 'run_check'].includes(tool)))))
      throw new Error('Each stage needs a name and instruction, supported tools, and at most 3 repair attempts.');
  }
  if (harness.skills !== undefined && (!Array.isArray(harness.skills) ||
    harness.skills.some(name => typeof name !== 'string')))
    throw new Error('Harness skills must be a list of skill names.');
  return harness;
}

export function stageTools(stage, profile, session, checks) {
  return [...new Set(stage.tools ?? readTools)].filter(name => {
    if (profile.tools === false) return false;
    if (name === 'edit' || name === 'propose_changes') return Boolean(session.write);
    if (name === 'run_check') return Boolean(session.checks && Object.keys(checks).length);
    return true;
  });
}

export function checksForHarness(config, root, name) {
  const configured = projectChecks(config, root);
  const project = config.harnessChecks?.[root];
  const names = project && Object.hasOwn(project, name) ? project[name] : null;
  if (!Array.isArray(names)) return { names: null, checks: configured };
  return {
    names,
    checks: Object.fromEntries(names.filter(check => Object.hasOwn(configured, check)).map(check => [check, configured[check]])),
  };
}

export function roleText(role) {
  if (!role) return '';
  return Object.hasOwn(roles, role) ? roles[role] : role;
}

function skillField(text, field) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  const match = new RegExp('^' + field + ':[ \\t]*(.*)$', 'm').exec(header);
  if (!match) return '';
  const value = match[1].trim();
  if (/^[|>][-+]?$/.test(value)) {
    return header.slice(match.index + match[0].length).split('\n').slice(1)
      .filter((_, index, lines) => lines.slice(0, index + 1).every(line => /^\s/.test(line)))
      .map(line => line.trim()).join(' ');
  }
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

export async function skillsAt(root, signal) {
  const skills = new Map();
  for (const folder of [
    join(root, '.claude', 'skills'), join(root, '.xcode', 'skills'),
    join(storage, 'skills'), join(homedir(), '.claude', 'skills'),
  ]) {
    signal?.throwIfAborted();
    let base;
    try {
      base = await realpath(folder);
      if (within(root, folder) && base !== folder) continue;
    } catch {
      continue;
    }
    for (const entry of (await readdir(base, { withFileTypes: true })).slice(0, 200)) {
      signal?.throwIfAborted();
      if (!entry.isDirectory() || blocked(entry.name)) continue;
      const dir = join(base, entry.name);
      const content = await readText(dir, 'SKILL.md', signal, 128 * 1024).catch(() => '');
      const name = skillField(content, 'name') || entry.name;
      if (content && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && !skills.has(name)) {
        skills.set(name, { name, dir, description: skillField(content, 'description').slice(0, 500) });
      }
    }
  }
  return skills;
}

export async function skillRead(skills, name, path = 'SKILL.md', signal) {
  const skill = skills.get(name);
  if (!skill) throw new Error('Unknown local skill: ' + name);
  if (typeof path !== 'string' || !within(skill.dir, resolve(skill.dir, path))) throw new Error('Select a file inside the skill.');
  return { skill: name, path, content: (await readText(skill.dir, path, signal, 128 * 1024)).slice(0, 14000) };
}

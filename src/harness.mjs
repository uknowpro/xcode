import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { blocked, readText, within } from './workspace.mjs';
import { storage } from './store.mjs';

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

export const presets = {
  default: {
    description: 'A single stage for general local work',
    stages: [step('Work', 'Follow the user request and reference files you used.', [...readTools, ...changeTools])],
  },
  'deepseek-flash': {
    description: 'Focused search and a short evidence-based response',
    stages: [
      step('Locate', 'Use short queries and read only relevant regions.', readTools, 'Identify paths and line numbers.'),
      step('Answer', 'Use findings from the first stage to answer concisely.', readTools, 'Cite the root cause or state what remains unverified.'),
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
      step('Verify', 'Read back changes, check whitespace and run an enabled project check when applicable.', [...readTools, 'verify_edits', 'run_check'], 'Report verified results and remaining checks.'),
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
      (stage.tools !== undefined && (!Array.isArray(stage.tools) ||
        stage.tools.some(tool => ![...readTools, ...changeTools, 'verify_edits', 'run_check'].includes(tool)))))
      throw new Error('Each stage needs a name and instruction. Tools must use supported names.');
  }
  if (harness.skills !== undefined && (!Array.isArray(harness.skills) ||
    harness.skills.some(name => typeof name !== 'string')))
    throw new Error('Harness skills must be a list of skill names.');
  return harness;
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

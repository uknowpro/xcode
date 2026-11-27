import { createHash } from 'node:crypto';
import { userMessage } from './attachments.mjs';
import { modelEndpoint } from './model-profile.mjs';
import { recentMessages } from './memory.mjs';

const storedLimit = 512 * 1024;
const maxTurns = 8;

function wireSize(messages) {
  return Buffer.byteLength(JSON.stringify(messages));
}

export function startWire(job, profile, policy) {
  const scope = policy.replay ? createHash('sha256').update(JSON.stringify([
    policy.adapter, modelEndpoint(profile, policy).href, profile.model, policy.thinking,
    ...(policy.protocol === 'chat-completions' ? [] : [policy.protocol]),
  ])).digest('hex') : null;
  if (job.wire) {
    if (job.wire.scope !== scope)
      throw new Error('This paused turn belongs to its original model endpoint and thinking mode. Restore that profile or discard the pending turn.');
  } else if (policy.replay && !job.stageHistory?.length) {
    job.wire = { scope, blocks: [], full: !job.completed.length };
  }
  return job.wire ?? null;
}

function replayBudget(policy) {
  const context = policy.contextWindow ?? 32768;
  const output = policy.maxTokens ?? Math.min(8192, Math.floor(context / 4));
  return Math.max(0, Math.min(storedLimit, Math.floor((context - output) * 1.5)));
}

export function wireStage(session, job, policy, stage) {
  // Keep the active tool exchange whole. Evict older completed blocks first.
  let remaining = Math.max(0, replayBudget(policy) - wireSize(job.stageHistory ?? []) - Buffer.byteLength(job.prompt));
  const current = [];
  for (const block of job.wire.blocks.slice().reverse()) {
    const size = wireSize(block);
    if (size > remaining) break;
    current.unshift(block);
    remaining -= size;
  }
  const older = [];
  let boundary = session.turns.length;
  while (boundary > 0 && older.length < maxTurns) {
    const saved = session.turns[boundary - 1].wire;
    if (!saved || saved.scope !== job.wire.scope) break;
    const size = wireSize(saved.messages);
    if (size > remaining) break;
    older.unshift(saved.messages);
    remaining -= size;
    boundary--;
  }
  const exact = job.wire.full && current.length === job.wire.blocks.length;
  job.wire.stageInput ??= exact && current.length ? 'continuation' : 'original';
  const continuing = job.wire.stageInput === 'continuation';
  const input = continuing ? {
    role: 'user',
    content: 'Continue the current task with the ' + stage.name + ' stage. Use its current instructions and preserve approved decisions.',
  } : userMessage(job.prompt, job.attachments);
  const recentStart = Math.max(0, session.turns.length - maxTurns);
  return {
    input,
    originalPrompt: continuing && !exact ? job.prompt : '',
    history: [...older.flat(), ...current.flat()],
    summarized: recentMessages(session.turns.slice(recentStart, boundary)),
  };
}

export function completeWireStage(job, input, assistant, policy) {
  if (!job.wire) return;
  const messages = [input, ...(job.stageHistory ?? []), assistant];
  job.wire.blocks.push(messages);
  delete job.wire.stageInput;
  const budget = replayBudget(policy);
  let size = job.wire.blocks.reduce((sum, block) => sum + wireSize(block), 0);
  while (size > budget && job.wire.blocks.length) {
    size -= wireSize(job.wire.blocks.shift());
    job.wire.full = false;
  }
}

export function completedWire(job) {
  if (!job.wire?.full || !job.wire.blocks.length) return undefined;
  return { scope: job.wire.scope, messages: job.wire.blocks.flat() };
}

export function pruneWire(turns) {
  let budget = storedLimit;
  return turns.slice().reverse().map((turn, index) => {
    if (!turn.wire) return turn;
    const size = wireSize(turn.wire.messages);
    if (index < maxTurns && size <= budget) {
      budget -= size;
      return turn;
    }
    const { wire, ...visible } = turn;
    return visible;
  }).reverse();
}

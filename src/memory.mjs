const recentCount = 8;
const decisionTerms = /\b(?:decid(?:e|ed)|decision|agreed|must|requirement|constraint|keep|approved|resolved)\b|결정|합의|요구|유지|승인|필수/i;
const clip = (value, limit) => String(value ?? '').slice(0, limit);

function excerpts(turn) {
  const lines = String(turn.answer ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const requestLines = String(turn.prompt ?? '').split(/\r?\n/).map(line => line.trim());
  const decisions = [...new Set([...requestLines, ...lines].filter(line => decisionTerms.test(line)))]
    .slice(0, 8).map(line => clip(line, 300));
  const references = [...new Set([
    ...(turn.tools ?? []).filter(tool => tool.path && !tool.error).map(tool => ({
      path: clip(tool.path, 350), from: tool.line,
    })).map(tool => tool.path + (tool.from ? ':' + tool.from : '')),
    ...(turn.answer?.match(/[\p{L}\p{N}_./-]+\.[\p{L}\p{N}_-]+:\d+(?:-\d+)?/gu) ?? []).map(path => clip(path, 350)),
  ])];
  return {
    request: clip(turn.prompt, 600),
    result: clip(lines.slice(0, 4).join(' '), 750),
    ...(decisions.length ? { decisions } : {}),
    ...(references.length ? { references: references.slice(0, 20) } : {}),
    ...(turn.changed?.length ? { appliedPaths: turn.changed.slice(0, 20) } : {}),
    ...(turn.attachments?.length ? { attachments: turn.attachments.slice(0, 8) } : {}),
    ...(turn.checks?.length ? { checks: turn.checks.slice(0, 12).map(check => ({
      name: check.name, status: check.status, exitCode: check.exitCode,
      ...(check.status !== 'passed' ? { message: clip(check.stderr || check.stdout, 300) } : {}),
    })) } : {}),
  };
}

export function refreshMemory(session) {
  const previous = session.memory;
  const compactedThrough = Math.max(0, session.turns.length - recentCount);
  if (compactedThrough === (previous?.through ?? 0)) return previous;
  const start = previous?.through <= compactedThrough ? previous.through : 0;
  return {
    through: compactedThrough,
    entries: [...(start ? previous.entries : []), ...session.turns.slice(start, compactedThrough).map(excerpts)],
  };
}

export function remember(session, prompt, budget = 18000) {
  const entries = session.memory?.entries ?? [];
  const terms = new Set(String(prompt).toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu)?.slice(0, 24) ?? []);
  const candidates = entries.map((entry, index) => {
    const value = JSON.stringify(entry);
    const searchable = value.toLowerCase();
    const score = [...terms].filter(term => searchable.includes(term)).length;
    return { value, score, index };
  }).sort((a, b) => b.score - a.score || b.index - a.index);
  let available = budget;
  const chosen = [];
  for (const item of candidates) {
    if (item.value.length + 1 > available) continue;
    chosen.push(item);
    available -= item.value.length + 1;
  }
  const changes = (session.changes ?? []).slice(-20).map(change => ({
    id: change.id,
    status: change.undoneAt ? 'undone' : 'applied',
    paths: change.files.map(file => file.path),
  }));
  return {
    covered: entries.length,
    notes: chosen.sort((a, b) => a.index - b.index).map(item => item.value),
    changeHistory: JSON.stringify(changes),
  };
}

export function recentMessages(turns) {
  const messages = [];
  let budget = 20000;
  for (const turn of turns.slice(-recentCount).reverse()) {
    if (!turn.answer) continue;
    const request = clip(turn.prompt, Math.min(3000, Math.floor(budget / 3)));
    const answer = clip(turn.answer, Math.min(5000, budget - request.length));
    if (!request || !answer) break;
    messages.unshift({ role: 'user', content: request }, { role: 'assistant', content: answer });
    budget -= request.length + answer.length;
  }
  return messages;
}

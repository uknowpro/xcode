export function historyPage(turns, before, count = '8') {
  const end = before === undefined ? turns.length : Number(before) - 1;
  const size = Number(count);
  if (!Number.isInteger(end) || end < 0 || end > turns.length || !Number.isInteger(size) || size < 1 || size > 20)
    throw new Error('Provide a turn number and a page size from 1 to 20.');
  const start = Math.max(0, end - size);
  return { entries: turns.slice(start, end).map((turn, index) => ({ turn, number: start + index + 1 })),
    ...(start ? { nextBefore: start + 1 } : {}) };
}

export function historyText(turns, before, count) {
  return formatHistoryPage(historyPage(turns, before, count));
}

export function formatHistoryPage(page, prefix = '/history') {
  const entries = page.entries.map(({ turn, number }) => '#' + number + ' · ' + turn.status +
    '\n> ' + turn.prompt + '\n' + (turn.answer || turn.partial?.text || '[' + turn.status + ']'));
  if (page.nextBefore) entries.push('Earlier turns · ' + prefix + ' ' + page.nextBefore);
  return entries.join('\n\n') || 'No earlier responses.';
}

export function sessionMarkdown(session) {
  const lines = ['# ' + session.title.replace(/[\r\n]/g, ' ')];
  for (const [index, turn] of session.turns.entries()) {
    lines.push('## Turn ' + (index + 1), '### Request', turn.prompt ?? '',
      '### Response', turn.answer || turn.partial?.text || '[' + turn.status + ']');
    if (turn.changed?.length) lines.push('### Changed files', ...turn.changed.map(path => '- ' + path));
    if (turn.checks?.length) lines.push('### Checks', ...turn.checks.map(check => '- ' + check.name + ' · ' + check.status));
  }
  if (session.changes?.length) {
    lines.push('## Change history');
    for (const change of session.changes) {
      lines.push('- ' + change.id + ' · ' + (change.undoneAt ? 'undone' : 'applied') +
        ' · ' + change.files.map(file => file.path).join(', '));
    }
  }
  return lines.join('\n\n');
}

export function editorKeys(config = {}) {
  return { send: config.sendKey ?? 'ctrl+g', newline: config.newlineKey ?? 'enter' };
}

export function terminalStyle(config = {}, env = process.env) {
  const theme = config.theme ?? 'auto';
  const accessible = config.accessible === true;
  const plain = accessible || theme === 'plain' || env.TERM === 'dumb';
  return { theme, accessible, plain, color: !plain && !Object.hasOwn(env, 'NO_COLOR') && theme !== 'auto' };
}

export function recallEntries(turns, commands, query) {
  const term = query.toLowerCase();
  return [...new Set([
    ...commands.slice().reverse(), ...turns.slice(-40).reverse().map(turn => turn.prompt),
  ])].filter(text => typeof text === 'string' && text.toLowerCase().includes(term)).slice(0, 9);
}

export function configureEditor(config, options) {
  const sendKey = options['send-key'] ?? editorKeys(config).send;
  const newlineKey = options['newline-key'] ?? editorKeys(config).newline;
  if (!['ctrl+g', 'ctrl+x'].includes(sendKey)) throw new Error('Send key must be ctrl+g or ctrl+x.');
  if (!['enter', 'ctrl+o'].includes(newlineKey)) throw new Error('Newline key must be enter or ctrl+o.');
  const theme = options.theme ?? config?.theme ?? 'auto';
  if (!['auto', 'light', 'dark', 'plain'].includes(theme)) throw new Error('Theme must be auto, light, dark or plain.');
  return { ...config, sendKey, newlineKey, theme, accessible: options.accessible ?? config?.accessible ?? false };
}

const composeCommands = {
  '/send': 'Submit draft',
  '/preview': 'Preview draft',
  '/outgoing': 'Preview outgoing paths and context',
  '/cancel': 'Discard draft',
  '/exit': 'Save and exit',
};

export function completeCommand(line, help, composing) {
  if (!/^\/[a-z-]*$/i.test(line)) return null;
  const commands = new Map(Object.entries(composeCommands));
  if (!composing) {
    for (const row of help.split('\n')) {
      const [spec, detail] = row.split(/\s{2,}/, 2);
      if (!detail) continue;
      for (const name of spec.match(/\/[a-z-]+/g) ?? []) commands.set(name, detail.trim());
    }
    commands.delete('/send');
    commands.delete('/preview');
    commands.delete('/cancel');
  }
  const matches = [...commands].filter(([name]) => name.startsWith(line.toLowerCase())).sort(([a], [b]) => a.localeCompare(b));
  if (!matches.length) return [[], line];
  if (matches.length === 1) return [[matches[0][0] + ' '], line];
  return [matches.map(([name, detail]) => name.padEnd(16) + detail), line];
}

export function previewDraft(lines, width, clip) {
  const count = lines.length;
  return [count + (count === 1 ? ' line in draft' : ' lines in draft'),
    ...lines.slice(0, 12).map((line, index) => String(index + 1).padStart(2) + '  ' + clip(line, Math.max(6, width - 4))),
    ...(count > 12 ? ['… ' + (count - 12) + ' more lines'] : [])].join('\n');
}

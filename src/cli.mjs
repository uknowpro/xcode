#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr } from 'node:process';
import { createInterface, clearLine, cursorTo } from 'node:readline';
import { createInterface as questions } from 'node:readline/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { attach, explicitReferences, splitArgs } from './attachments.mjs';
import { harnessFor, presets, roles, skillsAt } from './harness.mjs';
import { completionUrl, complete } from './model.mjs';
import { Sessions } from './session.mjs';
import { settings, setToken, tokenFor, updateSettings } from './store.mjs';
import { projectRoot } from './workspace.mjs';

const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const clean = value => String(value).replace(controls, '');
const print = value => stdout.write(clean(value) + '\n');
const info = value => stderr.write(clean(value) + '\n');
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const maxPrompt = 32000;

function validName(name) {
  if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('Use 1–48 letters, numbers, hyphens or underscores.');
  return name;
}

function profileFor(config, name) {
  const profile = own(config.profiles, name);
  if (!profile) throw new Error('Profile "' + name + '" is missing. Run xcode setup.');
  return profile;
}

const help = [
  'xcode — terminal assistant for your model and local workspace',
  '',
  '  xcode setup [name]             Save API URL, model ID and token',
  '  xcode                          Start interactive chat',
  '  xcode ask "prompt"             Run a single prompt, or pipe text to xcode ask',
  '  xcode sessions                 List sessions for this project',
  '  xcode resume <id|latest>       Resume a project session',
  '  xcode profile list|use|set|test [name]',
  '  xcode harness list|show|import [name] [file]',
  '',
  '  --cwd <directory>   --profile <name>   --harness <name>   --write',
  '  --attach <path>     --endpoint <url>   --model <id>      --token-stdin',
  '  --help             --version',
].join('\n');

const chatHelp = [
  '/new, /sessions, /resume <id>   Start, view or switch sessions',
  '/model [name]                  View or select a model profile',
  '/harness [name]                View or select a staged workflow',
  '/skills                        List discovered local skills',
  '/attach <path>, /clear         Add or clear attachments for the next message',
  '/inputs image|pdf|tools on|off Change these capabilities in the current model profile',
  '/queue, /stop, /next            Show pending messages, pause, or stop and send the next',
  '/continue, /skip                Resume an interrupted request or remove it from the queue',
  '/retry off|<seconds>            Retry transient failures while the session is running',
  '/write on|off                   Enable or disable exact replacements in existing files',
  '/history, /tools                Show recent conversation or inspected paths',
  '/exit                          Save and exit',
].join('\n');

async function readInput(limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    length += chunk.length;
    if (length > limit) throw new Error('Input exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function saveProfile(name, endpoint, model, token, use) {
  validName(name);
  const url = completionUrl(endpoint);
  if (!model?.trim() || model.length > 256) throw new Error('Enter a model ID up to 256 characters.');
  if (token !== undefined && (token.length > 8192 || /[\r\n]/.test(token))) throw new Error('Invalid API token.');
  await updateSettings(async config => {
    config.profiles[name] = { ...own(config.profiles, name), endpoint: url, model: model.trim() };
    if (token !== undefined) await setToken(name, token);
    if (use || !config.defaultProfile) config.defaultProfile = name;
  });
}

async function setup(name) {
  validName(name);
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Use an interactive terminal, or xcode profile set with --token-stdin.');
  const config = await settings();
  const profile = own(config.profiles, name);
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, next) {
      if (!hidden) stdout.write(chunk);
      next();
    },
  });
  const rl = questions({ input: stdin, output, terminal: true });
  const controller = new AbortController();
  rl.once('close', () => controller.abort());
  rl.on('SIGINT', () => rl.close());
  try {
    const signal = controller.signal;
    const endpoint = (await rl.question('API URL' + (profile ? ' [' + clean(profile.endpoint) + ']' : '') + ': ', { signal })).trim();
    const model = (await rl.question('Model ID' + (profile ? ' [' + clean(profile.model) + ']' : '') + ': ', { signal })).trim();
    stdout.write('API token (hidden, Enter to keep, - to clear): ');
    hidden = true;
    const token = (await rl.question('', { signal })).trim();
    stdout.write('\n');
    await saveProfile(name, endpoint || profile?.endpoint, model || profile?.model, token === '-' ? '' : token || undefined, true);
    print('Saved default profile ' + name + '.');
  } finally {
    rl.close();
  }
}

function showProfiles(config) {
  for (const [name, profile] of Object.entries(config.profiles)) {
    const url = new URL(profile.endpoint);
    print((name === config.defaultProfile ? '* ' : '  ') + name + ' · ' + profile.model + ' · ' + url.origin + url.pathname);
  }
  if (!Object.keys(config.profiles).length) print('No profiles. Run xcode setup.');
}

async function profileCommand(action, name, options) {
  const config = await settings();
  if (action === 'list' || !action) return showProfiles(config);
  if (action === 'set') {
    const existing = own(config.profiles, name);
    const token = options['token-stdin'] ? (await readInput(16384)).trim() : undefined;
    await saveProfile(name, options.endpoint || existing?.endpoint, options.model || existing?.model, token, false);
    print('Saved profile ' + name + '.');
    return;
  }
  profileFor(config, name);
  if (action === 'use') {
    await updateSettings(value => { value.defaultProfile = name; });
    print('Default profile: ' + name);
  } else if (action === 'test') {
    const answer = await complete(profileFor(config, name), await tokenFor(name), [
      { role: 'user', content: 'Reply with OK.' },
    ], { signal: AbortSignal.timeout(20000) });
    print('Model responded: ' + answer.content.trim().slice(0, 120));
  } else {
    throw new Error('Use profile list, set, use or test.');
  }
}

function harnessList(config) {
  for (const name of new Set([...Object.keys(presets), ...Object.keys(config.harnesses)])) {
    const harness = harnessFor(config, name);
    print(name + ' · ' + (harness.description || harness.stages.length + ' stages'));
  }
}

function showHarness(config, name) {
  const harness = harnessFor(config, name);
  print(name + ' · ' + (harness.description ?? 'Custom harness'));
  if (harness.role) print('Role: ' + harness.role);
  if (harness.skills?.length) print('Skills: ' + harness.skills.join(', '));
  harness.stages.forEach((stage, index) => {
    print('  ' + (index + 1) + '. ' + stage.name + ' — ' + stage.instruction);
    if (stage.tools) print('     Tools: ' + (stage.tools.join(', ') || 'none'));
    if (stage.done) print('     Done: ' + stage.done);
  });
}

async function harnessCommand(action, name, file) {
  const config = await settings();
  if (action === 'roles') {
    Object.entries(roles).forEach(([role, instruction]) => print(role + ' · ' + instruction));
  } else if (action === 'list' || !action) {
    harnessList(config);
  } else if (action === 'show') {
    showHarness(config, name || 'default');
  } else if (action === 'import' && file) {
    validName(name);
    const source = await readFile(file, 'utf8');
    if (source.length > 64000) throw new Error('Harness JSON exceeds 64,000 characters.');
    const harness = JSON.parse(source);
    await updateSettings(config => {
      config.harnesses[name] = harness;
      harnessFor(config, name);
    });
    showHarness(await settings(), name);
  } else {
    throw new Error('Use harness list, roles, show <name> or import <name> <json>.');
  }
}

function describeSessions(sessions, selected, statuses = new Map()) {
  if (!sessions.length) print('No sessions for this project.');
  for (const session of sessions) {
    const state = statuses.get(session.id);
    print((selected === session.id ? '* ' : '  ') + session.id.slice(0, 8) + ' · ' +
      (state?.active ? 'running · ' : '') + (session.queue.length ? session.queue.length + ' pending · ' : '') + session.title);
  }
}

async function collectAttachments(root, base, profile, prompt, paths) {
  const requests = new Map([...explicitReferences(prompt).map(path => [path, false]), ...paths.map(path => [path, true])]);
  if (requests.size > 8) throw new Error('Choose up to 8 attachments per message.');
  const results = [];
  for (const [path, explicit] of requests) results.push(await attach(root, path, profile, undefined, { explicit, base }));
  return results;
}

async function ask(root, base, defaults, options, prompt) {
  const config = await settings();
  const profile = profileFor(config, defaults.profile || config.defaultProfile || 'default');
  harnessFor(config, defaults.harness || 'default');
  const attachments = await collectAttachments(root, base, profile, prompt, options.attach ?? []);
  const sessions = new Sessions(root, (_live, event) => {
    if (event.type === 'text' && !event.intermediate) stdout.write(clean(event.text));
    else if (event.type === 'stage' && event.total > 1) info('\n[' + (event.index + 1) + '/' + event.total + '] ' + event.stage);
    else if (event.type === 'note') info('\n' + event.text);
  });
  const live = await sessions.select(undefined, defaults);
  live.session.write = Boolean(options.write);
  const interrupt = () => sessions.stop(live);
  process.on('SIGINT', interrupt);
  try {
    const { run } = await sessions.enqueue(live, prompt, attachments);
    const result = await run;
    stdout.write('\n');
    if (result?.error) throw result.error;
  } finally {
    process.off('SIGINT', interrupt);
    await sessions.close();
  }
}

async function chat(root, base, defaults, options, prefix) {
  let selected;
  let rendering = false;
  let closed = false;
  let streamOpen = false;
  let chain = Promise.resolve();
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const staged = new Map();
  function endStream() {
    if (!streamOpen) return;
    stdout.write('\n');
    streamOpen = false;
  }
  function clearPrompt() {
    if (!closed && !streamOpen) {
      cursorTo(stdout, 0);
      clearLine(stdout, 0);
    }
  }
  function prompt() {
    if (closed || streamOpen || rendering) return;
    rl.setPrompt(selected?.active ? '… › ' : '› ');
    rl.prompt(true);
  }
  function show(text) {
    if (closed) return;
    clearPrompt();
    endStream();
    print(text);
    prompt();
  }
  const sessions = new Sessions(root, (live, event) => {
    if (closed) return;
    if (live !== selected) {
      if (event.type === 'complete' || event.type === 'error')
        show('[' + live.session.id.slice(0, 8) + '] ' + (event.type === 'complete' ? 'Response ready' : event.error.message));
      return;
    }
    if (event.type === 'text') {
      clearPrompt();
      stdout.write(clean(event.text));
      streamOpen = true;
    } else if (event.type === 'stage' && event.total > 1) {
      show('[' + (event.index + 1) + '/' + event.total + '] ' + event.stage);
    } else if (event.type === 'tool') {
      show('  · ' + event.name + (event.path ? ' ' + event.path : '') + (event.summary ? ' · ' + event.summary : '') +
        (event.error ? ' · ' + event.error : ''));
    } else if (event.type === 'queue') {
      show(event.count + ' queued' + (live.held ? ' · /continue to send' : ''));
    } else if (event.type === 'error' || event.type === 'note') {
      show(event.error?.message ?? event.text);
    } else if (event.type === 'complete') {
      endStream();
    }
    setImmediate(prompt);
  });
  const select = async id => {
    const live = await sessions.select(id, defaults);
    if (options.profile || options.harness) {
      const config = await settings();
      if (options.profile) profileFor(config, options.profile);
      if (options.harness) harnessFor(config, options.harness);
      if (!live.active) {
        live.session.profile = options.profile || live.session.profile;
        live.session.harness = options.harness || live.session.harness;
      }
    }
    if (options.write) live.session.write = true;
    await sessions.persist(live);
    selected = live;
  };
  const banner = () => show('xcode · ' + selected.session.title + ' · ' + selected.session.profile + ' · ' + selected.session.id.slice(0, 8));
  const files = () => staged.get(selected.session.id) ?? [];
  const editable = () => {
    if (selected.active) throw new Error('Pause the session before changing its settings.');
  };
  const closeTerminal = () => rl.close();
  const interrupt = () => {
    if (!sessions.stop(selected)) rl.close();
    else show('Stopping…');
  };
  async function input(raw) {
    const line = raw.trim();
    if (!line) return;
    if (!line.startsWith('/')) {
      if (line.length > maxPrompt) throw new Error('Prompt exceeds 32,000 characters.');
      const profile = profileFor(await settings(), selected.session.profile);
      const attachments = await collectAttachments(root, base, profile, line, files());
      const { run } = await sessions.enqueue(selected, line, attachments);
      run?.catch(error => show(error.message));
      staged.delete(selected.session.id);
      return;
    }
    const command = /^\/[^\s]+/.exec(line)[0];
    const args = splitArgs(line.slice(command.length));
    const [arg, value] = args;
    const session = selected.session;
    switch (command) {
      case '/help': show(chatHelp); break;
      case '/exit': rl.close(); break;
      case '/new': await select(); banner(); break;
      case '/resume':
        if (!arg) throw new Error('Use /resume <id|latest>.');
        await select(arg); banner(); break;
      case '/sessions': describeSessions(await sessions.list(), session.id, sessions.open); break;
      case '/queue':
        show(session.queue.length ? session.queue.map((item, index) =>
          (index + 1) + ' · ' + (index === 0 && selected.active ? '[running] ' : '') + item.prompt.slice(0, 100)).join('\n') : 'Queue is empty.');
        break;
      case '/stop': if (!sessions.stop(selected)) show('No request is running.'); break;
      case '/next':
        if (!selected.active) throw new Error('Use /skip to remove a paused message.');
        if (session.queue.length < 2) throw new Error('Queue has no next message.');
        sessions.stop(selected, true);
        break;
      case '/continue':
        if (selected.active) throw new Error('A request is still running or stopping.');
        if (!session.queue.length) throw new Error('Queue is empty.');
        selected.held = false;
        sessions.pump(selected)?.catch(error => show(error.message));
        break;
      case '/skip': await sessions.skip(selected); break;
      case '/attach':
        if (!args.length) return show(files().length ? files().join('\n') : 'Use /attach <path>.');
        staged.set(session.id, [...new Set([...files(), ...args])]);
        show('For the next message: ' + files().join(', '));
        break;
      case '/clear': staged.delete(session.id); show('Attachments cleared.'); break;
      case '/model':
        if (!arg) return showProfiles(await settings());
        editable();
        profileFor(await settings(), arg);
        session.profile = arg;
        await sessions.persist(selected);
        banner();
        break;
      case '/harness':
        if (!arg) return showHarness(await settings(), session.harness);
        if (arg === 'list') return harnessList(await settings());
        editable();
        showHarness(await settings(), arg);
        session.harness = arg;
        await sessions.persist(selected);
        break;
      case '/inputs': {
        editable();
        const field = { image: 'imageInput', pdf: 'pdfInput', tools: 'tools' }[arg];
        if (!field || !['on', 'off'].includes(value)) throw new Error('Use /inputs image|pdf|tools on|off.');
        await updateSettings(config => { profileFor(config, session.profile)[field] = value === 'on'; });
        show(arg + ' ' + value + ' for profile ' + session.profile + '.');
        break;
      }
      case '/write':
        editable();
        if (!['on', 'off'].includes(arg)) throw new Error('Use /write on or /write off.');
        session.write = arg === 'on';
        await sessions.persist(selected);
        show('Workspace editing ' + arg + '.');
        break;
      case '/retry': {
        const retry = Number(arg);
        if (arg !== 'off' && (!Number.isInteger(retry) || retry < 10 || retry > 600))
          throw new Error('Use /retry off or enter a retry delay from 10 to 600 seconds.');
        editable();
        session.retrySeconds = arg === 'off' ? 0 : retry;
        await sessions.persist(selected);
        show('Automatic retry ' + (session.retrySeconds ? 'every ' + retry + 's on transient failures.' : 'off.'));
        break;
      }
      case '/skills': {
        const skills = await skillsAt(root);
        show(skills.size ? [...skills.values()].map(skill => skill.name + ' · ' + skill.description).join('\n') : 'No local skills found.');
        break;
      }
      case '/history':
        show(session.turns.slice(-8).map(turn => '> ' + turn.prompt + '\n' + (turn.answer || '[' + turn.status + ']')).join('\n\n') || 'No prior responses.');
        break;
      case '/tools':
        show((session.queue[0]?.tools ?? session.turns.at(-1)?.tools ?? [])
          .map(tool => tool.stage + ' · ' + tool.name + ' ' + (tool.path || '') + (tool.error ? ' · ' + tool.error : '')).join('\n') || 'No tools called.');
        break;
      default: throw new Error('Unknown command. Use /help.');
    }
  }
  try {
    await select(prefix);
    if (options.attach?.length) staged.set(selected.session.id, options.attach);
    const hasProfile = own((await settings()).profiles, selected.session.profile);
    rl.on('SIGINT', interrupt);
    process.once('SIGTERM', closeTerminal);
    const finished = new Promise(resolve => {
      rl.on('close', () => { closed = true; resolve(); });
      rl.on('line', line => {
        streamOpen = false;
        chain = chain.then(async () => {
          if (closed) return;
          rendering = true;
          try {
            await input(line);
          } catch (error) {
            show(error.message);
          } finally {
            rendering = false;
            prompt();
          }
        });
      });
    });
    rendering = true;
    banner();
    print('Type a request or /help.');
    if (!hasProfile) print('Set up a model profile in another terminal with xcode setup.');
    if (selected.held) print('Messages are paused. /continue resumes the pending request.');
    rendering = false;
    prompt();
    await finished;
    await chain;
  } finally {
    closed = true;
    process.off('SIGTERM', closeTerminal);
    rl.close();
    await sessions.close();
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string' }, profile: { type: 'string' }, harness: { type: 'string' },
      attach: { type: 'string', multiple: true }, endpoint: { type: 'string' }, model: { type: 'string' },
      write: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      'token-stdin': { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === 'help') return print(help);
  if (values.version) return print(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (command === 'setup') return setup(rest[0] || (await settings()).defaultProfile || 'default');
  if (command === 'profile') return profileCommand(rest[0], rest[1] || (await settings()).defaultProfile || 'default', values);
  if (command === 'harness') return harnessCommand(...rest);
  const base = resolve(values.cwd || process.cwd());
  const root = await projectRoot(base);
  const defaults = { profile: values.profile, harness: values.harness };
  if (command === 'sessions') {
    const sessions = new Sessions(root);
    return describeSessions(await sessions.list());
  }
  if (command === 'ask' || (!command && !stdin.isTTY)) {
    const prompt = (rest.length ? rest.join(' ') : await readInput(maxPrompt * 4)).trim();
    if (!prompt || prompt.length > maxPrompt) throw new Error('Enter a prompt up to 32,000 characters.');
    return ask(root, base, defaults, values, prompt);
  }
  if (command === 'resume' || !command) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive chat requires a terminal. Use xcode ask for one prompt.');
    return chat(root, base, defaults, values, command === 'resume' ? rest[0] || 'latest' : undefined);
  }
  throw new Error('Unknown command: ' + command + '. Use xcode --help.');
}

main().catch(error => {
  info(error.message);
  process.exitCode = error.name === 'AbortError' ? 130 : 1;
});

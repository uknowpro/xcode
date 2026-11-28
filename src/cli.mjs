#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr } from 'node:process';
import { createInterface, clearLine, clearScreenDown, cursorTo } from 'node:readline';
import { createInterface as questions } from 'node:readline/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { attach, attachmentSize, explicitReferences, maxAttachmentBytes, maxAttachments, splitArgs } from './attachments.mjs';
import { checksForHarness, harnessFor, presets, roles, skillsAt } from './harness.mjs';
import { configureModel, endpointUrl, modelEndpoint, modelPolicy, modelTuning } from './model-profile.mjs';
import { diagnose } from './diagnostic.mjs';
import { modelFailure } from './model-transport.mjs';
import { evaluateProfile } from './profile-eval.mjs';
import { checkEvidence } from './repair.mjs';
import { defineCheck, projectChecks, runCheck } from './checks.mjs';
import { reviewDiff, selectedFiles } from './changes.mjs';
import { remember } from './memory.mjs';
import { completeReference, pageKey, terminalClip, terminalWidth } from './terminal.mjs';
import { Sessions } from './session.mjs';
import { settings, setToken, storage, tokenFor, updateSettings } from './store.mjs';
import { projectRoot } from './workspace.mjs';
import { maxDraftLength, readDraft, writeDraft } from './draft.mjs';

const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const clean = value => String(value).replace(controls, '');
const print = value => stdout.write(clean(value) + '\n');
const info = value => stderr.write(clean(value) + '\n');
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const maxPrompt = maxDraftLength;

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
  '  xcode sessions [search]        List or filter sessions for this project',
  '  xcode resume <id|latest>       Resume a project session',
  '  xcode draft [id|latest]        Read an unsent draft without opening the session',
  '  xcode continue [id|latest]    Run the pending message once',
  '  xcode profile list|show|use|set|tune|test|eval [name]',
  '  xcode profile tune [name] --adapter <adapter> --protocol <protocol>',
  '  xcode profile eval [name] [--against <profile>] [--timeout <seconds>] [--json]',
  '  xcode harness list|show|import [name] [file]',
  '  xcode harness checks <name> [check...] [--clear]',
  '  xcode check add <name> -- <command> [args...]',
  '  xcode check list|remove [name]',
  '  xcode check run <name> [--json]',
  '  xcode review show|apply|reject [session] [paths...]',
  '  xcode changes [session]       List applied and undone changes',
  '  xcode undo [session] [change] Undo a change if its files still match',
  '  xcode settings                 Show active defaults and project checks',
  '',
  '  --cwd <directory>   --profile <name>   --harness <name>   --write   --checks',
  '  --attach <path>     --endpoint <url>   --model <id>      --token-stdin',
  '  --thinking on|off|default   --effort low|medium|high|xhigh|max|default',
  '  --preset default|coding     Apply vendor sampling defaults where supported',
  '  --context-window <tokens>   --max-tokens <tokens>   --request-timeout <seconds>',
  '  --help             --version',
].join('\n');

const chatHelp = [
  '/new, /sessions [search]        Start, filter, or browse saved sessions',
  '/resume <id>                    Resume a session by ID',
  '/model [name]                  View or select a model profile',
  '/harness [name]                View or select a staged workflow',
  '/skills                        List discovered local skills',
  '/attach <path>, /clear         Add or clear attachments for the next message',
  '/inputs image|pdf|tools on|off Change these capabilities in the current model profile',
  '/queue, /stop, /next            Show pending messages, pause, or stop and send the next',
  '/continue, /skip                Resume an interrupted request or remove it from the queue',
  '/retry off|<seconds>            Retry transient failures while the session is running',
  '/write on|off                  Allow model change proposals. Applying still requires approval',
  '/diff [path], /apply [paths]    Review or approve all or selected files',
  '/verification                  View test outcomes for the current or last turn',
  '/reject, /changes, /undo [id]  Reject a proposal, see history, or undo',
  '/context [query]               Inspect the compacted session context',
  '/harness preview <name>        View an available harness without switching',
  '/checks [on|off]               Show or toggle the configured project checks',
  '/check <name>                  Run a named project check manually',
  '/settings                      View model, harness and permissions for this session',
  '/paste, /send, /cancel         Compose or paste a multi-line message',
  'Tab after @                    Complete a workspace path',
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

async function saveProfile(name, endpoint, model, token, use, options = {}) {
  validName(name);
  await updateSettings(async config => {
    const existing = own(config.profiles, name);
    const url = endpointUrl(endpoint ?? existing?.endpoint).href;
    const modelId = model ?? existing?.model;
    if (!modelId?.trim() || modelId.length > 256) throw new Error('Enter a model ID up to 256 characters.');
    config.profiles[name] = configureModel({ ...existing, endpoint: url, model: modelId.trim() }, options);
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
    const savedUrl = profile ? endpointUrl(profile.endpoint) : null;
    const shown = savedUrl ? savedUrl.origin + savedUrl.pathname + (savedUrl.search ? '?[saved parameters]' : '') : null;
    const endpoint = (await rl.question('API URL' + (shown ? ' [' + clean(shown) + ']' : '') + ': ', { signal })).trim();
    const model = (await rl.question('Model ID' + (profile ? ' [' + clean(profile.model) + ']' : '') + ': ', { signal })).trim();
    stdout.write('API token (hidden, Enter to keep, - to clear): ');
    hidden = true;
    const token = (await rl.question('', { signal })).trim();
    stdout.write('\n');
    await saveProfile(name, endpoint || undefined, model || undefined, token === '-' ? '' : token || undefined, true);
    print('Saved default profile ' + name + '.');
  } finally {
    rl.close();
  }
}

function showProfiles(config) {
  for (const [name, profile] of Object.entries(config.profiles)) {
    const url = modelEndpoint(profile, modelPolicy(profile));
    print((name === config.defaultProfile ? '* ' : '  ') + name + ' · ' + profile.model + ' · ' + url.origin + url.pathname);
  }
  if (!Object.keys(config.profiles).length) print('No profiles. Run xcode setup.');
}

async function profileCommand(action, name, options) {
  const config = await settings();
  if (action === 'list' || !action) return showProfiles(config);
  if (action === 'set') {
    const token = options['token-stdin'] ? (await readInput(16384)).trim() : undefined;
    await saveProfile(name, options.endpoint, options.model, token, false, options);
    print('Saved profile ' + name + '.');
    return;
  }
  const profile = profileFor(config, name);
  if (action === 'show' || action === 'tune') {
    if (action === 'tune') {
      await updateSettings(value => {
        value.profiles[name] = configureModel(profileFor(value, name), options);
      });
    }
    const current = action === 'tune' ? profileFor(await settings(), name) : profile;
    const url = modelEndpoint(current, modelPolicy(current));
    return print([
      'Profile · ' + name + ' · ' + current.model,
      'Endpoint · ' + url.origin + url.pathname,
      ...modelTuning(current),
    ].join('\n'));
  }
  if (action === 'use') {
    await updateSettings(value => { value.defaultProfile = name; });
    print('Default profile: ' + name);
  } else if (action === 'eval') {
    const comparison = options.against ? profileFor(config, options.against) : null;
    if (comparison && (comparison.model !== profile.model ||
      modelEndpoint(comparison, modelPolicy(comparison)).href !== modelEndpoint(profile, modelPolicy(profile)).href))
      throw new Error('Compare settings for the same model and endpoint.');
    const timeout = options.timeout === undefined ? 120 : Number(options.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error('Evaluation timeout must be 1–600 seconds.');
    const reports = [];
    for (const [entry, value] of [[name, profile], ...(comparison ? [[options.against, comparison]] : [])]) {
      const { error, durationMs, checkpoint, metrics, ...phases } = await evaluateProfile(value, await tokenFor(entry), { timeout: timeout * 1000 });
      reports.push({ profile: entry, durationMs, phases, checkpoint, metrics, ...(error ? { error } : {}) });
      if (!options.json) {
        print(entry + ' · ' + (durationMs / 1000).toFixed(2) + 's');
        for (const [phase, passed] of Object.entries(phases)) print('  ' + phase + ' · ' + (passed ? 'PASS' : 'FAIL'));
        print('  ' + metrics.toolCalls + ' tool calls · checks ' + metrics.checkMs + 'ms');
        if (error) info(error);
        else if (!checkpoint) info('The model did not use tools, so there was no checkpoint to resume.');
      }
      if (error || Object.values(phases).includes(false)) process.exitCode = 1;
    }
    if (options.json) print(JSON.stringify(reports, null, 2));
  } else if (action === 'test') {
    const timeout = options.timeout === undefined
      ? (modelPolicy(profile).adapter === 'deepseek-flash' ? 60 : 15) : Number(options.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error('Probe timeout must be 1–600 seconds.');
    const results = await diagnose(profile, await tokenFor(name), {
      only: options.only, timeout: timeout * 1000,
      onResult: options.json ? undefined : item => print(item.name.toUpperCase() + ' ' + item.status.toUpperCase() + ' · ' + item.detail),
    });
    if (options.json) print(JSON.stringify({ profile: name, results }, null, 2));
    if (results.some(item => item.status === 'fail')) process.exitCode = 1;
  } else {
    throw new Error('Use profile list, show, set, tune, use, test or eval.');
  }
}

function harnessList(config) {
  for (const name of new Set([...Object.keys(presets), ...Object.keys(config.harnesses)])) {
    const harness = harnessFor(config, name);
    print(name + ' · ' + (harness.description || harness.stages.length + ' stages'));
  }
}

function showHarness(config, name, root) {
  const harness = harnessFor(config, name);
  print(name + ' · ' + (harness.description ?? 'Custom harness'));
  if (harness.role) print('Role: ' + harness.role);
  if (harness.skills?.length) print('Skills: ' + harness.skills.join(', '));
  const binding = checksForHarness(config, root, name);
  if (harness.stages.some(stage => stage.tools?.includes('run_check'))) {
    print('Project checks: ' + checkBinding(binding));
  }
  harness.stages.forEach((stage, index) => {
    print('  ' + (index + 1) + '. ' + stage.name + ' — ' + stage.instruction);
    if (stage.tools) print('     Tools: ' + (stage.tools.join(', ') || 'none'));
    if (stage.done) print('     Done: ' + stage.done);
    if (stage.repairAttempts) print('     Repair attempts: ' + stage.repairAttempts);
  });
}

function checkBinding({ names, checks }) {
  if (!names) return Object.keys(checks).join(', ') || 'none registered';
  return names.map(name => Object.hasOwn(checks, name) ? name : name + ' (missing)').join(', ') || 'none';
}

async function harnessCommand(root, action, name, args, options) {
  const config = await settings();
  if (action === 'roles') {
    Object.entries(roles).forEach(([role, instruction]) => print(role + ' · ' + instruction));
  } else if (action === 'list' || !action) {
    harnessList(config);
  } else if (action === 'show') {
    showHarness(config, name || 'default', root);
  } else if (action === 'checks' && name) {
    validName(name);
    const harness = harnessFor(config, name);
    if (!harness.stages.some(stage => stage.tools?.includes('run_check')))
      throw new Error('This harness has no stage with the run_check tool.');
    if (args.length || options.clear) {
      if (args.length && options.clear) throw new Error('Use check names or --clear.');
      await updateSettings(value => {
        const registered = projectChecks(value, root);
        for (const check of args) if (!Object.hasOwn(registered, check)) throw new Error('Unknown project check: ' + check);
        const project = { ...value.harnessChecks?.[root] };
        if (options.clear) delete project[name];
        else project[name] = [...new Set(args)];
        value.harnessChecks = { ...value.harnessChecks, [root]: project };
      });
    }
    print(name + ' · ' + checkBinding(checksForHarness(await settings(), root, name)));
  } else if (action === 'import' && args[0]) {
    validName(name);
    const source = await readFile(args[0], 'utf8');
    if (source.length > 64000) throw new Error('Harness JSON exceeds 64,000 characters.');
    const harness = JSON.parse(source);
    await updateSettings(config => {
      config.harnesses[name] = harness;
      harnessFor(config, name);
    });
    showHarness(await settings(), name, root);
  } else {
    throw new Error('Use harness list, roles, show <name>, checks <name> or import <name> <json>.');
  }
}

function sessionStatus(session, live) {
  const pending = session.queue[0];
  if (live?.active) return 'running';
  if (session.undoInProgress) return 'undo interrupted';
  if (pending?.review?.state === 'applying') return 'apply interrupted';
  if (pending?.review) return 'review needed';
  if (pending?.failure) return 'failed';
  if (pending) return 'paused';
  const last = session.turns.at(-1);
  if (last?.verificationFailed) return 'check failed';
  if (last?.status === 'complete') return 'complete';
  return 'idle';
}

async function sessionRows(manager, query = '') {
  let unreadable = 0;
  const entries = await manager.list(() => { unreadable++; });
  const rows = entries.map(entry => {
    const live = manager.open.get(entry.id);
    const session = live?.session ?? entry;
    const pending = session.pendingCount ?? session.queue.length;
    return { id: session.id, text: session.id.slice(0, 8) + ' · ' + sessionStatus(session, live) + ' · ' +
      (pending ? pending + ' pending · ' : '') + session.title };
  });
  const term = query.trim().toLowerCase();
  return { rows: term ? rows.filter(row => row.text.toLowerCase().includes(term)) : rows, unreadable };
}

async function describeSessions(manager, selected, query = '') {
  const { rows, unreadable } = await sessionRows(manager, query);
  if (unreadable) info(unreadable + ' unreadable saved session file(s). Existing files were preserved.');
  if (!rows.length) print(query ? 'No sessions match this search.' : 'No sessions for this project.');
  for (const row of rows) print((selected === row.id ? '* ' : '  ') + row.text);
}

function checkList(checks) {
  const lines = Object.entries(checks).map(([name, check]) =>
    name + ' · ' + check.argv.map(arg => JSON.stringify(arg)).join(' ') + ' · ' + check.timeout + 's');
  return lines.join('\n') || 'No project checks. Add one with xcode check add <name> -- <command> [args].';
}

function checkSummary(result) {
  return result.name + ' · ' + result.status + (result.exitCode === null ? '' : ' · exit ' + result.exitCode) +
    ' · ' + (result.durationMs / 1000).toFixed(1) + 's';
}

async function checkCommand(root, action, name, argv, options) {
  if (!action || action === 'list') return print(checkList(projectChecks(await settings(), root)));
  if (action === 'run') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    try {
      const config = await settings();
      const token = await tokenFor(config.defaultProfile ?? 'default').catch(() => undefined);
      const result = await runCheck(root, projectChecks(config, root), name, controller.signal, { secrets: [token] });
      if (options.json) print(JSON.stringify(result, null, 2));
      else {
        if (result.stdout) print(result.stdout.trimEnd());
        if (result.stderr) info(result.stderr.trimEnd());
        info(checkSummary(result));
      }
      process.exitCode = result.exitCode === 0 && result.status === 'passed' ? 0 : result.exitCode || 1;
    } finally {
      process.off('SIGINT', abort);
    }
    return;
  }
  if (!['add', 'remove'].includes(action)) throw new Error('Use check add, list, run or remove.');
  validName(name);
  await updateSettings(config => {
    const checks = { ...projectChecks(config, root) };
    if (action === 'add') checks[name] = defineCheck(argv, options.timeout === undefined ? undefined : Number(options.timeout));
    else {
      if (!Object.hasOwn(checks, name)) throw new Error('Unknown project check: ' + name);
      delete checks[name];
    }
    config.projectChecks = { ...config.projectChecks, [root]: checks };
  });
  print((action === 'add' ? 'Saved' : 'Removed') + ' project check ' + name + '.');
}

async function describeSettings(root, session) {
  const config = await settings();
  const profileName = session?.profile ?? config.defaultProfile ?? 'default';
  const profile = own(config.profiles, profileName);
  const url = profile ? modelEndpoint(profile, modelPolicy(profile)) : null;
  return [
    'Workspace · ' + root,
    'Model profile · ' + profileName + (profile ? ' · ' + profile.model : ' · setup required'),
    url ? 'Endpoint · ' + url.origin + url.pathname : '',
    ...(profile ? modelTuning(profile) : []),
    profile ? 'Model inputs · tools ' + (profile.tools === false ? 'off' : 'on') +
      ' · image ' + (profile.imageInput ? 'on' : 'off') + ' · PDF ' + (profile.pdfInput ? 'on' : 'off') : '',
    'Harness · ' + (session?.harness ?? 'default'),
    'Change proposals · ' + (session?.write ? 'on' : 'off') + ' · applies require approval',
    'Agent checks · ' + (session?.checks ? 'on' : 'off'),
    checkList(projectChecks(config, root)),
    'Configuration · ' + resolve(storage, 'settings.json'),
  ].filter(Boolean).join('\n');
}

async function reviewCommand(root, action, prefix, paths) {
  if (!['show', 'apply', 'reject'].includes(action)) throw new Error('Use review show, apply or reject [session].');
  const sessions = new Sessions(root);
  try {
    const live = await sessions.select(prefix || 'latest', {});
    const review = live.session.queue[0]?.review;
    if (!review) throw new Error('There is no pending change set.');
    if (action === 'show') return print(reviewDiff(review, paths[0]).join('\n'));
    if (action === 'reject' && paths.length) throw new Error('Reject the entire proposal, or apply only the paths you approve.');
    const files = await sessions.review(live, action, paths);
    print(action === 'apply' ? reviewDecision(files, review) : 'Rejected the change set.');
    print('Continue with xcode continue ' + live.session.id.slice(0, 8) + '.');
  } finally {
    await sessions.close();
  }
}

function verificationLines(session) {
  const checks = session.queue[0]?.checks ?? session.turns.at(-1)?.checks ?? [];
  return checks.length ? checks.slice(-20).flatMap(check => [
    ...(check.automatic ? ['Automatic rerun'] : []), ...checkEvidence(check, 850).split('\n'), '',
  ]) : ['No verification results for this turn.'];
}

function reviewDecision(files, review) {
  const excluded = review.files.length - files.length;
  return 'Applied ' + files.length + ' files' + (excluded ? ', declined ' + excluded : '') + '.';
}

function changeHistory(session) {
  const history = (session.changes ?? []).slice().reverse();
  return history.map(change => change.id + ' · ' + (change.undoneAt ? 'undone' : 'applied') + ' · ' + change.appliedAt +
    '\n  ' + change.files.map(file => file.path).join(', ')).join('\n') || 'No undoable changes recorded in this session.';
}

async function historyCommand(root, action, prefix, id) {
  const sessions = new Sessions(root);
  try {
    const live = await sessions.select(prefix || 'latest', {});
    if (action === 'changes') return print(changeHistory(live.session));
    const result = await sessions.undo(live, id);
    print('Undid change ' + result.id + ' (' + result.files.length + ' files).');
  } finally {
    await sessions.close();
  }
}

async function collectAttachments(root, base, profile, prompt, paths) {
  const requests = new Map([
    ...explicitReferences(prompt).map(path => [resolve(base, path), false]),
    ...paths.map(path => [resolve(base, path), true]),
  ]);
  const results = [];
  let bytes = 1;
  for (const [path, explicit] of requests) {
    let file;
    try {
      file = await attach(root, path, profile, undefined, { explicit, base });
    } catch (error) {
      if (!explicit && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw error;
    }
    bytes += attachmentSize(file);
    if (results.length >= maxAttachments || bytes > maxAttachmentBytes)
      throw new Error('Maximum 8 attachments and 12 MiB of encoded attachment data per message.');
    results.push(file);
  }
  return results;
}

function streamSession(root) {
  return new Sessions(root, (_live, event) => {
    if (event.type === 'text' && !event.intermediate && stdout.isTTY) stdout.write(clean(event.text));
    else if (event.type === 'stage' && event.total > 1) info('[' + (event.index + 1) + '/' + event.total + '] ' + event.stage);
    else if (event.type === 'note') info(event.text);
    else if (event.type === 'tool' && event.check)
      info(event.check + ' · ' + event.summary + (event.exitCode === null ? '' : ' · exit ' + event.exitCode));
  });
}

async function oneMessage(sessions, live, start) {
  live.holdAfterCurrent = true;
  const interrupt = () => sessions.stop(live);
  process.on('SIGINT', interrupt);
  try {
    const { run } = await start();
    const result = await run;
    if (result?.error) throw result.error;
    if (result?.answer) {
      if (stdout.isTTY) stdout.write('\n');
      else print(result.answer);
    }
    if (result?.review) {
      const id = live.session.id.slice(0, 8);
      info('Change set awaiting approval. Run xcode review show ' + id + ' or xcode resume ' + id + '.');
      process.exitCode = 3;
    } else if (result?.failedChecks?.length) {
      info('Verification failed · ' + result.failedChecks.join(', '));
      process.exitCode = 4;
    }
  } finally {
    process.off('SIGINT', interrupt);
  }
}

async function ask(root, base, defaults, options, prompt) {
  const config = await settings();
  const profile = profileFor(config, defaults.profile || config.defaultProfile || 'default');
  harnessFor(config, defaults.harness || 'default');
  const attachments = await collectAttachments(root, base, profile, prompt, options.attach ?? []);
  const sessions = streamSession(root);
  try {
    const live = await sessions.select(undefined, defaults);
    live.session.write = Boolean(options.write);
    live.session.checks = Boolean(options.checks);
    await oneMessage(sessions, live, () => sessions.enqueue(live, prompt, attachments));
  } finally {
    await sessions.close();
  }
}

async function continueMessage(root, prefix) {
  const sessions = streamSession(root);
  try {
    const live = await sessions.select(prefix || 'latest', {});
    if (live.session.undoInProgress) throw new Error('Run xcode undo to finish the interrupted undo first.');
    if (!live.session.queue.length) throw new Error('Queue is empty.');
    if (live.session.queue[0].review) throw new Error('Show and decide the pending change set first with xcode review.');
    live.held = false;
    await oneMessage(sessions, live, () => ({ run: sessions.pump(live) }));
  } finally {
    await sessions.close();
  }
}

async function chat(root, base, defaults, options, prefix) {
  let selected;
  let rendering = false;
  let closed = false;
  let streamOpen = false;
  let chain = Promise.resolve();
  let paste = null;
  let pasteLength = 0;
  let attachments = [];
  let savedDraft;
  let draftTimer;
  let draftProblem;
  let restoredLine = '';
  let draftNotice;
  let pager = null;
  const notices = [];
  const rl = createInterface({
    input: stdin, output: stdout, terminal: true,
    completer: (line, callback) => completeReference(root, base, line).then(result => callback(null, result), callback),
  });
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
  function statusLabel() {
    const active = selected?.active;
    if (active?.controller.signal.aborted) return 'Stopping';
    if (active?.tool === 'run_check') return 'Running check';
    if (active?.tool) return 'Tool · ' + active.tool.replaceAll('_', ' ');
    if (active) return active.stage ? 'Generating · ' + active.stage : 'Starting request';
    const pending = selected?.session.queue[0];
    if (pending?.review) return 'Review pending';
    if (pending?.failure) return 'Request failed';
    if (pending && selected.held) return 'Queue paused';
    if (selected?.session.turns.at(-1)?.verificationFailed) return 'Verification failed';
    return '';
  }
  function prompt() {
    if (closed || streamOpen || rendering || pager) return;
    const width = Math.min(42, (stdout.columns || 80) - 12);
    const status = terminalClip(statusLabel(), width);
    rl.setPrompt((status ? status + ' · ' : '') + (paste ? '│ ' : '› '));
    rl.prompt(true);
    if (restoredLine) {
      const text = restoredLine;
      restoredLine = '';
      rl.write(text);
    }
  }
  function show(text) {
    if (closed) return;
    if (pager) {
      if (notices.length === 20) notices.shift();
      notices.push(text);
      return;
    }
    clearPrompt();
    endStream();
    print(text);
    prompt();
  }
  function drawSessions() {
    const rowCount = Math.max(4, (stdout.rows || 24) - 5);
    const width = Math.max(16, (stdout.columns || 80) - 1);
    pager.offset = Math.max(0, Math.min(pager.offset, pager.focus));
    if (pager.focus >= pager.offset + rowCount) pager.offset = pager.focus - rowCount + 1;
    cursorTo(stdout, 0, 0);
    clearScreenDown(stdout);
    print(terminalClip('Sessions · ' + pager.rows.length + (pager.query ? ' · ' + pager.query : '') +
      (pager.unreadable ? ' · ' + pager.unreadable + ' unreadable' : ''), width));
    for (const [index, row] of pager.rows.slice(pager.offset, pager.offset + rowCount).entries()) {
      const pointer = index + pager.offset === pager.focus ? '› ' : '  ';
      const line = pointer + (row.id === selected.session.id ? '* ' : '  ') + row.text;
      print(terminalClip(line, width));
    }
    print('↑/↓ Select session · Enter Switch · Esc Close');
  }

  function drawReview(move = 0) {
    if (pager.kind === 'sessions') return drawSessions();
    const rows = Math.max(6, (stdout.rows || 24) - 4);
    const { review, mode, picked } = pager;
    const lines = mode === 'files' ? review.files.map((file, index) =>
      (index === pager.focus ? '› ' : '  ') + (picked.has(file.path) ? '[x] ' : '[ ] ') + file.path +
      (file.move?.to ? ' → ' + file.move.to : file.after === null ? ' · delete' : file.before === null ? ' · new' : ' · edit')
    ) : mode === 'tests' ? verificationLines(selected.session) : pager.lines;
    const last = Math.max(0, lines.length - rows);
    pager.offset = Math.max(0, Math.min(last, pager.offset + move));
    if (mode === 'files' && pager.focus < pager.offset) pager.offset = pager.focus;
    if (mode === 'files' && pager.focus >= pager.offset + rows) pager.offset = pager.focus - rows + 1;
    cursorTo(stdout, 0, 0);
    clearScreenDown(stdout);
    const width = Math.max(16, (stdout.columns || 80) - 1);
    print(terminalClip('Review ' + review.id + ' · ' + mode + ' · ' + picked.size + '/' + review.files.length + ' selected' +
      (mode === 'diff' && pager.file ? ' · ' + pager.file : ''), width));
    for (const line of lines.slice(pager.offset, pager.offset + rows))
      print(terminalClip(line, width, mode === 'files' ? 0 : pager.column));
    print(mode === 'files'
      ? '↑/↓ Select file · Space Toggle · Enter Diff · Tab Tests · Esc Close'
      : '↑/↓ Scroll · PgUp/PgDn Page · ←/→ Columns · Tab ' + (mode === 'diff' ? 'Files' : 'Diff') + ' · Esc/q Close');
  }

  function closeReview() {
    if (!pager) return;
    pager = null;
    stdout.write('\x1b[?1049l');
    for (const notice of notices.splice(0)) print(notice);
    prompt();
  }

  function reviewKey(_text, key) {
    if (!pager || !key) return;
    const clearInput = () => rl.write(null, { ctrl: true, name: 'u' });
    if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
      clearInput();
      closeReview();
      return;
    }
    if (pager.kind === 'sessions') {
      if (key.name === 'return' || key.name === 'enter') {
        const id = pager.rows[pager.focus]?.id;
        closeReview();
        if (id) chain = chain.then(async () => {
          try { await select(id); banner(); }
          catch (error) { show(error.message); }
          finally { prompt(); }
        });
      } else {
        const move = pageKey(key.name, Math.max(4, (stdout.rows || 24) - 5), pager.rows.length);
        if (move !== undefined) {
          pager.focus = Math.max(0, Math.min(pager.rows.length - 1, pager.focus + move));
          drawSessions();
        }
      }
      return;
    }
    if (key.name === 'tab') {
      const tabs = ['diff', 'files', 'tests'];
      pager.mode = tabs[(tabs.indexOf(pager.mode) + (key.shift ? 2 : 1)) % 3];
      pager.offset = 0;
      pager.column = 0;
      drawReview();
      return;
    }
    if (pager.mode === 'files') {
      const file = pager.review.files[pager.focus];
      if (key.name === 'space' && pager.review.state !== 'applying') {
        const group = selectedFiles(pager.review, [file.path]);
        const remove = pager.picked.has(file.path);
        for (const item of group) {
          if (remove) pager.picked.delete(item.path);
          else pager.picked.add(item.path);
        }
        pager.review.markedPaths = [...pager.picked];
        sessions.persist(selected).catch(error => show('Could not save review selection: ' + error.message));
        clearInput();
      } else if (key.name === 'return' || key.name === 'enter') {
        pager.mode = 'diff';
        pager.file = file.path;
        pager.lines = reviewDiff(pager.review, file.path);
        pager.lineWidth = undefined;
        pager.offset = 0;
        pager.column = 0;
      } else {
        const move = pageKey(key.name, Math.max(6, (stdout.rows || 24) - 4), pager.review.files.length);
        if (move === undefined) return;
        pager.focus = Math.max(0, Math.min(pager.review.files.length - 1, pager.focus + move));
      }
      drawReview();
      return;
    }
    if (key.name === 'left' || key.name === 'right') {
      const lines = pager.mode === 'tests' ? verificationLines(selected.session) : pager.lines;
      const measure = () => lines.reduce((value, line) => Math.max(value, terminalWidth(line) - 1), 0);
      const max = pager.mode === 'diff' ? (pager.lineWidth ??= measure()) : measure();
      pager.column = Math.max(0, Math.min(max, pager.column + (key.name === 'left' ? -40 : 40)));
      drawReview();
      return;
    }
    const rows = pager.mode === 'tests' ? verificationLines(selected.session).length : pager.lines.length;
    const move = pageKey(key.name, Math.max(6, (stdout.rows || 24) - 4), rows);
    if (move !== undefined) drawReview(move);
  }

  const sessions = new Sessions(root, (live, event) => {
    if (closed) return;
    if (live !== selected) {
      if (['complete', 'error', 'review'].includes(event.type))
        show('[' + live.session.id.slice(0, 8) + '] ' + (event.type === 'complete' ? 'Response ready' :
          event.type === 'review' ? 'Change set needs review' : modelFailure(event.error).detail));
      return;
    }
    if (event.type === 'text') {
      if (pager) {
        pager.responseHidden = true;
        return;
      }
      clearPrompt();
      stdout.write(clean(event.text));
      streamOpen = true;
    } else if (event.type === 'stage' || event.type === 'request' || event.type === 'tool-start') {
      endStream();
    } else if (event.type === 'tool') {
      show('  · ' + event.name + (event.path ? ' ' + event.path : '') + (event.summary ? ' · ' + event.summary : '') +
        (event.error ? ' · ' + event.error : ''));
    } else if (event.type === 'queue') {
      show(event.count + ' queued' + (live.held ? ' · /continue to send' : ''));
    } else if (event.type === 'review') {
      show('Change set ' + event.id + ' · ' + event.files.length + ' files · /diff to review, /apply or /reject.');
    } else if (event.type === 'error' || event.type === 'note') {
      show(event.error ? modelFailure(event.error).detail : event.text);
    } else if (event.type === 'complete') {
      endStream();
      if (pager?.responseHidden) show('Response ready · /history to view.');
      if (event.failedChecks.length) show('Verification failed · ' + event.failedChecks.join(', '));
    }
    setImmediate(prompt);
  });
  async function saveDraft() {
    if (!selected || pager) return;
    const draft = { line: (restoredLine || rl.line).slice(0, maxPrompt), paste, attachments };
    if (!savedDraft && !draft.line && !draft.paste?.length && !draft.attachments.length) return;
    const signature = JSON.stringify(draft);
    if (signature === savedDraft) return;
    try {
      await writeDraft(selected.session.id, draft);
      savedDraft = signature;
      draftProblem = undefined;
    } catch (error) {
      if (draftProblem === error.message) return;
      draftProblem = error.message;
      if (closed) info('Could not save draft: ' + error.message);
      else show('Could not save draft: ' + error.message);
    }
  }
  function scheduleDraft() {
    if (pager || closed || draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      chain = chain.then(() => { if (!closed) return saveDraft(); });
    }, 250);
    draftTimer.unref();
  }
  const select = async id => {
    if (selected) await saveDraft();
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
    if (options.checks) live.session.checks = true;
    await sessions.persist(live);
    let draft;
    try {
      draft = await readDraft(live.session.id);
    } catch (error) {
      show('Could not load draft: ' + error.message);
    }
    selected = live;
    attachments = draft?.attachments ?? [];
    paste = draft?.paste ?? null;
    pasteLength = paste?.reduce((length, line) => length + line.length + 1, 0) ?? 0;
    restoredLine = draft ? clean(draft.line).replace(/\n/g, '') : '';
    savedDraft = draft ? JSON.stringify(draft) : undefined;
    draftProblem = undefined;
    draftNotice = draft ? 'Draft restored' + (attachments.length ? ' · ' + attachments.length + ' attachment(s)' : '') +
      (paste ? ' · /send submits, /cancel discards.' : '.') : undefined;
  };
  const banner = () => {
    show('xcode · ' + selected.session.title + ' · ' + selected.session.profile + ' · ' + selected.session.id.slice(0, 8));
    if (draftNotice) {
      show(draftNotice);
      draftNotice = undefined;
    }
    if (selected.session.undoInProgress) show('Undo interrupted · /undo to resume.');
    else if (selected.session.queue[0]?.review) show('Review pending · /diff, /apply [paths] or /reject.');
    else if (selected.held) show('Messages are paused. /continue resumes the pending request.');
  };
  const editable = () => {
    if (selected.active) throw new Error('Pause the session before changing its settings.');
  };
  const terminalSignal = new AbortController();
  let manualCheck = null;
  const closeTerminal = () => rl.close();
  const interrupt = () => {
    if (pager) closeReview();
    else if (paste) {
      paste = null;
      show('Draft discarded.');
      scheduleDraft();
    } else if (manualCheck) manualCheck.abort();
    else if (!sessions.stop(selected)) rl.close();
    else show('Stopping…');
  };
  async function send(message) {
    if (!message.trim()) throw new Error('Enter a message.');
    if (message.length > maxPrompt) throw new Error('Prompt exceeds 32,000 characters.');
    const profile = profileFor(await settings(), selected.session.profile);
    const prepared = await collectAttachments(root, base, profile, message, attachments);
    const { run } = await sessions.enqueue(selected, message, prepared);
    run?.catch(error => show(error.message));
    attachments = [];
  }

  async function input(raw) {
    if (pager) {
      drawReview();
      return;
    }
    const line = raw.trim();
    if (paste) {
      if (line === '/exit') {
        rl.close();
      } else if (line === '/cancel') {
        paste = null;
        show('Draft discarded.');
      } else if (line === '/send') {
        await send(paste.join('\n'));
        paste = null;
      } else {
        if (pasteLength + raw.length + 1 > maxPrompt)
          throw new Error('Draft exceeds 32,000 characters. Use /send or /cancel.');
        pasteLength += raw.length + 1;
        paste.push(raw);
      }
      return;
    }
    if (!line) return;
    if (!line.startsWith('/')) {
      try { await send(line); }
      catch (error) {
        if (!rl.line) restoredLine = clean(raw);
        throw error;
      }
      return;
    }
    const command = /^\/[^\s]+/.exec(line)[0];
    const args = splitArgs(line.slice(command.length));
    const [arg, value] = args;
    const session = selected.session;
    switch (command) {
      case '/help': show(chatHelp); break;
      case '/paste': paste = []; pasteLength = 0; show('Paste or type multiple lines. /send submits, /cancel discards.'); break;
      case '/settings': show(await describeSettings(root, session)); break;
      case '/changes': show(changeHistory(session)); break;
      case '/verification': show(verificationLines(session).join('\n')); break;
      case '/undo': {
        const result = await sessions.undo(selected, arg);
        show('Undid change ' + result.id + ' (' + result.files.length + ' files).');
        break;
      }
      case '/context': {
        const memory = remember(session, args.join(' '), 8000);
        const notes = memory.notes.map(note => {
          const entry = JSON.parse(note);
          return entry.request + (entry.result ? '\n  ' + entry.result : '') +
            (entry.decisions ? '\n  Decisions · ' + entry.decisions.join(' • ') : '') +
            (entry.references ? '\n  Files · ' + entry.references.join(', ') : '') +
            (entry.appliedPaths ? '\n  Applied paths · ' + entry.appliedPaths.join(', ') : '') +
            (entry.checks ? '\n  Checks · ' + entry.checks.map(check => check.name + ' ' + check.status + ' (' + (check.exitCode ?? 'no exit code') + ')').join(', ') : '');
        });
        show('Compacted history · ' + notes.length + '/' + memory.covered + ' earlier turns' +
          (notes.length ? '\n\n' + notes.join('\n\n') : ''));
        break;
      }
      case '/diff': {
        const review = session.queue[0]?.review;
        if (!review) throw new Error('There is no pending change set.');
        const lines = reviewDiff(review, arg);
        if (process.env.TERM === 'dumb') { show(lines.join('\n')); break; }
        endStream();
        const picked = new Set(review.state !== 'applying' && review.markedPaths ? review.markedPaths :
          selectedFiles(review).map(file => file.path));
        pager = { review, picked, file: arg, mode: 'diff', lines, focus: 0, offset: 0, column: 0 };
        stdout.write('\x1b[?1049h');
        drawReview();
        break;
      }
      case '/apply':
      case '/reject': {
        editable();
        const review = session.queue[0]?.review;
        if (!review) throw new Error('There is no pending change set.');
        if (command === '/reject' && args.length) throw new Error('Reject the entire proposal, or apply only the paths you approve.');
        const changed = await sessions.review(selected, command.slice(1), args);
        show(command === '/apply' ? reviewDecision(changed, review) : 'Rejected the change set.');
        selected.held = false;
        sessions.pump(selected)?.catch(error => show(error.message));
        break;
      }
      case '/checks':
        if (!arg) {
          show('Agent checks · ' + (session.checks ? 'on' : 'off') + '\n' + checkList(projectChecks(await settings(), root)));
          break;
        }
        editable();
        if (!['on', 'off'].includes(arg)) throw new Error('Use /checks on or /checks off.');
        session.checks = arg === 'on';
        await sessions.persist(selected);
        show('Agent checks ' + arg + '.');
        break;
      case '/check': {
        editable();
        manualCheck = new AbortController();
        try {
          const signal = AbortSignal.any([terminalSignal.signal, manualCheck.signal]);
          const result = await runCheck(root, projectChecks(await settings(), root), arg, signal);
          show([checkSummary(result), result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n'));
        } finally {
          manualCheck = null;
        }
        break;
      }
      case '/exit': rl.close(); break;
      case '/new': await select(); banner(); break;
      case '/resume':
        if (!arg) throw new Error('Use /resume <id|latest>.');
        await select(arg); banner(); break;
      case '/sessions': {
        const query = (arg === 'list' ? args.slice(1) : args).join(' ');
        if (arg === 'list' || process.env.TERM === 'dumb') {
          await describeSessions(sessions, session.id, query);
          break;
        }
        const { rows, unreadable } = await sessionRows(sessions, query);
        if (!rows.length) { show(query ? 'No sessions match this search.' : 'No sessions for this project.'); break; }
        endStream();
        pager = { kind: 'sessions', rows, unreadable, query, focus: Math.max(0, rows.findIndex(row => row.id === session.id)), offset: 0 };
        stdout.write('\x1b[?1049h');
        drawSessions();
        break;
      }
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
        if (session.undoInProgress) throw new Error('Use /undo to finish the interrupted undo first.');
        if (!session.queue.length) throw new Error('Queue is empty.');
        if (session.queue[0].review) throw new Error('Review the pending change set with /diff, /apply or /reject.');
        selected.held = false;
        sessions.pump(selected)?.catch(error => show(error.message));
        break;
      case '/skip': await sessions.skip(selected); break;
      case '/attach':
        if (!args.length) return show(attachments.length ? attachments.join('\n') : 'Use /attach <path>.');
        attachments = [...new Set([...attachments, ...args.map(path => resolve(base, path))])];
        show('For the next message: ' + attachments.join(', '));
        break;
      case '/clear': attachments = []; show('Attachments cleared.'); break;
      case '/model':
        if (!arg) return showProfiles(await settings());
        editable();
        profileFor(await settings(), arg);
        session.profile = arg;
        await sessions.persist(selected);
        banner();
        break;
      case '/harness':
        if (!arg || arg === 'preview') return showHarness(await settings(), value || session.harness, root);
        if (arg === 'list') return harnessList(await settings());
        editable();
        showHarness(await settings(), arg, root);
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
        show('Change proposals ' + arg + '. Applying still requires approval.');
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
          .map(tool => tool.stage + ' · ' + tool.name + (tool.path ? ' ' + tool.path : '') +
            (tool.check ? ' ' + tool.check + ' · exit ' + (tool.exitCode ?? 'unavailable') : '') +
            (tool.error ? ' · ' + tool.error : '')).join('\n') || 'No tools called.');
        break;
      default: throw new Error('Unknown command. Use /help.');
    }
  }
  try {
    await select(prefix);
    if (options.attach?.length) attachments = [...new Set([...attachments, ...options.attach.map(path => resolve(base, path))])];
    const hasProfile = own((await settings()).profiles, selected.session.profile);
    rl.on('SIGINT', interrupt);
    stdin.on('keypress', reviewKey);
    stdin.on('keypress', scheduleDraft);
    process.once('SIGTERM', closeTerminal);
    const finished = new Promise(resolve => {
      rl.on('close', () => { closed = true; terminalSignal.abort(); resolve(); });
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
            await saveDraft();
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
    rendering = false;
    prompt();
    await finished;
    await chain;
  } finally {
    closed = true;
    process.off('SIGTERM', closeTerminal);
    stdin.off('keypress', reviewKey);
    stdin.off('keypress', scheduleDraft);
    clearTimeout(draftTimer);
    closeReview();
    rl.close();
    try {
      await saveDraft();
    } finally {
      await sessions.close();
    }
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string' }, profile: { type: 'string' }, harness: { type: 'string' },
      attach: { type: 'string', multiple: true }, endpoint: { type: 'string' }, model: { type: 'string' },
      write: { type: 'boolean' }, checks: { type: 'boolean' }, only: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      'token-stdin': { type: 'boolean' }, clear: { type: 'boolean' }, json: { type: 'boolean' },
      adapter: { type: 'string' }, protocol: { type: 'string' }, preset: { type: 'string' }, against: { type: 'string' },
      thinking: { type: 'string' }, effort: { type: 'string' },
      'context-window': { type: 'string' }, 'max-tokens': { type: 'string' }, 'request-timeout': { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === 'help') return print(help);
  if (values.version) return print(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (command === 'setup') return setup(rest[0] || (await settings()).defaultProfile || 'default');
  if (command === 'profile') return profileCommand(rest[0], rest[1] || (await settings()).defaultProfile || 'default', values);
  const base = resolve(values.cwd || process.cwd());
  const root = await projectRoot(base);
  const defaults = { profile: values.profile, harness: values.harness };
  if (command === 'check') return checkCommand(root, rest[0], rest[1], rest.slice(2), values);
  if (command === 'review') return reviewCommand(root, rest[0], rest[1], rest.slice(2));
  if (command === 'changes' || command === 'undo') return historyCommand(root, command, rest[0], rest[1]);
  if (command === 'harness') return harnessCommand(root, rest[0], rest[1], rest.slice(2), values);
  if (command === 'settings') return print(await describeSettings(root));
  if (command === 'continue') return continueMessage(root, rest[0]);
  if (command === 'draft') {
    const session = await new Sessions(root).find(rest[0] || 'latest');
    const draft = await readDraft(session.id);
    if (!draft) return info('No unsent draft for this session.');
    if (draft.attachments.length) info('Attachments · ' + draft.attachments.join(', '));
    const lines = [...(draft.paste ?? [])];
    if (draft.line) lines.push(draft.line);
    if (lines.length) print(lines.join('\n'));
    return;
  }
  if (command === 'sessions') {
    const sessions = new Sessions(root);
    return describeSessions(sessions, undefined, rest.join(' '));
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
  info(modelFailure(error).detail);
  process.exitCode = error.name === 'AbortError' ? 130 : 1;
});

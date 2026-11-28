#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout, stderr } from 'node:process';
import { createInterface, clearLine, clearScreenDown, cursorTo } from 'node:readline';
import { createInterface as questions } from 'node:readline/promises';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { attach, attachmentSize, explicitReferences, inspectAttachment, maxAttachmentBytes, maxAttachments, splitArgs } from './attachments.mjs';
import { checksForHarness, composeHarness, harnessFor, presets, roles, skillRead, skillsAt, stageTools } from './harness.mjs';
import { configureModel, endpointUrl, modelEndpoint, modelPolicy, modelTuning } from './model-profile.mjs';
import { diagnose } from './diagnostic.mjs';
import { modelFailure } from './model-transport.mjs';
import { evaluateProfile } from './profile-eval.mjs';
import { checkEvidence, checkLocations, compareCheckRuns, latestChecks } from './repair.mjs';
import { defineCheck, projectChecks, redactSecrets, runCheck } from './checks.mjs';
import { appliedReviewFiles, asGitPatch, chooseHunks, conflictSummary, fileOperation, inverseReview, overrideReviewFile, ownHunks, reviewConflicts, reviewDiff, reviewHunks, reviewRecovery, selectedFiles } from './changes.mjs';
import { remember } from './memory.mjs';
import { completeReference, pageKey, terminalClip, terminalWidth } from './terminal.mjs';
import { Sessions } from './session.mjs';
import { readSession, readSessionPage, savedToken, selectCredentialBackend, settings, setToken, storage, tokenFor, updateSettings } from './store.mjs';
import { loadBytes, projectRoot, worktrees, Workspace } from './workspace.mjs';
import { maxDraftLength, readDraft, writeDraft } from './draft.mjs';
import { buildReport } from './report.mjs';
import { executionLimits, setLimits } from './limits.mjs';
import { cleanStorage, storageUsage } from './storage-inspect.mjs';
import { cacheCapabilities, diagnosticKey, modelDirectory, networkSettings, savedCapabilities } from './model-discovery.mjs';
import { formatHistoryPage, historyText, sessionMarkdown } from './session-history.mjs';
import { completeCommand, configureEditor, editorKeys, previewDraft, recallEntries, terminalStyle } from './chat-input.mjs';
import { copyClipboard, responseSelection } from './clipboard.mjs';
import { openLocation } from './editor.mjs';
import { shellCompletion } from './completion.mjs';
import { mcpCommand, mcpTools, withMcp } from './local-mcp.mjs';
import { extractDocument, queryLocalDatabase } from './local-data.mjs';

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
  '  xcode ask "prompt" [--json|--events]  Run one request or read from standard input',
  '  xcode sessions [search] [--status <filter>]',
  '  xcode session rename|pin|unpin|archive|restore <id|latest> [title]',
  '  xcode session history|fork|export <id|latest> [turn] [count]',
  '  xcode resume <id|latest>       Resume a project session',
  '  xcode draft [id|latest]        Read an unsent draft without opening the session',
  '  xcode continue [id|latest]    Run the pending message once',
  '  xcode profile list|show|use|set|tune|test|models|capabilities|compare|eval [name]',
  '  xcode profile tune [name] --adapter <adapter> --protocol <protocol>',
  '  xcode profile eval [name] [--against <profile>] [--timeout <seconds>] [--json]',
  '  xcode harness list|show|effective|validate|eval|import|compose|export [name] [file]',
  '  xcode search <query> [--path <dir>] [--pattern <glob>] [--regex]',
  '  xcode symbol <identifier> [--path <dir>]',
  '  xcode open <path[:line]>       Open a verified workspace file in XCODE_EDITOR',
  '  xcode skills list|show|enable|disable [name]',
  '  xcode mcp add|list|tools|call|remove [name]',
  '  xcode extract <document> [--part tables|paragraphs] [--sheet <name>] [--rows <n>]',
  '  xcode db <sqlite-file> list|table [name] [--where column=value] [--rows <n>]',
  '  xcode harness checks <name> [check...] [--clear]',
  '  xcode check add <name> [--in <directory>] -- <command> [args...]',
  '  xcode check suggest|compare [session]',
  '  xcode review patch [session] > changes.patch',
  '  xcode changes [session] [change] --patch > applied.patch',
  '  xcode check list|remove [name]',
  '  xcode check run <name> [--json]',
  '  xcode review show|check|hunks|recovery|apply|reject [session] [paths...]',
  '  xcode guides|packages [path]  Show scoped instructions or local package dependencies',
  '  xcode changes [session]       List applied and undone changes',
  '  xcode undo [session] [change] [--preview]  Inspect or reverse applied changes',
  '  xcode review edit <session> <path> <replacement-file>',
  '  xcode settings [export]        Show active defaults or export local settings',
  '  xcode exclusions list|add|remove [glob]  Control workspace transmission',
  '  xcode profile credentials [name] [--backend file|keychain]',
  '  xcode check sequence <name...> [--stop-on-failure]',
  '  xcode limits [--model-jobs <n>] [--check-jobs <n>]',
  '  xcode network                 Check local proxy and certificate settings',
  '  xcode worktrees [--json]       List separate workspace roots',
  '  xcode completion <shell>     Generate Bash, Zsh, Fish or PowerShell completion',
  '  xcode storage [--json] [--clean cache|draft|attachments|archive --session <id>]',
  '  xcode terminal [--send-key ctrl+g|ctrl+x] [--newline-key enter|ctrl+o]',
  '                 [--theme auto|light|dark|plain] [--accessible|--no-accessible]',
  '  xcode report [session] [--probe] Export a private-data-free diagnostic report',
  '',
  '  --cwd <directory>   --profile <name>   --harness <name>   --write   --checks',
  '  --attach <path>     --endpoint <url>   --model <id>      --token-stdin',
  '  --thinking on|off|default   --effort low|medium|high|xhigh|max|default',
  '  --preset default|coding     Apply vendor sampling defaults where supported',
  '  --context-window <tokens>   --max-tokens <tokens>   --request-timeout <seconds>',
  '  --help             --version',
].join('\n');

const chatHelp = [
  '/new, /sessions [search]        Start or browse sessions (status:review, status:archived, …)',
  '/session rename|pin|unpin|archive|restore [title]   Manage the current session',
  '/resume <id>                    Resume a session by ID',
  '/model [name]                  View or select a model profile',
  '/model fallback <name> [apply] Preview a new session using another endpoint',
  '/harness effective             Show active stages, model tuning and tools',
  '/search <query>                Search with optional --regex, --path, --pattern or --type',
  '/symbol <name>                 Find JavaScript and TypeScript definitions and references',
  '/open <path[:line]>            Open a workspace reference in the configured editor',
  '/pin [file|decision|constraint|drop]  Keep context across long sessions',
  '/outgoing [prompt]             Preview destination, attachments and pinned context',
  '/harness [name]                View or select a staged workflow',
  '/skills [show|enable|disable] [name]   Inspect or control local skills',
  '/attach <path[#L10-L20]>, /clear   Add files or text ranges for the next message',
  '/inputs image|pdf|tools on|off Change these capabilities in the current model profile',
  '/queue [edit|move|drop|send <number> …]   Manage pending messages',
  '/stop, /next                   Pause or stop and send the next message',
  '/continue, /skip                Resume an interrupted request or remove it from the queue',
  '/retry off|<seconds>            Retry transient failures while the session is running',
  '/write on|off                  Allow model change proposals. Applying still requires approval',
  '/diff [path], /apply [paths]    Review or approve all or selected files',
  '/hunks <path> [number …|all]     List or select edit hunks',
  '/recovery                     Inspect files in an interrupted apply or undo',
  '/guides, /packages [path]       Show folder instructions and package dependencies',
  '/verification [compare|open <number>]  Inspect results, reruns or an error location',
  '/suggest-tests                 Find tests related to changed files',
  '/reject, /changes, /undo [preview] [id]  Reject, see history, or undo',
  '/review-edit <path> <file>     Substitute local replacement text in a pending review',
  '/context [query]               Inspect the compacted session context',
  '/harness preview <name>        View an available harness without switching',
  '/checks [on|off]               Show or toggle the configured project checks',
  '/check <name>                  Run a named project check manually',
  '/status, /settings             View the compact status or full session settings',
  '/recall [search|number]        Find and restore recent prompts or commands',
  '/copy [block]                  Copy the latest reply or a numbered code block',
  '/switch                        Switch to the previous session (Alt+J)',
  '/paste, /send, /cancel         Compose or paste a multi-line message',
  '/preview                       Show draft line count and a bounded preview',
  'Tab after /                    Complete a chat command',
  'Tab after @                    Complete a workspace path',
  '/history [before] [count]      Browse recent turns and page backward',
  '/fork [turn], /partial [line]   Branch a session or recover a partial response',
  '/tools                        Show paths and tools from this turn',
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
    if (token !== undefined) {
      await setToken(name, token, config);
      await cacheCapabilities(name).catch(() => {});
    }
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

function visibleEndpoint(profile, token) {
  const endpoint = modelEndpoint(profile, modelPolicy(profile));
  const value = endpoint.origin + endpoint.pathname;
  return token ? value.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]') : value;
}

async function compareProfiles(config, left, right, json) {
  const fields = ['model', 'endpoint', 'adapter', 'protocol', 'preset', 'thinking', 'effort', 'contextWindow',
    'maxTokens', 'requestTimeout', 'idleTimeout', 'streamFallback', 'retryLimited'];
  const snapshots = [];
  for (const name of [left, right]) {
    const profile = profileFor(config, name);
    snapshots.push({ ...modelPolicy(profile), model: profile.model, endpoint: visibleEndpoint(profile, await tokenFor(name)) });
  }
  const changes = fields.filter(name => snapshots[0][name] !== snapshots[1][name])
    .map(field => ({ field, before: snapshots[0][field] ?? null, after: snapshots[1][field] ?? null }));
  print(json ? JSON.stringify({ before: left, after: right, changes }, null, 2) :
    changes.map(item => item.field + ' · ' + (item.before ?? 'default') + ' → ' + (item.after ?? 'default')).join('\n') ||
    'No effective connection differences.');
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
  if (action === 'credentials') {
    if (options.backend !== undefined) await selectCredentialBackend(name, options.backend);
    return print('Credential storage · ' + ((await settings()).credentialBackends?.[name] ?? 'file'));
  }
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
  } else if (action === 'compare') {
    if (!options.against) throw new Error('Use xcode profile compare <name> --against <name>.');
    await compareProfiles(config, name, options.against, options.json);
  } else if (action === 'models') {
    const result = await modelDirectory(profile, await tokenFor(name), AbortSignal.timeout(15000));
    if (options.json) print(JSON.stringify(result, null, 2));
    else print(result.ids.map(id => (id === profile.model ? '* ' : '  ') + id).join('\n') +
      '\nConfigured model · ' + (result.verified ? 'found' : result.more ? 'not on this page' : 'not listed'));
  } else if (action === 'capabilities') {
    const cache = await savedCapabilities(name);
    const current = cache?.key === diagnosticKey(profile);
    const result = { current, ...(current ? { tests: cache.tests } : {}) };
    if (options.json) print(JSON.stringify(result, null, 2));
    else print(current ? Object.entries(cache.tests).map(([stage, test]) => stage + ' · ' + test.status + ' · ' + test.time).join('\n') :
      'No current probe results. Run xcode profile test.');
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
    const token = await tokenFor(name);
    const endpoint = modelEndpoint(profile, modelPolicy(profile), options.only !== 'chat');
    const redact = value => {
      if (!token) return value;
      return value.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]');
    };
    const address = redact(endpoint.origin + endpoint.pathname);
    if (!options.json) print('Request URL · ' + address);
    const results = await diagnose(profile, token, {
      only: options.only, timeout: timeout * 1000,
      onResult: options.json ? undefined : item => print(item.name.toUpperCase() + ' ' + item.status.toUpperCase() + ' · ' + item.detail),
    });
    if (diagnosticKey(profileFor(await settings(), name)) === diagnosticKey(profile))
      await cacheCapabilities(name, diagnosticKey(profile), results).catch(() => {});
    if (options.json) print(JSON.stringify({ profile: name, endpoint: address, results }, null, 2));
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

function effectiveHarness(config, name, root, options) {
  const profileName = options.profile ?? config.defaultProfile ?? 'default';
  const profile = profileFor(config, profileName);
  const harness = harnessFor(config, name);
  const { checks } = checksForHarness(config, root, name);
  const stages = harness.stages.map(stage => ({ name: stage.name, tools: stageTools(stage, profile, options, checks) }));
  const result = { profile: profileName, harness: name, model: profile.model, policy: modelPolicy(profile), stages };
  return options.json ? JSON.stringify(result, null, 2) : [
    name + ' · ' + profileName + ' · ' + profile.model,
    ...modelTuning(profile),
    ...stages.map((stage, index) => (index + 1) + '. ' + stage.name + ' · ' + (stage.tools.join(', ') || 'no tools')),
  ].join('\n');
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
  } else if (action === 'effective') {
    print(effectiveHarness(config, name || 'default', root, options));
  } else if (action === 'validate') {
    const selected = name ?? 'default';
    const profileName = options.profile ?? config.defaultProfile ?? 'default';
    const model = profileFor(config, profileName);
    const cache = await savedCapabilities(profileName);
    const harness = harnessFor(config, selected);
    const skills = await skillsAt(root, undefined, config.skillPolicy?.[root]);
    const binding = checksForHarness(config, root, selected);
    const issues = [];
    for (const skill of harness.skills ?? []) if (!skills.has(skill)) issues.push('Missing skill: ' + skill);
    if (harness.stages.some(stage => stage.tools?.length) && model.tools === false) issues.push('Tool calling disabled in the model profile.');
    if (cache?.key === diagnosticKey(model) && cache.tests?.tools?.status === 'fail') issues.push('The last tool-calling probe failed.');
    for (const check of binding.names ?? []) if (!Object.hasOwn(binding.checks, check)) issues.push('Unknown registered check: ' + check);
    if (harness.stages.some(stage => stage.tools?.includes('run_check')) && !Object.keys(binding.checks).length)
      issues.push('No registered checks for the verification stage.');
    print(options.json ? JSON.stringify({ harness: selected, issues }, null, 2) : issues.join('\n') || 'Harness prerequisites satisfied.');
    if (issues.length) process.exitCode = 1;
  } else if (action === 'eval') {
    const profileName = options.profile ?? config.defaultProfile ?? 'default';
    const profile = profileFor(config, profileName);
    const token = await tokenFor(profileName);
    const names = [name ?? 'default', ...(options.against ? [options.against] : [])];
    const results = [];
    for (const name of names) {
      const { metrics, durationMs, error, search, read, resume, check, citation } =
        await evaluateProfile(profile, token, { harness: harnessFor(config, name) });
      const passed = [search, read, resume, check, citation].filter(Boolean).length;
      results.push({ harness: name, passed, total: 5, durationMs, metrics, ...(error ? { error } : {}) });
    }
    print(options.json ? JSON.stringify(results, null, 2) : results.map(item => item.harness + ' · ' + item.passed + '/' +
      item.total + ' · ' + item.durationMs + ' ms · ' + item.metrics.toolCalls + ' tool calls · ' +
      item.metrics.requestMessageBytes + ' message bytes').join('\n'));
  } else if (action === 'export' && name) {
    print(JSON.stringify(harnessFor(config, name), null, 2));
  } else if (action === 'compose' && name) {
    validName(name);
    if (!args[0]) throw new Error('Use xcode harness compose <name> <recipe.json>.');
    const recipe = JSON.parse((await loadBytes(resolve(root, args[0]), 256 * 1024)).toString('utf8'));
    await updateSettings(value => {
      value.harnesses[name] = composeHarness(value, recipe);
    });
    showHarness(await settings(), name, root);
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

function sessionSearch(query, explicitStatus) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const flag = words.findIndex(word => word.startsWith('status:'));
  const status = explicitStatus ?? (flag >= 0 ? words.splice(flag, 1)[0].slice(7) : 'visible');
  if (!['visible', 'active', 'review', 'failed', 'archived', 'all'].includes(status))
    throw new Error('Use status active, review, failed, archived or all.');
  return { query: words.join(' ').toLowerCase(), status };
}

async function sessionRows(manager, query = '', status, updates) {
  let unreadable = 0;
  const entries = await manager.list(() => { unreadable++; });
  const search = sessionSearch(query, status);
  const rows = entries.map(entry => {
    const live = manager.open.get(entry.id);
    const session = live?.session ?? entry;
    const pending = session.pendingCount ?? session.queue.length;
    const state = sessionStatus(session, live);
    const include = search.status === 'all' || (search.status === 'archived' ? session.archived : !session.archived &&
      (search.status === 'visible' || (search.status === 'active' && ['running', 'paused'].includes(state)) ||
        (search.status === 'review' && ['review needed', 'apply interrupted', 'undo interrupted'].includes(state)) ||
        (search.status === 'failed' && ['failed', 'check failed'].includes(state))));
    return { id: session.id, pinned: Boolean(session.pinned), include,
      text: session.id.slice(0, 8) + ' · ' + (session.archived ? 'archived' : state) + ' · ' +
        (pending ? pending + ' pending · ' : '') + (updates?.has(session.id) ? 'unread · ' : '') +
        (session.pinned ? 'pinned · ' : '') + session.title };
  }).filter(row => row.include && row.text.toLowerCase().includes(search.query)).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return { rows, unreadable };
}

async function describeSessions(manager, selected, query = '', status, updates) {
  const { rows, unreadable } = await sessionRows(manager, query, status, updates);
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

async function suggestChecks(root, session, signal) {
  const workspace = new Workspace(root);
  const { files } = await workspace.files(signal);
  const changed = [...new Set([...(await workspace.changed(signal)), ...(session?.changes?.at(-1)?.files ?? []).map(file => file.path)])];
  const stem = value => value.split('/').at(-1).replace(/\.[^.]+$/, '').replace(/(?:[._-](?:spec|test)|Tests?)$/i, '');
  const names = new Set(changed.map(stem));
  const candidates = files.filter(file => /(?:^|[./_-])(?:tests?|specs?)(?:[./_-]|$)/i.test(file) && names.has(stem(file))).slice(0, 20);
  const checks = projectChecks(await settings(), root);
  const commands = Object.keys(checks).filter(name => !checks[name].directory ||
    changed.some(file => file.startsWith(checks[name].directory.replaceAll('\\', '/') + '/')));
  return ['Changed files · ' + changed.length, ...candidates.map(file => 'Test candidate · ' + file),
    ...commands.map(name => 'Registered check · xcode check run ' + name)].join('\n');
}

async function checkCommand(root, action, name, argv, options) {
  if (!action || action === 'list') return print(checkList(projectChecks(await settings(), root)));
  if (action === 'suggest' || action === 'compare') {
    const sessions = new Sessions(root);
    const item = name ? await sessions.find(name) : (await sessions.list())[0];
    const session = item ? await readSession(item.id) : null;
    if (action === 'suggest') return print(await suggestChecks(root, session));
    const results = compareCheckRuns(session?.queue[0]?.checks ?? session?.turns.at(-1)?.checks ?? []);
    return print(results.join('\n') || 'No repeated checks in this turn.');
  }
  if (action === 'sequence') {
    const names = [name, ...argv].filter(Boolean);
    if (!names.length) throw new Error('Provide registered check names in execution order.');
    const config = await settings();
    const checks = projectChecks(config, root);
    const token = await tokenFor(config.defaultProfile ?? 'default').catch(() => undefined);
    const results = [];
    for (const item of names) {
      const result = await runCheck(root, checks, item, undefined, { secrets: [token] });
      results.push(result);
      if (result.status !== 'passed') {
        process.exitCode = result.exitCode || 1;
        if (options['stop-on-failure']) break;
      }
    }
    return print(options.json ? JSON.stringify(results, null, 2) : results.map(checkSummary).join('\n'));
  }
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
    if (action === 'add') checks[name] = defineCheck(argv, options.timeout === undefined ? undefined : Number(options.timeout), options.in);
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

function hunkList(review, path) {
  const picked = ownHunks(review, path);
  return reviewHunks(review, path).map((header, index) =>
    (picked?.includes(index + 1) || !picked ? '[x] ' : '[ ] ') + (index + 1) + ' · ' + header).join('\n');
}

async function recoveryText(root, session) {
  const review = session.undoInProgress ?? session.queue[0]?.review;
  if (!review) return 'No saved apply or undo to inspect.';
  const rows = await reviewRecovery(new Workspace(root), review);
  return rows.map(row => row.path + ' · ' + row.state + (row.reason ? ' · ' + row.reason : '')).join('\n') +
    '\n' + (session.undoInProgress ? 'Run xcode undo to resume after resolving conflicts.' :
      'Run xcode review apply to resume after resolving conflicts.');
}

async function editReviewFile(root, review, path, source) {
  if (!path || !source) throw new Error('Provide the reviewed path and a UTF-8 replacement file.');
  const file = await new Workspace(root).read({ path: source, count: 1 });
  overrideReviewFile(review, path, await loadBytes(resolve(root, file.path), 256 * 1024));
}

async function undoPreview(root, session, id) {
  const change = id ? session.changes?.find(item => item.id === id) : session.changes?.findLast(item => !item.undoneAt);
  if (!change || change.undoneAt) throw new Error('No matching applied change to undo.');
  if (session.undoInProgress && session.undoInProgress.id !== change.id)
    throw new Error('Finish the existing interrupted undo first.');
  const review = session.undoInProgress ?? inverseReview(change);
  const conflicts = await reviewConflicts(new Workspace(root), review);
  return [conflictSummary(conflicts), reviewDiff(review).join('\n')].filter(Boolean).join('\n\n');
}

async function reviewCommand(root, action, prefix, paths) {
  if (!['show', 'check', 'hunks', 'recovery', 'edit', 'patch', 'apply', 'reject'].includes(action)) throw new Error('Use review show, check, apply or reject [session].');
  const sessions = new Sessions(root);
  try {
    const live = await sessions.select(prefix || 'latest', {});
    if (action === 'recovery') return print(await recoveryText(root, live.session));
    const review = live.session.queue[0]?.review;
    if (!review) throw new Error('There is no pending change set.');
    if (action === 'patch') return outputPatch(appliedReviewFiles(review, paths));
    if (action === 'edit') {
      await editReviewFile(root, review, paths[0], paths[1]);
      await sessions.persist(live);
      return print('Proposal updated. Review the new diff before applying.');
    }
    if (action === 'hunks') {
      if (paths.length > 1) {
        chooseHunks(review, paths[0], paths.slice(1));
        await sessions.persist(live);
      }
      return print(hunkList(review, paths[0]));
    }
    if (action === 'show' || action === 'check') {
      if (action === 'show') print(reviewDiff(review, paths[0]).join('\n'));
      const chosen = paths.length || review.state === 'applying' ? paths : review.markedPaths ?? paths;
      if (action === 'check' && review.markedPaths && !chosen.length && review.state !== 'applying')
        throw new Error('Select at least one file in /diff or pass paths to check.');
      const conflicts = await reviewConflicts(new Workspace(root), review, action === 'show' ? [] : chosen);
      if (conflicts.length) {
        info(conflictSummary(conflicts));
        if (action === 'check') process.exitCode = 1;
      } else if (action === 'check') print('No conflicts in the selected files.');
      return;
    }
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

function outputPatch(files) {
  if (stdout.isTTY) throw new Error('Redirect patch output to a file.');
  stdout.write(asGitPatch(files));
}

async function historyCommand(root, action, prefix, id, options) {
  const sessions = new Sessions(root);
  try {
    const live = await sessions.select(prefix || 'latest', {});
    if (action === 'changes') {
      if (!options.patch) return print(changeHistory(live.session));
      const change = id ? live.session.changes?.find(item => item.id === id) : live.session.changes?.at(-1);
      if (!change) throw new Error('No matching recorded change.');
      return outputPatch(change.files);
    }
    if (options.preview) return print(await undoPreview(root, live.session, id));
    const result = await sessions.undo(live, id);
    print('Undid change ' + result.id + ' (' + result.files.length + ' files).');
  } finally {
    await sessions.close();
  }
}

async function collectAttachments(root, base, profile, prompt, paths, excludes = [], token) {
  const requests = new Map([
    ...explicitReferences(prompt).map(path => [resolve(base, path), false]),
    ...paths.map(path => [resolve(base, path), true]),
  ]);
  const results = [];
  const workspace = new Workspace(root, excludes);
  let bytes = 1;
  for (const [path, explicit] of requests) {
    const source = path.replace(/#L[1-9]\d*(?:-L?[1-9]\d*)?$/, '');
    if (workspace.excluded(source)) throw new Error('Attachment is excluded by a workspace transmission rule.');
    let file;
    try {
      file = await attach(root, path, profile, undefined, { explicit, base, forbid: path => workspace.excluded(path) });
    } catch (error) {
      if (!explicit && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw error;
    }
    file.source = source;
    file.parts = file.parts.map(part => part.type === 'text' ? { ...part, text: redactSecrets(part.text, [token]) } : part);
    bytes += attachmentSize(file);
    if (results.length >= maxAttachments || bytes > maxAttachmentBytes)
      throw new Error('Maximum 8 attachments and 12 MiB of encoded attachment data per message.');
    results.push(file);
  }
  return results;
}

function streamSession(root, options) {
  return new Sessions(root, (live, event) => {
    if (options.events) {
      if (!['text', 'stage', 'tool', 'queue', 'review', 'note', 'error'].includes(event.type)) return;
      const data = event.type === 'error' ? { type: 'error', ...modelFailure(event.error) } : event;
      print(JSON.stringify({ sessionId: live.session.id, ...data }));
      return;
    }
    if (options.json) return;
    if (event.type === 'text' && !event.intermediate && stdout.isTTY) stdout.write(clean(event.text));
    else if (event.type === 'stage' && event.total > 1) info('[' + (event.index + 1) + '/' + event.total + '] ' + event.stage);
    else if (event.type === 'note') info(event.text);
    else if (event.type === 'tool' && event.check)
      info(event.check + ' · ' + event.summary + (event.exitCode === null ? '' : ' · exit ' + event.exitCode));
  });
}

async function oneMessage(sessions, live, start, options) {
  live.holdAfterCurrent = true;
  const interrupt = () => sessions.stop(live);
  process.on('SIGINT', interrupt);
  try {
    const { run } = await start();
    const result = await run;
    if (options.json || options.events) {
      const session = live.session;
      const evidence = result?.review || result?.error ? session.queue[0] : session.turns.at(-1);
      const checks = latestChecks(evidence?.checks);
      const failed = checks.filter(check => check.status !== 'passed');
      const verification = !checks.length ? 'not-run' : failed.length ? 'failed' : 'passed';
      const status = result?.error ? 'error' : result?.review ? 'awaiting-review' :
        result?.failedChecks?.length ? 'verification-failed' : 'complete';
      print(JSON.stringify({
        ...(options.events ? { type: 'result' } : {}), sessionId: session.id, status, verification,
        answer: result?.answer ?? null, changedPaths: evidence?.changed ?? [],
        checks: checks.map(check => ({ name: check.name, status: check.status, exitCode: check.exitCode })),
        ...(result?.review ? { reviewId: result.review.id } : {}),
        ...(result?.error ? { error: modelFailure(result.error) } : {}),
      }));
    }
    if (result?.error) throw result.error;
    if (result?.answer && !options.json && !options.events) {
      if (stdout.isTTY) stdout.write('\n');
      else print(result.answer);
    }
    if (result?.review) {
      const id = live.session.id.slice(0, 8);
      if (!options.events && !options.json) info('Change set awaiting approval. Run xcode review show ' + id + ' or xcode resume ' + id + '.');
      process.exitCode = 3;
    } else if (result?.failedChecks?.length) {
      if (!options.events && !options.json) info('Verification failed · ' + result.failedChecks.join(', '));
      process.exitCode = 4;
    }
  } finally {
    process.off('SIGINT', interrupt);
  }
}

async function ask(root, base, defaults, options, prompt) {
  const config = await settings();
  const name = defaults.profile || config.defaultProfile || 'default';
  const profile = profileFor(config, name);
  harnessFor(config, defaults.harness || 'default');
  const attachments = await collectAttachments(root, base, profile, prompt, options.attach ?? [],
    config.transmitExclusions?.[root], await tokenFor(name));
  const sessions = streamSession(root, options);
  try {
    const live = await sessions.select(undefined, defaults);
    live.session.write = Boolean(options.write);
    live.session.checks = Boolean(options.checks);
    await oneMessage(sessions, live, () => sessions.enqueue(live, prompt, attachments), options);
  } finally {
    await sessions.close();
  }
}

async function continueMessage(root, prefix, options) {
  const sessions = streamSession(root, options);
  try {
    const live = await sessions.select(prefix || 'latest', {});
    if (live.session.undoInProgress) throw new Error('Run xcode undo to finish the interrupted undo first.');
    if (!live.session.queue.length) throw new Error('Queue is empty.');
    if (live.session.queue[0].review) throw new Error('Show and decide the pending change set first with xcode review.');
    live.held = false;
    await oneMessage(sessions, live, () => ({ run: sessions.pump(live) }), options);
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
  let bracketedPaste = false;
  const terminalConfig = (await settings()).terminal;
  const keys = editorKeys(terminalConfig);
  const style = terminalStyle(terminalConfig);
  let previousSession;
  let recalled = [];
  const commands = [];
  const notices = [];
  const sessionUpdates = new Set();
  const rl = createInterface({
    input: stdin, output: stdout, terminal: true,
    completer: (line, callback) => {
      const completion = completeCommand(line, chatHelp, Boolean(paste));
      if (completion) return callback(null, completion);
      completeReference(root, base, line).then(result => callback(null, result), callback);
    },
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
    const count = paste?.length ? paste.length + (paste.length === 1 ? ' line · ' : ' lines · ') : '';
    const marker = style.plain ? (paste ? '| ' : '> ') : (paste ? '│ ' : '› ');
    const toned = style.color && status ? (style.theme === 'dark' ? '\x1b[96m' : '\x1b[34m') + status + '\x1b[0m' : status;
    rl.setPrompt((toned ? toned + (style.plain ? ' | ' : ' · ') : '') + (paste ? count : '') + marker);
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
    const rowCount = Math.max(1, (stdout.rows || 24) - 5);
    const width = Math.max(1, (stdout.columns || 80) - 1);
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
    print(terminalClip('↑/↓ Select session · Enter Switch · Esc Close', width));
  }

  function drawReview(move = 0) {
    if (pager.kind === 'sessions') return drawSessions();
    const rows = Math.max(1, (stdout.rows || 24) - 4);
    const { review, mode, picked, conflicts } = pager;
    const lines = mode === 'files' ? review.files.map((file, index) =>
      (index === pager.focus ? '› ' : '  ') + (picked.has(file.path) ? '[x] ' : '[ ] ') + file.path +
      (conflicts.has(file.path) ? ' · conflict · ' + conflicts.get(file.path) :
        ' · ' + fileOperation(file)) + (file.workspaceChanged ? ' · existing workspace edits' : '')
    ) : mode === 'tests' ? verificationLines(selected.session) : pager.lines;
    const last = Math.max(0, lines.length - rows);
    pager.offset = Math.max(0, Math.min(last, pager.offset + move));
    if (mode === 'files' && pager.focus < pager.offset) pager.offset = pager.focus;
    if (mode === 'files' && pager.focus >= pager.offset + rows) pager.offset = pager.focus - rows + 1;
    cursorTo(stdout, 0, 0);
    clearScreenDown(stdout);
    const width = Math.max(1, (stdout.columns || 80) - 1);
    print(terminalClip('Review ' + review.id + ' · ' + mode + ' · ' + picked.size + '/' + review.files.length + ' selected' +
      (conflicts.size ? ' · ' + conflicts.size + ' conflicts' : '') + (mode === 'diff' && pager.file ? ' · ' + pager.file : ''), width));
    for (const line of lines.slice(pager.offset, pager.offset + rows))
      print(terminalClip(line, width, mode === 'files' ? 0 : pager.column));
    print(terminalClip(mode === 'files'
      ? '↑/↓ Select file · Space Toggle · Enter Diff · Tab Tests · Esc Close'
      : '↑/↓ Scroll · [/] Files · ←/→ Columns · Tab ' + (mode === 'diff' ? 'Files' : 'Diff') + ' · Esc/q Close', width));
  }

  function closeReview() {
    if (!pager) return;
    pager = null;
    stdout.write('\x1b[?1049l');
    for (const notice of notices.splice(0)) print(notice);
    prompt();
  }

  function viewFile(path) {
    pager.mode = 'diff';
    pager.file = path;
    pager.lines = reviewDiff(pager.review, path);
    pager.lineWidth = undefined;
    pager.offset = 0;
    pager.column = 0;
  }

  function reviewKey(text, key) {
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
        const move = pageKey(key.name, Math.max(1, (stdout.rows || 24) - 5), pager.rows.length);
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
    if (pager.mode === 'diff' && (text === '[' || text === ']')) {
      clearInput();
      const files = pager.review.files;
      const index = Math.max(0, files.findIndex(file => file.path === pager.file));
      viewFile(files[(index + (text === '[' ? files.length - 1 : 1)) % files.length].path);
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
        viewFile(file.path);
      } else {
        const move = pageKey(key.name, Math.max(1, (stdout.rows || 24) - 4), pager.review.files.length);
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
    const move = pageKey(key.name, Math.max(1, (stdout.rows || 24) - 4), rows);
    if (move !== undefined) drawReview(move);
  }

  const sessions = new Sessions(root, (live, event) => {
    if (closed) return;
    if (live !== selected) {
      if (['complete', 'error', 'review'].includes(event.type)) {
        sessionUpdates.add(live.session.id);
        show('[' + live.session.id.slice(0, 8) + '] ' + (event.type === 'complete' ? 'Response ready' :
          event.type === 'review' ? 'Change set needs review' : modelFailure(event.error).detail));
      }
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
  const select = async (id, applyOverrides = true) => {
    if (selected) await saveDraft();
    const live = await sessions.select(id, defaults);
    if (applyOverrides && (options.profile || options.harness)) {
      const config = await settings();
      if (options.profile) profileFor(config, options.profile);
      if (options.harness) harnessFor(config, options.harness);
      if (!live.active) {
        live.session.profile = options.profile || live.session.profile;
        live.session.harness = options.harness || live.session.harness;
      }
    }
    if (applyOverrides && options.write) live.session.write = true;
    if (applyOverrides && options.checks) live.session.checks = true;
    await sessions.persist(live);
    let draft;
    try {
      draft = await readDraft(live.session.id);
    } catch (error) {
      show('Could not load draft: ' + error.message);
    }
    if (selected && selected.session.id !== live.session.id) previousSession = selected.session.id;
    selected = live;
    sessionUpdates.delete(live.session.id);
    recalled = [];
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
    show('xcode · ' + selected.session.title + ' · ' + selected.session.id.slice(0, 8));
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
    else if (manualCheck) manualCheck.abort();
    else if (sessions.stop(selected)) show('Stopping…');
    else if (paste) {
      paste = null;
      show('Draft discarded.');
      scheduleDraft();
    } else rl.close();
  };
  async function send(message) {
    if (!message.trim()) throw new Error('Enter a message.');
    if (message.length > maxPrompt) throw new Error('Prompt exceeds 32,000 characters.');
    const config = await settings();
    const name = selected.session.profile;
    const profile = profileFor(config, name);
    const prepared = await collectAttachments(root, base, profile, message, attachments, config.transmitExclusions?.[root], await tokenFor(name));
    const { run } = await sessions.enqueue(selected, message, prepared);
    run?.catch(error => show(error.message));
    attachments = [];
  }

  async function outgoing(message = '') {
    const session = selected.session;
    const config = await settings();
    const profile = profileFor(config, session.profile);
    const token = await tokenFor(session.profile);
    const workspace = new Workspace(root, config.transmitExclusions?.[root]);
    const paths = [...new Set([...attachments, ...explicitReferences(message).map(path => resolve(base, path))])];
    const lines = [
      'Destination · ' + visibleEndpoint(profile, await tokenFor(session.profile)) + ' · ' + profile.model,
      'Conversation · ' + session.turns.length + ' prior turns available to the context builder',
      'Pinned context · ' + (session.pins?.length ?? 0) + ' items',
    ];
    for (const path of paths) {
      const shown = redactSecrets(path, [token]);
      if (workspace.excluded(path.replace(/#L.*$/, ''))) { lines.push('Excluded · ' + shown); continue; }
      const item = await inspectAttachment(root, path, terminalSignal.signal).catch(() => null);
      if (!item) { lines.push('Unresolved reference · ' + shown); continue; }
      let masked = false;
      if (item.range || (item.bytes <= 128 * 1024 && !/\.(?:pdf|png|gif|jpe?g|webp)$/i.test(item.name))) {
        const preview = await attach(root, path, profile, terminalSignal.signal, { explicit: true }).catch(() => null);
        masked = Boolean(preview?.parts.some(part => part.type === 'text' && redactSecrets(part.text, [token]) !== part.text));
      }
      lines.push('Attachment · ' + shown + (masked ? ' · token-like text will be masked' : ''));
    }
    show(lines.join('\n'));
  }

  function addDraftLine(raw) {
    if (pasteLength + raw.length + 1 > maxPrompt)
      throw new Error('Draft exceeds 32,000 characters. Use /send or /cancel.');
    pasteLength += raw.length + 1;
    paste.push(raw);
  }
  function startDraft() {
    if (!paste) { paste = []; pasteLength = 0; }
  }
  async function submitDraft(tail) {
    const lines = tail ? [...paste, tail] : paste;
    await send(lines.join('\n'));
    paste = null;
  }
  async function input(raw, action) {
    if (pager) {
      drawReview();
      return;
    }
    if (action === 'paste-start') return startDraft();
    if (action === 'insert') {
      startDraft();
      return addDraftLine(raw);
    }
    if (action === 'send' && paste) return submitDraft(raw);
    const line = raw.trim();
    if (paste) {
      if (line === '/exit') {
        rl.close();
      } else if (line === '/cancel') {
        paste = null;
        show('Draft discarded.');
      } else if (line === '/send') {
        await submitDraft('');
      } else if (line === '/preview') {
        show(previewDraft(paste, stdout.columns || 80, terminalClip));
      } else if (line === '/outgoing') {
        await outgoing(paste.join('\n'));
      } else if (keys.newline === 'ctrl+o') {
        await submitDraft(raw);
      } else {
        addDraftLine(raw);
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
    if (command !== '/recall' && commands.at(-1) !== line) {
      commands.push(line.slice(0, 1000));
      if (commands.length > 40) commands.shift();
    }
    switch (command) {
      case '/help': show(chatHelp); break;
      case '/paste':
        startDraft();
        show('Paste or type multiple lines. /send submits, /preview previews, /cancel discards. ' +
          keys.send.toUpperCase() + ' sends · ' + keys.newline.toUpperCase() + ' adds a line.');
        break;
      case '/settings': show(await describeSettings(root, session)); break;
      case '/search':
      case '/symbol': {
        const parsed = parseArgs({ args, options: searchOptions, allowPositionals: true });
        show(await workspaceQuery(root, command.slice(1), parsed.positionals.join(' '), parsed.values));
        break;
      }
      case '/open': await openLocation(root, arg); break;
      case '/outgoing': await outgoing(args.join(' ')); break;
      case '/pin': {
        const pins = [...(session.pins ?? [])];
        if (!arg) {
          show(pins.map((pin, index) => (index + 1) + ' · ' + pin.kind + ' · ' + pin.text).join('\n') || 'No pinned context.');
          break;
        }
        if (arg === 'drop') {
          const index = Number(value) - 1;
          if (!Number.isInteger(index) || !pins[index]) throw new Error('Select a pin number.');
          pins.splice(index, 1);
        } else {
          const text = args.slice(1).join(' ').trim();
          if (!['file', 'decision', 'constraint'].includes(arg) || !text || text.length > 400 || pins.length >= 20)
            throw new Error('Use /pin file|decision|constraint <text>. Limit 20 pins of 400 characters.');
          pins.push({ kind: arg, text: clean(text) });
        }
        session.pins = pins;
        await sessions.persist(selected);
        show('Pinned context updated.');
        break;
      }
      case '/status':
        show(session.profile + ' · ' + session.harness + ' · ' + (session.write ? 'proposals allowed' : 'read-only') +
          ' · checks ' + (session.checks ? 'on' : 'off'));
        break;
      case '/recall': {
        if (args.length === 1 && /^[1-9]$/.test(arg)) {
          const text = recalled[Number(arg) - 1];
          if (!text) throw new Error('List recent entries with /recall first.');
          if (text.includes('\n')) {
            startDraft();
            for (const part of text.split('\n')) addDraftLine(part);
          } else {
            restoredLine = clean(text);
          }
        } else {
          recalled = recallEntries(session.turns, commands, args.join(' '));
          show(recalled.map((text, index) => (index + 1) + '  ' + terminalClip(text.replace(/\s+/g, ' '), 95)).join('\n') ||
            'No recent entries match.');
        }
        break;
      }
      case '/copy': {
        const answer = session.turns.findLast(turn => turn.status === 'complete' && turn.answer)?.answer;
        await copyClipboard(responseSelection(answer, arg));
        show(arg ? 'Code block copied.' : 'Reply copied.');
        break;
      }
      case '/switch': {
        const id = previousSession ?? (await sessions.list()).find(item => item.id !== session.id)?.id;
        if (!id) throw new Error('No previous session in this project.');
        await select(id);
        banner();
        break;
      }
      case '/changes': show(changeHistory(session)); break;
      case '/suggest-tests': show(await suggestChecks(root, session, terminalSignal.signal)); break;
      case '/verification': {
        const checks = session.queue[0]?.checks ?? session.turns.at(-1)?.checks ?? [];
        if (arg === 'compare') show(compareCheckRuns(checks).join('\n') || 'No repeated checks in this turn.');
        else {
          const locations = checks.slice(-8).flatMap(check => checkLocations(check).map(location =>
            (check.directory ? check.directory.replaceAll('\\', '/') + '/' : '') + location.replace(/(:\d+):\d+$/, '$1')));
          if (arg === 'open') {
            const location = locations[Number(value) - 1];
            if (!location) throw new Error('Select an error location listed by /verification.');
            await openLocation(root, location);
          } else show([...verificationLines(session), ...locations.map((location, index) =>
            (index + 1) + ' · ' + location)].join('\n'));
        }
        break;
      }
      case '/undo': {
        if (arg === 'preview') return show(await undoPreview(root, session, value));
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
      case '/guides': show(await guideText(new Workspace(root), arg)); break;
      case '/packages': show(JSON.stringify(await new Workspace(root).packages(arg), null, 2)); break;
      case '/recovery': show(await recoveryText(root, session)); break;
      case '/review-edit': {
        const review = session.queue[0]?.review;
        if (!review) throw new Error('There is no pending change set.');
        await editReviewFile(root, review, arg, value);
        await sessions.persist(selected);
        show('Proposal updated. Review the new diff before applying.');
        break;
      }
      case '/hunks': {
        const review = session.queue[0]?.review;
        if (!review) throw new Error('There is no pending change set.');
        if (args.length > 1) {
          chooseHunks(review, arg, args.slice(1));
          await sessions.persist(selected);
        }
        show(hunkList(review, arg));
        break;
      }
      case '/diff': {
        const review = session.queue[0]?.review;
        if (!review) throw new Error('There is no pending change set.');
        const conflicts = await reviewConflicts(new Workspace(root), review);
        if (style.plain) {
          show([conflictSummary(conflicts), reviewDiff(review, arg).join('\n')].filter(Boolean).join('\n\n'));
          break;
        }
        endStream();
        const picked = new Set(review.state !== 'applying' && review.markedPaths ? review.markedPaths :
          selectedFiles(review).map(file => file.path));
        const file = arg ?? review.files[0]?.path;
        const lines = reviewDiff(review, file);
        pager = { review, picked, conflicts: new Map(conflicts.map(({ path, reason }) => [path, reason])),
          file, mode: 'diff', lines, focus: Math.max(0, review.files.findIndex(item => item.path === file)), offset: 0, column: 0 };
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
      case '/session':
        await sessions.updateMetadata(selected, arg, args.slice(1).join(' '));
        show('Session updated · ' + session.title);
        break;
      case '/new': await select(); banner(); break;
      case '/resume':
        if (!arg) throw new Error('Use /resume <id|latest>.');
        await select(arg); banner(); break;
      case '/sessions': {
        const query = (arg === 'list' ? args.slice(1) : args).join(' ');
        if (arg === 'list' || style.plain) {
          await describeSessions(sessions, session.id, query, undefined, sessionUpdates);
          break;
        }
        const { rows, unreadable } = await sessionRows(sessions, query, undefined, sessionUpdates);
        if (!rows.length) { show(query ? 'No sessions match this search.' : 'No sessions for this project.'); break; }
        endStream();
        pager = { kind: 'sessions', rows, unreadable, query, focus: Math.max(0, rows.findIndex(row => row.id === session.id)), offset: 0 };
        stdout.write('\x1b[?1049h');
        drawSessions();
        break;
      }
      case '/queue':
        if (arg) {
          await sessions.updateQueue(selected, arg, value, args.slice(2).join(' '));
          show('Queue updated.');
        } else {
          show(session.queue.length ? session.queue.map((item, index) =>
            (index + 1) + ' · ' + (index === 0 && selected.active ? '[running] ' : '') + item.prompt.slice(0, 100)).join('\n') : 'Queue is empty.');
        }
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
      case '/attach': {
        const next = [...new Set([...attachments, ...args.map(path => resolve(base, path))])];
        if (!next.length) return show('Use /attach <path> or /attach <path#L10-L20>.');
        if (next.length > maxAttachments) throw new Error('Maximum ' + maxAttachments + ' attachments per message.');
        const items = [];
        for (const path of next) items.push(await inspectAttachment(root, path, terminalSignal.signal));
        attachments = next;
        const bytes = items.reduce((total, item) => total + (item.bytes ?? 0), 0);
        show('For the next message: ' + items.length + '/' + maxAttachments + ' attachments · ' + (bytes / 1024).toFixed(1) +
          ' KiB of source files' + (items.some(item => item.range) ? ' plus selected lines' : '') + '.\n' +
          items.map(item => item.name + (item.range ? ' · lines ' + item.range.first + '–' + item.range.last : '')).join('\n'));
        break;
      }
      case '/clear': attachments = []; show('Attachments cleared.'); break;
      case '/model':
        if (!arg) return showProfiles(await settings());
        if (arg === 'fallback') {
          if (!value || (args[2] && args[2] !== 'apply')) throw new Error('Use /model fallback <profile> [apply].');
          const profile = profileFor(await settings(), value);
          show('Target · ' + visibleEndpoint(profile, await tokenFor(value)) + ' · ' + profile.model +
            '\nScope · ' + session.turns.length + ' visible turns carried to a new session. Pending messages, attachments and provider replay stay in this session.');
          if (args[2] === 'apply') {
            const fork = await sessions.fork(selected, undefined, { profile: value, visibleOnly: true });
            await select(fork.session.id, false);
            banner();
          }
          break;
        }
        editable();
        profileFor(await settings(), arg);
        session.profile = arg;
        await sessions.persist(selected);
        banner();
        break;
      case '/harness':
        if (arg === 'effective') return show(effectiveHarness(await settings(), session.harness, root, session));
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
      case '/skills': show(await skillCommand(root, arg, value)); break;
      case '/history': show(historyText(session.turns, arg, value)); break;
      case '/fork': {
        const fork = await sessions.fork(selected, arg);
        await select(fork.session.id);
        banner();
        break;
      }
      case '/partial': {
        const source = session.queue[0]?.partial ? session.queue[0] : session.turns.at(-1);
        if (!source?.partial?.text) throw new Error('No saved partial response for this session.');
        const lines = source.partial.text.split('\n');
        if (!arg) {
          show((source.partial.truncated ? 'Retained tail · ' : '') + lines.length + ' lines · /partial <line> opens a continuation draft.' +
            '\n' + lines.slice(0, 50).map((line, index) => (index + 1) + '  ' + line).join('\n') +
            (lines.length > 50 ? '\n… ' + (lines.length - 50) + ' more lines' : ''));
          break;
        }
        const end = Number(arg);
        if (!Number.isInteger(end) || end < 1 || end > lines.length) throw new Error('Choose a line shown by /partial.');
        const fork = await sessions.fork(selected);
        await select(fork.session.id);
        startDraft();
        const text = 'Continue the interrupted answer from the following excerpt.\n\nOriginal request:\n' +
          source.prompt.slice(0, 4000) + '\n\nExcerpt:\n' + lines.slice(0, end).join('\n');
        for (const line of text.split('\n')) addDraftLine(line);
        show('Opened a continuation draft in a new session. /preview, then /send.');
        banner();
        break;
      }
      case '/tools':
        show((session.queue[0]?.tools ?? session.turns.at(-1)?.tools ?? [])
          .map(tool => tool.stage + ' · ' + tool.name + (tool.path ? ' ' + tool.path : '') +
            (tool.check ? ' ' + tool.check + ' · exit ' + (tool.exitCode ?? 'unavailable') : '') +
            (tool.error ? ' · ' + tool.error : '')).join('\n') || 'No tools called.');
        break;
      default: throw new Error('Unknown command. Use /help.');
    }
  }
  function queueInput(line, action) {
    streamOpen = false;
    chain = chain.then(async () => {
      if (closed) return;
      rendering = true;
      try {
        await input(line, action);
      } catch (error) {
        show(error.message);
        if (action === 'send' && line && !rl.line) restoredLine = clean(line);
      } finally {
        await saveDraft();
        rendering = false;
        prompt();
      }
    });
  }
  function takeInput() {
    const line = rl.line;
    if (line) {
      rl.write(null, { ctrl: true, name: 'a' });
      rl.write(null, { ctrl: true, name: 'k' });
    }
    return line;
  }
  function editorKey(_value, key) {
    if (!key || pager) return;
    if (key.name === 'paste-start') {
      bracketedPaste = true;
      queueInput('', 'paste-start');
    } else if (key.name === 'paste-end' && bracketedPaste) {
      bracketedPaste = false;
      const tail = takeInput();
      if (tail) queueInput(tail, 'insert');
    } else if (!bracketedPaste && !paste && key.meta && key.name === 'j') {
      if (!rl.line) queueInput('/switch');
    } else if (!bracketedPaste && paste && key.ctrl) {
      if ('ctrl+' + key.name === keys.send) queueInput(takeInput(), 'send');
      else if (keys.newline === 'ctrl+o' && key.name === 'o') queueInput(takeInput(), 'insert');
    }
  }
  function resize() {
    if (pager) drawReview();
    else prompt();
  }
  try {
    await select(prefix);
    if (options.attach?.length) attachments = [...new Set([...attachments, ...options.attach.map(path => resolve(base, path))])];
    const hasProfile = own((await settings()).profiles, selected.session.profile);
    rl.on('SIGINT', interrupt);
    stdin.on('keypress', reviewKey);
    stdin.on('keypress', scheduleDraft);
    stdin.on('keypress', editorKey);
    stdout.on('resize', resize);
    if (!style.plain) stdout.write('\x1b[?2004h');
    process.once('SIGTERM', closeTerminal);
    const finished = new Promise(resolve => {
      rl.on('close', () => { closed = true; terminalSignal.abort(); resolve(); });
      rl.on('line', line => queueInput(line, bracketedPaste ? 'insert' : undefined));
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
    stdin.off('keypress', editorKey);
    stdout.off('resize', resize);
    if (!style.plain) stdout.write('\x1b[?2004l');
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

async function guideText(workspace, path = '.') {
  const guides = await workspace.guides(path);
  const directions = new Map();
  const warnings = [];
  for (const guide of guides) {
    for (const line of guide.lines.split('\n')) {
      const instruction = /^\d+\s+\s*(?:[-*]\s*)?(do not|do|never|always)\s+(.+?)\.?$/i.exec(line);
      if (!instruction) continue;
      const rule = instruction[2].trim().toLowerCase();
      const negative = /^(?:do not|never)$/i.test(instruction[1]);
      const prior = directions.get(rule);
      if (prior && prior.negative !== negative) warnings.push('Possible conflict · ' + prior.path + ' and ' + guide.path + ' · ' + rule);
      directions.set(rule, { path: guide.path, negative });
    }
  }
  return [...guides.map(guide => guide.path + ' · applies under ' + (guide.path.includes('/') ? guide.path.slice(0, guide.path.lastIndexOf('/')) : '.') +
    '\n' + guide.lines), ...warnings].join('\n\n') || 'No scoped AGENTS.md found.';
}

const searchOptions = {
  path: { type: 'string' }, pattern: { type: 'string' }, type: { type: 'string' }, regex: { type: 'boolean' },
  offset: { type: 'string' }, line: { type: 'string' }, json: { type: 'boolean' },
};
const sourceTypes = { js: '*.{js,jsx,mjs,cjs}', ts: '*.{ts,tsx,mts,cts}', python: '*.py', json: '*.json', yaml: '*.{yaml,yml}' };

async function workspaceQuery(root, action, query, options) {
  const workspace = new Workspace(root);
  if (options.type && !Object.hasOwn(sourceTypes, options.type)) throw new Error('Unknown file type: ' + options.type);
  const params = { query, path: options.path, pattern: options.pattern ?? sourceTypes[options.type],
    offset: options.offset === undefined ? undefined : Number(options.offset), start: options.line === undefined ? undefined : Number(options.line) };
  const signal = AbortSignal.timeout(30000);
  const result = action === 'symbol' ? await workspace.symbol({ name: query, path: options.path }, signal) :
    options.regex ? await workspace.searchRegex(params, signal) : await workspace.search(params, signal);
  if (options.json) return JSON.stringify(result, null, 2);
  const lines = items => items.map(item => item.path + ':' + item.line + '  ' + item.text);
  const rows = action === 'symbol' ? ['Definitions', ...lines(result.definitions), 'References', ...lines(result.references)] : lines(result.matches);
  if (result.next) rows.push('Continue with --offset ' + result.next.offset + ' --line ' + result.next.start);
  else if (result.truncated) rows.push('Results limited. Narrow the query or scope.');
  return rows.join('\n') || 'No matching source lines.';
}

async function skillCommand(root, action = 'list', name) {
  const skills = await skillsAt(root);
  if (action === 'show') {
    const skill = skills.get(name);
    if (!skill) throw new Error('Unknown local skill.');
    const preview = await skillRead(skills, name);
    return skill.name + ' · ' + skill.origin + (skill.shadowed.length ? '\nLower priority · ' + skill.shadowed.join(', ') : '') +
      '\n\n' + preview.content;
  }
  if (action === 'enable' || action === 'disable') {
    if (!skills.has(name)) throw new Error('Unknown local skill.');
    await updateSettings(config => {
      const policy = { ...config.skillPolicy?.[root], [name]: action === 'enable' };
      config.skillPolicy = { ...config.skillPolicy, [root]: policy };
    });
  } else if (action !== 'list') throw new Error('Use skills list, show, enable or disable.');
  const policy = (await settings()).skillPolicy?.[root] ?? {};
  return [...skills.values()].map(skill => skill.name + ' · ' + skill.origin +
    (policy[skill.name] === false ? ' · disabled' : ' · enabled') +
    (skill.shadowed.length ? ' · shadows ' + skill.shadowed.join(', ') : '') +
    (skill.description ? ' · ' + skill.description : '')).join('\n') || 'No local skills found.';
}

async function localMcpCommand(root, action = 'list', name, args, options) {
  const config = await settings();
  const servers = config.localMcp?.[root] ?? {};
  if (action === 'list') return print(Object.keys(servers).join('\n') || 'No local MCP servers registered.');
  validName(name);
  if (action === 'add' || action === 'remove') {
    await updateSettings(next => {
      const project = { ...next.localMcp?.[root] };
      if (action === 'add') project[name] = mcpCommand(args);
      else delete project[name];
      next.localMcp = { ...next.localMcp, [root]: project };
    });
    return print(action === 'add' ? 'Registered ' + name + '. Local processes run with your OS permissions.' : 'Removed ' + name + '.');
  }
  const argv = own(servers, name);
  if (!argv || !['tools', 'call'].includes(action)) throw new Error('Register the local MCP server first.');
  const result = await withMcp(root, argv, async request => {
    const list = await mcpTools(request);
    if (action === 'tools') return { scope: 'explicit local commands; server annotations are advisory', ...list };
    const tool = args[0];
    if (!list.tools.some(item => item.name === tool)) throw new Error('Select a tool listed by xcode mcp tools.');
    const input = options.input ? JSON.parse((await loadBytes(resolve(options.input), 128 * 1024)).toString('utf8')) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be a JSON object.');
    return request('tools/call', { name: tool, arguments: input });
  });
  print(JSON.stringify(result, null, 2));
}

async function transmissionRules(root, action, pattern) {
  if (action === 'add' || action === 'remove') {
    if (!pattern || pattern.length > 240 || /[\x00-\x1f\\]/.test(pattern) || pattern.startsWith('/') || pattern.split('/').includes('..'))
      throw new Error('Provide a workspace-relative glob using forward slashes.');
    await updateSettings(config => {
      const rules = new Set(config.transmitExclusions?.[root] ?? []);
      if (action === 'add') rules.add(pattern);
      else rules.delete(pattern);
      if (rules.size > 100) throw new Error('Maximum 100 workspace transmission rules.');
      config.transmitExclusions = { ...config.transmitExclusions, [root]: [...rules] };
    });
  } else if (action && action !== 'list') throw new Error('Use xcode exclusions list, add <glob>, or remove <glob>.');
  print(((await settings()).transmitExclusions?.[root] ?? []).join('\n') || 'No custom transmission exclusions.');
}

async function exportSettings(root, options) {
  if ((options['include-tokens'] || options['include-history']) && !options.output)
    throw new Error('Choose --output <new-file> when exporting tokens or conversation history.');
  const config = await settings();
  const report = {
    version: 1, defaultProfile: config.defaultProfile,
    profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => {
      const allowed = ['endpoint', 'model', 'adapter', 'protocol', 'modelPreset', 'thinking', 'reasoningEffort',
        'contextWindow', 'maxTokens', 'requestTimeout', 'imageInput', 'pdfInput', 'tools'];
      return [name, Object.fromEntries(Object.entries(profile).filter(([key]) => allowed.includes(key)))];
    })),
    harnesses: config.harnesses, checks: projectChecks(config, root), terminal: config.terminal,
  };
  if (options['include-tokens']) {
    report.tokens = Object.fromEntries(await Promise.all(Object.keys(config.profiles).map(async name => [name, await savedToken(name, config)])));
  }
  if (options['include-history']) {
    report.conversations = [];
    for (const item of await new Sessions(root).list()) {
      const session = await readSession(item.id);
      if (session?.root === root) report.conversations.push(sessionMarkdown(session));
    }
  }
  const output = JSON.stringify(report, null, 2) + '\n';
  if (options.output) await writeFile(resolve(options.output), output, { flag: 'wx', mode: 0o600 });
  else print(output.trimEnd());
}

async function reportCommand(root, prefix, options) {
  if (options.only && (!options.probe || !['chat', 'sse', 'tools'].includes(options.only)))
    throw new Error('Use --probe --only chat, sse or tools.');
  const sessions = new Sessions(root);
  let unreadableSessions = 0;
  const summary = prefix ? await sessions.find(prefix) : (await sessions.list(() => { unreadableSessions++; }))[0];
  const session = summary ? await readSession(summary.id) : null;
  if (session && session.root !== root) throw new Error('Session is no longer available in this project.');
  const config = await settings().catch(() => null);
  const name = options.profile ?? session?.profile ?? config?.defaultProfile ?? 'default';
  const profile = config ? own(config.profiles, name) : null;
  const report = await buildReport({
    session, state: session ? sessionStatus(session) : null, profile,
    configuration: config ? 'readable' : 'unreadable', unreadableSessions,
    probe: options.probe ? { only: options.only, token: () => tokenFor(name) } : null,
  });
  print(JSON.stringify(report, null, 2));
}

async function main() {
  const cliOptions = {
      ...searchOptions,
      cwd: { type: 'string' }, profile: { type: 'string' }, harness: { type: 'string' },
      attach: { type: 'string', multiple: true }, endpoint: { type: 'string' }, model: { type: 'string' },
      write: { type: 'boolean' }, checks: { type: 'boolean' }, only: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      'token-stdin': { type: 'boolean' }, clear: { type: 'boolean' }, json: { type: 'boolean' }, probe: { type: 'boolean' },
      'model-jobs': { type: 'string' }, 'check-jobs': { type: 'string' },
      'stream-fallback': { type: 'string' }, 'retry-limited': { type: 'string' },
      'header-timeout': { type: 'string' }, 'first-event-timeout': { type: 'string' }, 'idle-timeout': { type: 'string' },
      clean: { type: 'string' }, session: { type: 'string' }, preview: { type: 'boolean' }, patch: { type: 'boolean' },
      input: { type: 'string' }, rows: { type: 'string' }, part: { type: 'string' }, sheet: { type: 'string' },
      where: { type: 'string' }, in: { type: 'string' }, events: { type: 'boolean' }, backend: { type: 'string' }, output: { type: 'string' },
      'stop-on-failure': { type: 'boolean' }, 'include-tokens': { type: 'boolean' }, 'include-history': { type: 'boolean' },
      status: { type: 'string' }, 'send-key': { type: 'string' }, 'newline-key': { type: 'string' }, theme: { type: 'string' },
      accessible: { type: 'boolean' }, 'no-accessible': { type: 'boolean' },
      adapter: { type: 'string' }, protocol: { type: 'string' }, preset: { type: 'string' }, against: { type: 'string' },
      thinking: { type: 'string' }, effort: { type: 'string' },
      'context-window': { type: 'string' }, 'max-tokens': { type: 'string' }, 'request-timeout': { type: 'string' },
  };
  const { positionals, values } = parseArgs({ allowPositionals: true, options: cliOptions });
  const [command, ...rest] = positionals;
  if (values.help || command === 'help') return print(help);
  if (command === 'completion') return print(shellCompletion(rest[0], help, cliOptions));
  if (values.events && values.json) throw new Error('Choose either --events or --json.');
  if (values.version) return print(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  const initial = await settings().catch(() => null);
  setLimits(initial?.execution);
  if (command === 'network') return print(JSON.stringify(await networkSettings(), null, 2));
  if (command === 'limits') {
    if (values['model-jobs'] !== undefined || values['check-jobs'] !== undefined)
      await updateSettings(config => { config.execution = executionLimits(config.execution, values); });
    const limits = executionLimits((await settings()).execution);
    return print('Model requests · ' + limits.modelJobs + '\nProject checks · ' + limits.checkJobs + '\nLimits apply per xcode process.');
  }
  if (command === 'setup') return setup(rest[0] || (await settings()).defaultProfile || 'default');
  if (command === 'profile') return profileCommand(rest[0], rest[1] || (await settings()).defaultProfile || 'default', values);
  const base = resolve(values.cwd || process.cwd());
  const root = await projectRoot(base);
  const defaults = { profile: values.profile, harness: values.harness };
  if (command === 'worktrees') {
    const items = await worktrees(root);
    return print(values.json ? JSON.stringify(items, null, 2) :
      items.map(tree => (tree.current ? '* ' : '  ') + tree.path + ' · ' + (tree.branch ?? 'detached') +
        (tree.locked ? ' · locked' : '')).join('\n'));
  }
  if (command === 'check') return checkCommand(root, rest[0], rest[1], rest.slice(2), values);
  if (command === 'review') return reviewCommand(root, rest[0], rest[1], rest.slice(2));
  if (command === 'changes' || command === 'undo') return historyCommand(root, command, rest[0], rest[1], values);
  if (command === 'harness') return harnessCommand(root, rest[0], rest[1], rest.slice(2), values);
  if (command === 'settings') return rest[0] === 'export' ? exportSettings(root, values) : print(await describeSettings(root));
  if (command === 'skills') return print(await skillCommand(root, rest[0], rest[1]));
  if (command === 'mcp') return localMcpCommand(root, rest[0], rest[1], rest.slice(2), values);
  if (command === 'extract') return print(JSON.stringify(await extractDocument(root, rest[0], values), null, 2));
  if (command === 'db') return print(JSON.stringify(await queryLocalDatabase(root, rest[0], rest[1], rest[2], values), null, 2));
  if (command === 'exclusions') return transmissionRules(root, rest[0], rest[1]);
  if (command === 'storage') {
    if (values.clean) {
      if (!values.session) throw new Error('Provide --session <id> for cleanup.');
      const found = await new Sessions(root).find(values.session);
      const removed = await cleanStorage(root, values.clean, found.id);
      return print(removed === undefined ? 'Storage cleaned.' : 'Removed ' + removed + ' pending attachments.');
    }
    const usage = await storageUsage(root);
    return print(values.json ? JSON.stringify(usage, null, 2) : [
      'Sessions · ' + usage.sessions + ' (' + usage.archived + ' archived)',
      'Conversation · ' + usage.conversationBytes + ' bytes',
      'Pending attachments · ' + usage.pendingAttachmentBytes + ' bytes (included in conversation)',
      'Drafts · ' + usage.draftBytes + ' bytes',
      'Index cache · ' + usage.cacheBytes + ' bytes',
    ].join('\n'));
  }
  if (command === 'terminal') {
    if (values['send-key'] !== undefined || values['newline-key'] !== undefined || values.theme !== undefined ||
        values.accessible || values['no-accessible']) {
      if (values.accessible && values['no-accessible']) throw new Error('Choose one accessibility mode.');
      await updateSettings(config => {
        config.terminal = configureEditor(config.terminal, { ...values, accessible: values['no-accessible'] ? false : values.accessible });
      });
    }
    const terminal = (await settings()).terminal;
    const keys = editorKeys(terminal);
    const style = terminalStyle(terminal);
    return print('Send · ' + keys.send + '\nLine break · ' + keys.newline +
      '\nTheme · ' + style.theme + '\nAccessible output · ' + (style.accessible ? 'on' : 'off'));
  }
  if (command === 'guides') return print(await guideText(new Workspace(root), rest[0] ?? values.path));
  if (command === 'packages') return print(JSON.stringify(await new Workspace(root).packages(rest[0] ?? values.path), null, 2));
  if (command === 'open') return openLocation(root, rest[0]);
  if (command === 'search' || command === 'symbol') return print(await workspaceQuery(root, command, rest.join(' '), values));
  if (command === 'report') return reportCommand(root, rest[0], values);
  if (command === 'continue') return continueMessage(root, rest[0], values);
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
    return describeSessions(sessions, undefined, rest.join(' '), values.status);
  }
  if (command === 'session') {
    const sessions = new Sessions(root);
    const [action, prefix = 'latest', turn, count] = rest;
    if (action === 'export' || action === 'history') {
      const entry = await sessions.find(prefix);
      const session = action === 'export' ? await readSession(entry.id) : await readSessionPage(entry.id, turn, count);
      if (!session || session.root !== root) throw new Error('Session is no longer available in this project.');
      return print(action === 'export' ? sessionMarkdown(session) : formatHistoryPage(session, 'xcode session history ' + entry.id.slice(0, 8)));
    }
    try {
      const live = await sessions.select(prefix, defaults);
      if (action === 'fork') {
        const fork = await sessions.fork(live, turn);
        print(fork.session.id);
      } else {
        const session = await sessions.updateMetadata(live, action, rest.slice(2).join(' '));
        print('Session updated · ' + session.title);
      }
    } finally {
      await sessions.close();
    }
    return;
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

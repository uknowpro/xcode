import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { complete, completionUrl } from '../src/model.mjs';
import { attach, explicitReferences, splitArgs } from '../src/attachments.mjs';
import { Workspace, replaceText } from '../src/workspace.mjs';
import { completeReference } from '../src/terminal.mjs';

const exec = promisify(execFile);
const childTimeout = Number(process.env.XCODE_TEST_TIMEOUT_MS ?? 60000);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function temp(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'xcode-test-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function server(t, handle) {
  const requests = [];
  const api = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : null;
      requests.push({ url: req.url, headers: req.headers, body });
      await handle(body, res, requests.length);
    } catch (error) {
      res.writeHead(500).end();
      throw error;
    }
  });
  await new Promise((resolve, reject) => {
    api.on('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    api.closeAllConnections();
    return new Promise(resolve => api.close(resolve));
  });
  return { url: 'http://127.0.0.1:' + api.address().port, requests };
}

function reply(res, content) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}

function tool(res, name, args) {
  res.setHeader('Content-Type', 'text/event-stream');
  for (const [index, argument] of [args.slice(0, 7), args.slice(7)].entries()) {
    const delta = { tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call_test', function: { name, arguments: argument } } :
      { function: { arguments: argument } }) }] };
    res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\r\n\r\n');
  }
  res.end('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
}

async function profile(t, api) {
  const work = await temp(t);
  const state = await temp(t);
  const env = { ...process.env, XCODE_HOME: state };
  delete env.XCODE_API_TOKEN;
  const cli = (...args) => exec(process.execPath, [cliPath, ...args], { env, cwd: work });
  const save = spawn(process.execPath, [cliPath, 'profile', 'set', 'work', '--endpoint', api.url, '--model', 'fixture', '--token-stdin'], { env, cwd: work });
  save.stdin.end('fixture-token\n');
  assert.equal(await new Promise(resolve => save.on('close', resolve)), 0);
  return { work, state, cli };
}

test('default path, /v1 and full Chat Completions URLs support remote HTTP', () => {
  assert.equal(completionUrl('http://model.example:8000'), 'http://model.example:8000/v1/chat/completions');
  assert.equal(completionUrl('http://model.example/v1/'), 'http://model.example/v1/chat/completions');
  assert.equal(completionUrl('https://model.example/route/chat/completions'), 'https://model.example/route/chat/completions');
  assert.throws(() => completionUrl('http://name:pass@model.example/v1'), /without credentials/);
  assert.throws(() => completionUrl('file:///v1'), /HTTP/);
});

test('workspace respects ignores, includes scoped instructions and preserves BOM and CRLF on edit', async t => {
  const root = await temp(t);
  const outside = await temp(t);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'AGENTS.md'), 'root guide\n');
  await writeFile(join(root, 'src', 'AGENTS.md'), 'nested guide\n');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'ignored.txt'), 'retryOption\n');
  await writeFile(join(root, '.env'), 'retryOption');
  await writeFile(join(root, 'src', 'a.js'), '\uFEFFstart\r\nconst retryOption = 3;\r\nend\r\n');
  await writeFile(join(outside, 'outside.js'), 'retryOption');
  if (process.platform !== 'win32') await symlink(join(outside, 'outside.js'), join(root, 'src', 'linked.js'));
  const ws = new Workspace(root);
  assert.deepEqual((await ws.search({ query: 'retryOption' })).matches.map(x => [x.path, x.line]), [['src/a.js', 2]]);
  assert.deepEqual((await ws.guides('src/a.js')).map(x => x.path), ['AGENTS.md', 'src/AGENTS.md']);
  await assert.rejects(ws.read({ path: '.env' }), /excluded/);
  await assert.rejects(ws.read({ path: join(outside, 'outside.js') }), /excluded/);
  if (process.platform !== 'win32') await assert.rejects(ws.read({ path: 'src/linked.js' }), /Symbolic links/);
  const source = await readFile(join(root, 'src', 'a.js'));
  const modified = replaceText(source, 'const retryOption = 3;\nend', 'const retryOption = 4;\nend', 4096);
  assert.equal(modified.output, '\uFEFFstart\r\nconst retryOption = 4;\r\nend\r\n');
});

test('repo map ranks symbols and resolves relative imports', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'billing.ts'), 'export function retryInvoice() {}\n');
  await writeFile(join(root, 'other.ts'), 'import { retryInvoice } from "./billing.js";\nexport class Worker {}\n');
  const map = await new Workspace(root).map({ query: 'retryInvoice' });
  assert.equal(map.files[0].symbols[0].name, 'retryInvoice');
  assert.deepEqual(map.files[1].imports, ['billing.ts']);
});

test('attachments respect model capabilities and preserve paths with spaces', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'status report.txt'), 'Quarterly report');
  await writeFile(join(root, 'image.png'), Buffer.from([137, 80, 78, 71]));
  assert.deepEqual(explicitReferences('summarize @"status report.txt"'), ['status report.txt']);
  assert.deepEqual(splitArgs('"D:\\Documents\\test file.txt"'), ['D:\\Documents\\test file.txt']);
  assert.match((await attach(root, 'status report.txt', {})).parts[0].text, /Quarterly report/);
  await assert.rejects(attach(root, 'image.png', {}), /image input disabled/);
  assert.match((await attach(root, 'image.png', { imageInput: true })).parts[0].image_url.url, /^data:image\/png;base64,/);
});

test('CLI retains token on endpoint changes and finds a local file from a natural-language question', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) return tool(res, 'grep', '{"query":"retryCount"}');
    if (request === 2) {
      assert.match(body.messages.at(-1).content, /payments\.js/);
      return tool(res, 'read', '{"path":"payments.js","start":2,"count":1}');
    }
    assert.match(body.messages.at(-1).content, /2 const retryCount = 3/);
    return reply(res, '결제 재시도 횟수는 payments.js:2에서 설정합니다.');
  });
  const { work, cli } = await profile(t, api);
  await writeFile(join(work, 'payments.js'), '// payments\nconst retryCount = 3;\n');
  await cli('profile', 'set', 'work', '--endpoint', api.url + '/custom/v1/');
  const { stdout } = await cli('ask', '결제 재시도 횟수는 어디에서 설정하나요?');
  assert.match(stdout, /payments\.js:2/);
  assert.equal(api.requests.length, 3);
  assert.equal(api.requests[0].url, '/custom/v1/chat/completions');
  assert.ok(api.requests.every(request => request.headers.authorization === 'Bearer fixture-token'));
  assert.match((await cli('sessions')).stdout, /결제 재시도/);
});

test('CLI reviews a multi-file change before applying it and runs the authorized verification check', async t => {
  const api = await server(t, (body, res, request) => {
    const names = body.tools.map(tool => tool.function.name);
    if (request <= 2) assert.ok(!names.includes('propose_changes'));
    if (request === 1) return tool(res, 'read', '{"path":"a.txt"}');
    if (request === 2) return reply(res, 'Change a.txt.');
    if (request === 3) {
      assert.ok(names.includes('propose_changes'));
      assert.ok(!names.includes('run_check'));
      return tool(res, 'propose_changes', JSON.stringify({
        changes: [
          { path: 'a.txt', action: 'replace', oldText: 'before', newText: 'after' },
          { path: 'new/path/b.txt', action: 'create', newText: 'created\n' },
        ],
      }));
    }
    if (request === 4) {
      assert.equal(JSON.parse(body.messages.at(-1).content).status, 'applied');
      return reply(res, 'Edited a.txt and created a file.');
    }
    assert.ok(names.includes('verify_edits'));
    assert.ok(names.includes('run_check'));
    assert.ok(!names.includes('propose_changes'));
    if (request === 5) return tool(res, 'run_check', '{"name":"validate"}');
    const check = JSON.parse(body.messages.at(-1).content);
    assert.equal(check.exitCode, 0);
    assert.match(check.stdout, /both changes present/);
    return reply(res, 'Updated a.txt and verified both changes.');
  });
  const { work, cli } = await profile(t, api);
  await writeFile(join(work, 'a.txt'), 'before\n');
  await cli('check', 'add', 'validate', '--', 'node', '-e',
    'if(!require("fs").existsSync("new/path/b.txt")) process.exit(7); console.log("both changes present");');
  await assert.rejects(cli('ask', 'Rename test contents', '--harness', 'implement', '--write', '--checks'),
    error => error.code === 3 && /awaiting approval/.test(error.stderr));
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'before\n');
  assert.match((await cli('sessions')).stdout, /review needed/);
  const diff = (await cli('review', 'show')).stdout;
  assert.match(diff, /-before/);
  assert.match(diff, /\+after/);
  assert.match(diff, /new\/path\/b\.txt/);
  await writeFile(join(work, 'a.txt'), 'outside edit\n');
  await mkdir(join(work, 'new', 'path'), { recursive: true });
  await writeFile(join(work, 'new', 'path', 'b.txt'), 'existing target\n');
  await assert.rejects(cli('review', 'check'), error =>
    error.code === 1 && /a\.txt · Contents changed/.test(error.stderr) &&
    /new\/path\/b\.txt · Target already exists/.test(error.stderr));
  await assert.rejects(cli('review', 'apply'), /Files changed after the proposal was prepared/);
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'outside edit\n');
  assert.equal(await readFile(join(work, 'new', 'path', 'b.txt'), 'utf8'), 'existing target\n');
  await writeFile(join(work, 'a.txt'), 'before\n');
  await rm(join(work, 'new', 'path', 'b.txt'));
  assert.match((await cli('review', 'check')).stdout, /No conflicts/);
  await cli('review', 'apply');
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(join(work, 'new', 'path', 'b.txt'), 'utf8'), 'created\n');
  const result = await cli('continue');
  assert.match(result.stdout, /Updated a\.txt/);
  assert.match(result.stderr, /validate · passed · exit 0/);
});

test('Git patch export preserves file bytes and review check options validate directory paths', async t => {
  const { asGitPatch } = await import('../src/changes.mjs');
  const { defineCheck } = await import('../src/checks.mjs');
  const root = await temp(t);
  await writeFile(join(root, 'space name.txt'), 'before\r\n');
  const patch = asGitPatch([{ path: 'space name.txt', before: 'before\r\n', after: 'after\r\n' }]);
  await writeFile(join(root, 'edit.patch'), patch);
  await exec('git', ['apply', 'edit.patch'], { cwd: root });
  assert.equal(await readFile(join(root, 'space name.txt'), 'utf8'), 'after\r\n');
  assert.equal(defineCheck(['node', '-v'], 15, 'packages/api').directory, 'packages/api');
  assert.throws(() => defineCheck(['node'], 15, '../outside'), /relative to the workspace/);
});

test('review edits report newline and workspace changes and do not affect workspace files', async () => {
  const { overrideReviewFile, reviewDiff, fileOperation } = await import('../src/changes.mjs');
  const file = { path: 'sample.txt', before: 'first\r\n', after: 'second\r\n', workspaceChanged: true };
  const review = { files: [file], hunkSelections: { 'sample.txt': [1] }, state: 'pending' };
  overrideReviewFile(review, file.path, Buffer.from('written by user'));
  assert.equal(file.before, 'first\r\n');
  assert.equal(file.after, 'written by user');
  assert.equal(review.hunkSelections[file.path], undefined);
  assert.match(reviewDiff(review).join('\n'), /Existing workspace edits[\s\S]*CRLF[\s\S]*Final newline/);
  assert.equal(fileOperation({ move: { from: 'old.txt' } }), 'Move destination ← old.txt');
});

test('selected hunks preserve unselected lines and ambiguous edits report match locations', async () => {
  const { appliedReviewFiles, chooseHunks, reviewHunks } = await import('../src/changes.mjs');
  const lines = ['before', ...Array.from({ length: 20 }, (_, index) => 'Line ' + index), 'after'];
  const before = lines.join('\n') + '\n';
  lines[0] = 'updated first';
  lines[21] = 'updated last';
  const review = { files: [{ path: 'sample.txt', before, after: lines.join('\n') + '\n' }] };
  assert.equal(reviewHunks(review, 'sample.txt').length, 2);
  chooseHunks(review, 'sample.txt', ['2']);
  assert.match(appliedReviewFiles(review)[0].after, /^before[\s\S]*updated last/);
  assert.throws(() => chooseHunks(review, 'sample.txt', ['all', '3']), /hunk numbers/);
  const text = Buffer.from('same\nother\nsame\n');
  assert.throws(() => replaceText(text, 'same', 'new', 100), /Candidate lines: 1, 3/);
  assert.equal(replaceText(text, 'same', 'new', 100, 3).output, 'same\nother\nnew\n');
});

test('a late file conflict rolls back earlier replacements and respects existing user changes', async t => {
  const root = await temp(t);
  const state = await temp(t);
  const module = new URL('../src/changes.mjs', import.meta.url).href;
  const wsModule = new URL('../src/workspace.mjs', import.meta.url).href;
  const store = new URL('../src/store.mjs', import.meta.url).href;
  await writeFile(join(root, 'a.txt'), 'original');
  await writeFile(join(root, 'b.txt'), 'original');
  const program = [
    'import assert from "node:assert/strict";',
    'import { mkdir, readFile, writeFile } from "node:fs/promises";',
    'const { prepareReview, applyReview } = await import(' + JSON.stringify(module) + ');',
    'const { Workspace } = await import(' + JSON.stringify(wsModule) + ');',
    'const { sessionsDir } = await import(' + JSON.stringify(store) + ');',
    'await mkdir(sessionsDir);',
    'const project = new Workspace(process.cwd());',
    'const changes = ["a.txt","b.txt"].map(path => ({ path, action:"replace",oldText:"original",newText:"proposed" }));',
    'await assert.rejects(prepareReview(project,[{path:"../escape",action:"create",newText:"x"}]), /canonical/);',
    'const review = await prepareReview(project, changes, ["a.txt","b.txt"]);',
    'let writes = 0;',
    'await assert.rejects(applyReview(project, review, async () => { if (writes++ === 0) await writeFile("b.txt","user edit"); }), /changed while/);',
    'assert.equal(review.state, "pending");',
    'assert.equal(await readFile("a.txt", "utf8"), "original");',
    'assert.equal(await readFile("b.txt", "utf8"), "user edit");',
    'await writeFile("b.txt", "original");',
    'await applyReview(project, review, async () => {});',
    'await applyReview(project, review, async () => {});',
    'assert.equal(await readFile("a.txt", "utf8"), "proposed");',
    'assert.equal(await readFile("b.txt", "utf8"), "proposed");',
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: root, env: { ...process.env, XCODE_HOME: state }, timeout: childTimeout,
  });
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'proposed');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'proposed');
});

test('profile diagnostics distinguish plain chat, SSE and supported tool calls', async t => {
  const api = await server(t, (body, res, request) => {
    if (body.tools) return tool(res, 'xcode_probe', '{}');
    if (request === 2) {
      assert.equal(body.stream, true);
      res.setHeader('Content-Type', 'text/event-stream');
      return res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
    }
    if (request === 1) assert.equal(body.stream, false);
    return reply(res, 'OK');
  });
  const { cli } = await profile(t, api);
  const { stdout } = await cli('profile', 'test');
  assert.match(stdout, /CHAT PASS/);
  assert.match(stdout, /SSE PASS/);
  assert.match(stdout, /TOOLS PASS/);
  await assert.rejects(cli('profile', 'test', '--only', 'sse'), error =>
    error.code === 1 && /SSE FAIL.*JSON/.test(error.stdout));
});

test('path completion quotes spaces and excludes paths outside the project', async t => {
  const root = await temp(t);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'some notes.txt'), 'text');
  await writeFile(join(root, 'src', '.env'), 'secret');
  assert.deepEqual(await completeReference(root, root, 'look at @src/so'), [['@"src/some notes.txt"'], '@src/so']);
  assert.deepEqual(await completeReference(root, root, 'look at @src/.e'), [[], '@src/.e']);
  assert.deepEqual(await completeReference(root, root, 'look at @../'), [[], '@../']);
});

test('rate or usage limits are terminal errors and SSE handles split UTF-8', async t => {
  const api = await server(t, async (_body, res, request) => {
    if (request === 1) return res.writeHead(429).end('Too many requests');
    res.setHeader('Content-Type', 'text/event-stream');
    const text = Buffer.from('data: {"choices":[{"delta":{"content":"테스트"},"finish_reason":null}]}\n\n');
    const split = text.indexOf(Buffer.from('테')) + 1;
    res.write(text.subarray(0, split));
    await delay(10);
    res.end(Buffer.concat([text.subarray(split), Buffer.from('data: [DONE]\n\n')]));
  });
  const config = { endpoint: api.url, model: 'test' };
  const messages = [{ role: 'user', content: 'hello' }];
  await assert.rejects(complete(config, '', messages), error => error.status === 429 && !error.retryable);
  const output = await complete(config, '', messages);
  assert.equal(output.content, '테스트');
});

test('concurrent sessions preserve their queues and stop-and-advance sends the next prompt', async t => {
  const api = await server(t, (body, res) => {
    const last = body.messages.at(-1).content;
    if (last === 'slow') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      return;
    }
    reply(res, 'Processed ' + last);
  });
  const { work, state } = await profile(t, api);
  const module = new URL('../src/session.mjs', import.meta.url).href;
  const program = [
    'import assert from "node:assert/strict";',
    'const { Sessions } = await import(' + JSON.stringify(module) + ');',
    'const sessions = new Sessions(process.cwd());',
    'const first = await sessions.select(undefined, {});',
    'const other = await sessions.select(undefined, {});',
    'try {',
    '  const started = await sessions.enqueue(first, "slow");',
    '  await sessions.enqueue(first, "next");',
    '  const parallel = await sessions.enqueue(other, "parallel");',
    '  assert.equal((await parallel.run).answer, "Processed parallel");',
    '  assert.equal(first.session.queue.length, 2);',
    '  assert.equal(sessions.stop(first, true), true);',
    '  await started.run;',
    '  await first.active?.promise;',
    '  assert.deepEqual(first.session.turns.map(turn => turn.status), ["stopped", "complete"]);',
    '  assert.equal(first.session.turns[1].answer, "Processed next");',
    '} finally { await sessions.close(); }',
    'const reopened = new Sessions(process.cwd());',
    'try {',
    '  const previous = await reopened.select(first.session.id, {});',
    '  assert.equal(previous.session.turns.length, 2);',
    '} finally { await reopened.close(); }',
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: work, env: { ...process.env, XCODE_HOME: state }, timeout: childTimeout,
  });
  assert.ok(api.requests.some(request => request.body.messages.at(-1).content === 'next'));
});

test('rejecting a proposal preserves files and reports the decision to the model', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) {
      assert.ok(!body.tools.some(item => item.function.name === 'run_check'));
      return tool(res, 'propose_changes', JSON.stringify({
        changes: [{ path: 'unsaved.txt', action: 'create', newText: 'Do not create this.' }],
      }));
    }
    assert.equal(JSON.parse(body.messages.at(-1).content).status, 'rejected_by_user');
    return reply(res, 'The proposal was rejected.');
  });
  const { work, cli } = await profile(t, api);
  await assert.rejects(cli('ask', 'Create a file', '--write'), error => error.code === 3);
  await cli('review', 'reject');
  assert.match((await cli('continue')).stdout, /proposal was rejected/);
  await assert.rejects(readFile(join(work, 'unsaved.txt')), { code: 'ENOENT' });
});

test('partial approval preserves paired moves, and undo refuses to overwrite subsequent edits', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) return tool(res, 'read', '{"path":"old.txt"}');
    if (request === 2) return tool(res, 'read', '{"path":"retired.txt"}');
    if (request === 3) return tool(res, 'propose_changes', JSON.stringify({
      changes: [
        { path: 'old.txt', action: 'move', to: 'docs/renamed.txt' },
        { path: 'retired.txt', action: 'delete' },
        { path: 'extra.txt', action: 'create', newText: 'Excluded' },
      ],
    }));
    const received = JSON.parse(body.messages.at(-1).content);
    assert.deepEqual(received.files, ['old.txt', 'docs/renamed.txt', 'retired.txt']);
    assert.deepEqual(received.excluded, ['extra.txt']);
    return reply(res, 'Applied the approved paths.');
  });
  const { work, cli } = await profile(t, api);
  await writeFile(join(work, 'old.txt'), 'Moved text\n');
  await writeFile(join(work, 'retired.txt'), 'Restore me\n');
  await assert.rejects(cli('ask', 'Move and delete files', '--write'), error => error.code === 3);
  const { stdout: diff } = await cli('review', 'show', 'latest');
  assert.match(diff, /rename old\.txt → docs\/renamed\.txt/);
  assert.match(diff, /--- retired\.txt\n\+\+\+ \/dev\/null/);
  assert.equal(await readFile(join(work, 'retired.txt'), 'utf8'), 'Restore me\n');
  await cli('review', 'apply', 'latest', 'old.txt', 'retired.txt');
  await cli('continue');
  const history = (await cli('changes')).stdout;
  const id = history.match(/^([a-f0-9]{8}) · applied/)?.[1];
  assert.ok(id);
  assert.doesNotMatch(history, /extra\.txt/);
  await assert.rejects(readFile(join(work, 'extra.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(work, 'old.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(work, 'retired.txt')), { code: 'ENOENT' });
  await writeFile(join(work, 'docs', 'renamed.txt'), 'User edit');
  await assert.rejects(cli('undo', 'latest', id), error => error.code === 1 && /docs\/renamed\.txt · Contents changed/.test(error.stderr));
  await assert.rejects(readFile(join(work, 'retired.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(work, 'docs', 'renamed.txt'), 'utf8'), 'User edit');
  await writeFile(join(work, 'docs', 'renamed.txt'), 'Moved text\n');
  await cli('undo', 'latest', id);
  assert.equal(await readFile(join(work, 'old.txt'), 'utf8'), 'Moved text\n');
  assert.equal(await readFile(join(work, 'retired.txt'), 'utf8'), 'Restore me\n');
  await assert.rejects(readFile(join(work, 'docs', 'renamed.txt')), { code: 'ENOENT' });
  assert.match((await cli('changes')).stdout, new RegExp(id + ' · undone'));
});

test('resuming older sessions restores decisions, file references, applied paths and check results', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) return reply(res, 'First message.');
    const context = body.messages[0].content;
    assert.match(context, /Keep the retry budget at five/);
    assert.match(context, /src\/api.mjs:17/);
    assert.match(context, /appliedPaths.*src\/api.mjs/);
    assert.match(context, /"name":"regression","status":"failed","exitCode":7/);
    assert.ok(body.messages.length < 23);
    return reply(res, 'The earlier decision is in context.');
  });
  const { state, cli } = await profile(t, api);
  await cli('ask', 'Start a session.');
  const saved = join(state, 'sessions');
  const [name] = (await readdir(saved)).filter(file => file.endsWith('.json'));
  const path = join(saved, name);
  const session = JSON.parse(await readFile(path, 'utf8'));
  session.turns.unshift({
    prompt: 'Decide the retry budget.',
    answer: 'Decision: Keep the retry budget at five. See src/api.mjs:17.',
    changed: ['src/api.mjs'],
    tools: [{ name: 'read', path: 'src/api.mjs', line: 17 }],
    checks: [{ name: 'regression', status: 'failed', exitCode: 7, stderr: 'Budget mismatch.' }],
  });
  for (let index = 0; index < 10; index++) session.turns.push({ prompt: 'Follow-up ' + index, answer: 'Still tracking.' });
  session.queue.push({ prompt: 'Review the retry budget.', attachments: [], completed: [], changed: [], tools: [] });
  await writeFile(path, JSON.stringify(session));
  assert.match((await cli('continue')).stdout, /earlier decision/);
  const resumed = JSON.parse(await readFile(path, 'utf8'));
  const firstTurn = (await cli('session', 'history', 'latest', '2', '1')).stdout;
  assert.ok(firstTurn.includes(session.turns[0].answer));
  assert.ok(resumed.memory.through >= 5);
  assert.match(resumed.memory.entries[0].result, /retry budget at five/);
});

test('harness checks restrict the model to the registered binding for this project', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) return reply(res, 'Inspect the module.');
    if (request === 2) {
      assert.match(body.messages[0].content, /Enabled project checks: validate\n/);
      assert.doesNotMatch(body.messages[0].content, /Enabled project checks:.*other/);
      return tool(res, 'run_check', '{"name":"other"}');
    }
    assert.match(body.messages.at(-1).content, /Unknown project check/);
    return reply(res, 'Only the bound validation check is allowed.');
  });
  const { cli } = await profile(t, api);
  await cli('check', 'add', 'validate', '--', 'node', '-e', 'process.exit(0)');
  await cli('check', 'add', 'other', '--', 'node', '-e', 'process.exit(8)');
  await cli('harness', 'checks', 'terraform-review', 'validate');
  assert.match((await cli('harness', 'show', 'terraform-review')).stdout, /Project checks: validate/);
  const { stdout } = await cli('ask', 'Check the module', '--harness', 'terraform-review', '--checks');
  assert.match(stdout, /Only the bound validation check/);
  await cli('harness', 'checks', 'terraform-review', '--clear');
  assert.match((await cli('harness', 'checks', 'terraform-review')).stdout, /other/);
});

function reasoningReply(res, content, reasoning, call, field = 'reasoning_content') {
  res.setHeader('Content-Type', 'text/event-stream');
  const send = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  const split = Math.floor(reasoning.length / 2);
  send({ [field]: reasoning.slice(0, split) });
  send({ [field]: reasoning.slice(split) });
  if (call) {
    send({ tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
  } else {
    send({ content });
  }
  res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}

test('DeepSeek profile auto-detects and diagnoses a full tool round trip with configured effort', async t => {
  const api = await server(t, (body, res, request) => {
    assert.equal(body.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
    if (request <= 2) {
      assert.deepEqual(body.thinking, { type: 'enabled' });
      assert.equal(body.reasoning_effort, 'max');
      assert.equal(body.max_tokens, 4096);
    } else {
      assert.equal(body.thinking, undefined);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.max_tokens, undefined);
    }
    if (request === 1) return reasoningReply(res, '', '프로브 원본', { id: 'probe', name: 'xcode_probe', args: {} });
    if (request === 2) {
      assert.equal(body.messages[1].reasoning_content, '프로브 원본');
      assert.equal(body.messages[2].tool_call_id, 'probe');
      return reasoningReply(res, 'OK', 'probe finish');
    }
    return reply(res, 'OK');
  });
  const { cli, state } = await profile(t, api);
  await cli('profile', 'set', 'work', '--model', 'deepseek-ai/DeepSeek-V4.1-Flash');
  const settings = await cli('profile', 'show');
  assert.match(settings.stdout, /deepseek-flash \(auto\)/);
  assert.match(settings.stdout, /Effort · server default/);
  await assert.rejects(cli('profile', 'tune', '--effort', 'ultra'), /Effort must be/);
  await cli('profile', 'tune', '--thinking', 'on', '--effort', 'max', '--context-window', '65536', '--max-tokens', '4096');
  const test = await cli('profile', 'test', '--only', 'tools');
  assert.match(test.stdout, /TOOLS PASS.*reasoning replay/);
  assert.doesNotMatch(test.stdout, /프로브 원본|fixture-token/);
  assert.equal(JSON.parse(await readFile(join(state, 'tokens.json'), 'utf8')).work, 'fixture-token');
  await cli('profile', 'tune', '--adapter', 'compatible');
  await cli('profile', 'test', '--only', 'chat');
});

test('DeepSeek replays assistant fields across tools, stages, approvals and a restarted session', async t => {
  const call = (id, name, args) => ({ id, name, args });
  const api = await server(t, (body, res, request) => {
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.thinking, undefined);
    const thinking = label => body.messages.some(item => item.role === 'assistant' && item.reasoning_content === label);
    if (request === 1)
      return reasoningReply(res, '', 'private read 한글', call('read-file', 'read', { path: 'a.txt' }));
    if (request === 2) {
      assert.ok(thinking('private read 한글'));
      assert.equal(body.messages.at(-1).tool_call_id, 'read-file');
      return reasoningReply(res, 'Inspected a.txt.', 'private inspect', undefined, 'reasoning');
    }
    assert.ok(thinking('private read 한글') && thinking('private inspect'));
    if (request === 3) {
      assert.match(body.messages.at(-1).content, /Continue the current task/);
      return reasoningReply(res, '', 'private proposal',
        call('proposal', 'edit', { path: 'a.txt', oldText: 'before', newText: 'after' }));
    }
    assert.ok(thinking('private proposal'));
    if (request === 4) {
      assert.equal(JSON.parse(body.messages.at(-1).content).status, 'applied');
      return reasoningReply(res, 'Applied a.txt.', 'private applied');
    }
    assert.ok(thinking('private applied'));
    if (request === 5) return reasoningReply(res, 'Verified a.txt.', 'private verified');
    assert.ok(thinking('private verified'));
    assert.equal(body.messages.at(-1).content, 'What was previously changed?');
    return reasoningReply(res, 'a.txt was changed.', 'private follow-up');
  });
  const { work, state, cli } = await profile(t, api);
  await writeFile(join(work, 'a.txt'), 'before\n');
  await cli('profile', 'set', 'work', '--model', 'DeepSeek-V4.1-Flash');
  await assert.rejects(cli('ask', 'Change a.txt', '--harness', 'implement', '--write'),
    error => error.code === 3 && !/private /.test(error.stdout + error.stderr));
  await cli('review', 'apply');
  await cli('profile', 'set', 'work', '--endpoint', api.url + '/wrong/v1');
  await assert.rejects(cli('continue'), error => error.code === 1 && /original model endpoint/.test(error.stderr));
  assert.equal(api.requests.length, 3);
  await cli('profile', 'set', 'work', '--endpoint', api.url);
  const resumed = await cli('continue');
  assert.match(resumed.stdout, /Verified a\.txt/);
  assert.doesNotMatch(resumed.stdout + resumed.stderr, /private /);
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'after\n');

  const module = new URL('../src/session.mjs', import.meta.url).href;
  const program = [
    'const { Sessions } = await import(' + JSON.stringify(module) + ');',
    'const sessions = new Sessions(process.cwd());',
    'try {',
    '  const live = await sessions.select("latest", {});',
    '  live.session.harness = "default";',
    '  const { run } = await sessions.enqueue(live, "What was previously changed?");',
    '  const outcome = await run;',
    '  if (outcome.error) throw outcome.error;',
    '  console.log(outcome.answer);',
    '} finally { await sessions.close(); }',
  ].join('\n');
  const env = { ...process.env, XCODE_HOME: state };
  delete env.XCODE_API_TOKEN;
  const next = await exec(process.execPath, ['--input-type=module', '--eval', program], { cwd: work, env, timeout: childTimeout });
  assert.match(next.stdout, /a\.txt was changed/);
  assert.doesNotMatch(next.stdout, /private /);
  assert.equal(api.requests.length, 6);
});

test('DeepSeek never archives incomplete protocol turns and keeps old reasoning scoped to the same endpoint', async () => {
  const { modelPolicy } = await import('../src/model-profile.mjs');
  const { completeWireStage, completedWire, startWire, wireStage } = await import('../src/wire-history.mjs');
  const jobs = prompt => ({ prompt, completed: [], attachments: [] });
  const profile = { model: 'DeepSeek-V4.1-Flash', endpoint: 'http://one.example/v1', contextWindow: 4096 };
  const policy = modelPolicy(profile);
  const stage = { name: 'Answer' };
  const session = { turns: [] };
  const first = jobs('Retain this prompt');
  startWire(first, profile, policy);
  const input = wireStage(session, first, policy, stage).input;
  completeWireStage(first, input, { role: 'assistant', content: 'summarizable', reasoning_content: 'x'.repeat(9000) }, policy);
  assert.equal(completedWire(first), undefined);
  assert.equal(wireStage(session, first, policy, stage).input.content, 'Retain this prompt');
  assert.throws(() => startWire(first, { ...profile, endpoint: 'http://two.example/v1' }, policy), /original model endpoint/);
  const small = jobs('Question on first endpoint');
  startWire(small, profile, policy);
  completeWireStage(small, wireStage(session, small, policy, stage).input,
    { role: 'assistant', content: 'public answer', reasoning_content: 'hidden on first endpoint' }, policy);
  session.turns.push({ prompt: small.prompt, answer: 'public answer', wire: completedWire(small) });
  const second = jobs('New endpoint');
  startWire(second, { ...profile, endpoint: 'http://two.example/v1' }, policy);
  const result = wireStage(session, second, policy, stage);
  assert.equal(result.history.length, 0);
  assert.match(JSON.stringify(result.summarized), /public answer/);
  assert.doesNotMatch(JSON.stringify(result), /hidden on first/);
});

function providerEvents(res, parts) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(parts.map(part => 'data: ' + JSON.stringify(part) + '\n\n').join(''));
}

const nativeTool = {
  type: 'function', function: { name: 'fixture', description: 'Fixture tool', parameters: { type: 'object', properties: {} } },
};

test('OpenAI Responses replays encrypted reasoning and typed tool replies with storage disabled', async t => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-fixture', summary: [] };
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'fixture', arguments: '{}' };
  const api = await server(t, (body, res, request) => {
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.tools[0].name, 'fixture');
    if (request === 1) return providerEvents(res, [{ type: 'response.completed', response: { output: [reasoning, call] } }]);
    assert.deepEqual(body.input.slice(-3), [reasoning, call, { type: 'function_call_output', call_id: 'call_1', output: 'success' }]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] }));
  });
  const profile = { endpoint: api.url + '/v1/responses', model: 'gpt-6-astra', reasoningEffort: 'high' };
  const input = [{ role: 'user', content: 'Use the fixture.' }];
  const first = await complete(profile, 'fixture-secret', input, { tools: [nativeTool] });
  const second = await complete(profile, 'fixture-secret', [...input, first, { role: 'tool', tool_call_id: 'call_1', content: 'success' }], { tools: [nativeTool], stream: false });
  assert.equal(second.content, 'Done.');
  assert.ok(api.requests.every(request => request.url === '/v1/responses' && request.headers.authorization === 'Bearer fixture-secret'));
});

test('Claude Messages assembles and replays signed thinking and groups tool results', async t => {
  const thinking = { type: 'thinking', thinking: 'trace fixture', signature: 'signature-fixture' };
  const api = await server(t, (body, res, request) => {
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.ok(body.tools[0].input_schema);
    if (request === 1) {
      return providerEvents(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'trace fixture' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-fixture' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'fixture', id: 'toolu_1', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"passed":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'true}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]);
    }
    assert.deepEqual(body.messages[1].content[0], thinking);
    assert.deepEqual(body.messages[1].content[1].input, { passed: true });
    assert.deepEqual(body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'success' }] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }));
  });
  const profile = { endpoint: api.url + '/v1/messages', model: 'claude-sonnet', thinking: 'on', reasoningEffort: 'medium' };
  const input = [{ role: 'user', content: 'Use the fixture.' }];
  const first = await complete(profile, 'fixture-secret', input, { tools: [nativeTool] });
  const second = await complete(profile, 'fixture-secret', [...input, first, { role: 'tool', tool_call_id: 'toolu_1', content: 'success' }], { tools: [nativeTool], stream: false });
  assert.equal(second.content, 'Done.');
  assert.ok(api.requests.every(request => request.url === '/v1/messages' && request.headers['x-api-key'] === 'fixture-secret' &&
    request.headers['anthropic-version'] === '2023-06-01'));
});

test('Gemini native requests retain thought signatures and correlate tool responses', async t => {
  const part = { functionCall: { id: 'function-id', name: 'fixture', args: {} }, thoughtSignature: 'fixture-sig' };
  const api = await server(t, (body, res, request) => {
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
    assert.ok(body.tools[0].functionDeclarations[0].parametersJsonSchema);
    if (request === 1) return providerEvents(res, [{ candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] }]);
    assert.deepEqual(body.contents[1].parts, [part]);
    assert.deepEqual(body.contents[2].parts, [{ functionResponse: { name: 'fixture', id: 'function-id', response: { output: 'success' } } }]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] }));
  });
  const profile = { endpoint: api.url + '/v1beta', protocol: 'gemini', model: 'gemini-4-neon', reasoningEffort: 'medium' };
  const input = [{ role: 'user', content: 'Use the fixture.' }];
  const first = await complete(profile, 'fixture-secret', input, { tools: [nativeTool] });
  const second = await complete(profile, 'fixture-secret', [...input, first, { role: 'tool', tool_call_id: 'function-id', content: 'success' }], { tools: [nativeTool], stream: false });
  assert.equal(second.content, 'Done.');
  assert.equal(api.requests[0].url, '/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse');
  assert.equal(api.requests[1].url, '/v1beta/models/gemini-4-neon:generateContent');
  assert.ok(api.requests.every(request => request.headers['x-goog-api-key'] === 'fixture-secret'));
});

test('Qwen and Kimi presets keep base profiles compatible and opt into model-specific parameters', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) {
      assert.equal(body.temperature, undefined);
      assert.equal(body.chat_template_kwargs, undefined);
    } else if (request === 2) {
      assert.equal(body.temperature, 0.6);
      assert.equal(body.top_p, 0.95);
      assert.equal(body.top_k, 20);
      assert.equal(body.chat_template_kwargs.preserve_thinking, true);
    } else {
      assert.equal(body.temperature, 1);
      assert.equal(body.top_p, 1);
      assert.equal(body.reasoning_effort, 'max');
    }
    return reply(res, 'OK');
  });
  const { cli } = await profile(t, api);
  await cli('profile', 'set', 'work', '--model', 'Qwen/Qwen3.6-35B-A3B');
  assert.match((await cli('profile', 'show', 'work')).stdout, /qwen \(auto\)/);
  await cli('profile', 'test', 'work', '--only', 'chat');
  await cli('profile', 'tune', 'work', '--preset', 'coding');
  await cli('profile', 'test', 'work', '--only', 'chat');
  await cli('profile', 'set', 'work', '--model', 'moonshotai/Kimi-K3');
  assert.match((await cli('profile', 'show', 'work')).stdout, /kimi \(auto\)/);
  await cli('profile', 'test', 'work', '--only', 'chat');
});

test('profile eval measures search, checkpoint replay, local tests and citation in an isolated fixture', async t => {
  const api = await server(t, (body, res, request) => {
    request = (request - 1) % 4 + 1;
    if (request === 1) return tool(res, 'grep', '{"query":"invoiceLimit"}');
    if (request === 2) {
      assert.match(body.messages.at(-1).content, /invoice\.mjs/);
      return tool(res, 'read', '{"path":"invoice.mjs","start":3,"count":1}');
    }
    if (request === 3) return tool(res, 'run_check', '{"name":"unit"}');
    assert.equal(JSON.parse(body.messages.at(-1).content).exitCode, 0);
    return reply(res, 'Defined in invoice.mjs:3.');
  });
  const { cli } = await profile(t, api);
  const result = await cli('profile', 'eval', 'work');
  for (const phase of ['search', 'read', 'resume', 'check', 'citation']) assert.match(result.stdout, new RegExp(phase + ' · PASS'));
  const machine = JSON.parse((await cli('profile', 'eval', 'work', '--json')).stdout);
  assert.equal(machine[0].phases.resume, true);
  assert.equal(machine[0].metrics.toolCalls, 3);
  assert.match(result.stdout, /3 tool calls · checks \d+ms/);
  await cli('profile', 'set', 'different', '--endpoint', api.url, '--model', 'different');
  await assert.rejects(cli('profile', 'eval', 'work', '--against', 'different'), /same model and endpoint/);
});

test('a failed test prompts a reviewed repair and only then repeats the original registered check', async t => {
  const api = await server(t, (body, res, request) => {
    switch (request) {
      case 1: return tool(res, 'read', '{"path":"a.txt"}');
      case 2: return reply(res, 'Located a.txt.');
      case 3: return tool(res, 'edit', '{"path":"a.txt","oldText":"original","newText":"still-bad"}');
      case 4: return reply(res, 'Initial patch applied.');
      case 5: return tool(res, 'run_check', '{"name":"regression"}');
      case 6:
        assert.equal(JSON.parse(body.messages.at(-1).content).exitCode, 7);
        return reply(res, 'Regression failed.');
      case 7:
        assert.match(body.messages[0].content, /a\.txt:1/);
        return tool(res, 'read', '{"path":"a.txt"}');
      case 8:
        return tool(res, 'edit', '{"path":"a.txt","oldText":"still-bad","newText":"correct"}');
      case 9:
        assert.equal(JSON.parse(body.messages.at(-1).content).status, 'applied');
        return reply(res, 'Repair applied.');
      default:
        assert.match(body.messages[0].content, /Recorded rerun results/);
        assert.match(body.messages[0].content, /regression · passed · exit 0/);
        return reply(res, 'The original regression check passed.');
    }
  });
  const { work, cli, state } = await profile(t, api);
  await writeFile(join(work, 'a.txt'), 'original\n');
  const script = 'const fs=require("fs");fs.appendFileSync("calls.txt","run\\n");if(fs.readFileSync("a.txt","utf8").trim()!=="correct"){console.error("a.txt:1 needs repair");process.exit(7)}';
  await cli('check', 'add', 'regression', '--', 'node', '-e', script);
  await assert.rejects(cli('ask', 'Fix a.txt', '--harness', 'implement', '--write', '--checks'), error => error.code === 3);
  await cli('review', 'apply');
  await assert.rejects(cli('continue'), error => error.code === 3 && /Preparing repair 1/.test(error.stderr));
  assert.equal(await readFile(join(work, 'calls.txt'), 'utf8'), 'run\n');
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'still-bad\n');
  await cli('review', 'apply');
  const response = await cli('continue');
  assert.match(response.stdout, /original regression check passed/);
  assert.equal(await readFile(join(work, 'calls.txt'), 'utf8'), 'run\nrun\n');
  const sessions = join(state, 'sessions');
  const [file] = (await readdir(sessions)).filter(name => name.endsWith('.json'));
  const checks = JSON.parse(await readFile(join(sessions, file), 'utf8')).turns[0].checks;
  assert.deepEqual(checks.map(check => [check.status, Boolean(check.automatic)]), [['failed', false], ['passed', true]]);
});

test('one-shot JSON and event streams keep verification and completion machine readable', async t => {
  const api = await server(t, (_body, res) => reply(res, 'OK'));
  const { cli } = await profile(t, api);
  const output = JSON.parse((await cli('ask', 'Build report', '--json')).stdout);
  assert.equal(output.answer, 'OK');
  assert.equal(output.verification, 'not-run');
  assert.equal(output.status, 'complete');
  assert.match(output.sessionId, /^[0-9a-f-]{36}$/);
  const events = (await cli('ask', 'Build events', '--events')).stdout.trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.type === 'stage'));
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).verification, 'not-run');
});

test('failed verification is visible in sessions and scripts can read check JSON with its exit code', async t => {
  const api = await server(t, (body, res, request) => {
    if (request === 1) return tool(res, 'run_check', '{"name":"unit"}');
    assert.equal(JSON.parse(body.messages.at(-1).content).status, 'failed');
    return reply(res, 'The unit check failed.');
  });
  const { work, cli } = await profile(t, api);
  await writeFile(join(work, 'verify.json'), JSON.stringify({
    stages: [{ name: 'Verify', instruction: 'Run the unit check.', tools: ['run_check'] }],
  }));
  await cli('harness', 'import', 'verify', 'verify.json');
  const script = 'console.log("unit output"); console.error("unit error"); process.exit(7);';
  await cli('check', 'add', 'unit', '--', 'node', '-e', script);
  await assert.rejects(cli('check', 'run', 'unit', '--json'), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(error.code, 7);
    assert.equal(error.stderr, '');
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /unit output/);
    assert.match(result.stderr, /unit error/);
    return true;
  });
  await assert.rejects(cli('ask', 'Verify the project', '--harness', 'verify', '--checks'), error =>
    error.code === 4 && /The unit check failed/.test(error.stdout) && /Verification failed · unit/.test(error.stderr));
  assert.match((await cli('sessions')).stdout, /check failed · Verify the project/);
});

test('repair verification skips rejected fixes and changed commands', async () => {
  const { recheck, scheduleRepair } = await import('../src/repair.mjs');
  const stage = { name: 'Verify', repairAttempts: 2 };
  const job = { harness: { stages: [stage] }, checks: [
    { name: 'test', command: ['node', 'original.mjs'], timeout: 5, status: 'failed', exitCode: 1, stageIndex: 0, stderr: 'src/a.mjs:5:1' },
  ] };
  const session = { write: true, checks: true };
  assert.equal(scheduleRepair(job, 0, session).attempt, 1);
  assert.match((await recheck(job.plan[2], job, session, {}, {})).skipped, /No repair was approved/);
  job.approvals = [{ stageIndex: 1, files: ['src/a.mjs'] }];
  assert.match((await recheck(job.plan[2], job, session, { test: { argv: ['node', 'changed.mjs'], timeout: 5 } }, {})).skipped, /command.*changed/i);
});

test('malformed local configuration produces an actionable error and is left intact', async t => {
  const state = await temp(t);
  const path = join(state, 'settings.json');
  const env = { ...process.env, XCODE_HOME: state };
  for (const contents of ['[]', '{"profiles":[]}', '{"defaultProfile":7}']) {
    await writeFile(path, contents);
    await assert.rejects(exec(process.execPath, [cliPath, 'profile', 'list'], { env }),
      error => error.code === 1 && /settings\.json/.test(error.stderr));
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('stream accepts split CRLF and CR records without duplicating repeated function IDs', async t => {
  const api = await server(t, (_request, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const part = (args, finish) => JSON.stringify({ choices: [{ delta: {
      tool_calls: [{ index: 0, id: 'fixture-call', function: { name: 'fixture', arguments: args } }],
    }, finish_reason: finish }] });
    res.write('data: ' + part('{"a":') + '\r');
    res.end('\n\r\ndata: ' + part('1}', 'tool_calls') + '\r\r');
  });
  const profile = { endpoint: api.url, model: 'fixture' };
  const reply = await complete(profile, '', [{ role: 'user', content: 'Test' }]);
  assert.deepEqual(reply.tool_calls[0], { id: 'fixture-call', type: 'function', function: { name: 'fixture', arguments: '{"a":1}' } });
});

test('native response completes on the SSE event even when the connection remains open', async t => {
  const api = await server(t, (_request, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('event: response.completed\ndata: ' + JSON.stringify({ response: {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Finished.' }] }],
    } }) + '\n\n');
  });
  const result = await complete({ endpoint: api.url + '/v1/responses', model: 'fixture' }, '',
    [{ role: 'user', content: 'Test' }], { signal: AbortSignal.timeout(3000) });
  assert.equal(result.content, 'Finished.');
});

test('custom state inside a project is excluded from browsing, reads and explicit attachments', async t => {
  const root = await temp(t);
  const localState = join(root, 'runtime-state');
  await mkdir(join(localState, 'sessions'), { recursive: true });
  await writeFile(join(localState, 'tokens.json'), '{"fixture":"test-marker"}');
  await writeFile(join(localState, 'sessions', 'private.json'), '{"fixture":"test-marker"}');
  await writeFile(join(root, 'src.txt'), 'test-marker');
  const workspace = new URL('../src/workspace.mjs', import.meta.url).href;
  const attachments = new URL('../src/attachments.mjs', import.meta.url).href;
  const terminal = new URL('../src/terminal.mjs', import.meta.url).href;
  const script = [
    'import assert from "node:assert/strict";',
    'const { Workspace } = await import(' + JSON.stringify(workspace) + ');',
    'const { attach } = await import(' + JSON.stringify(attachments) + ');',
    'const { completeReference } = await import(' + JSON.stringify(terminal) + ');',
    'const root = process.cwd();',
    'const ws = new Workspace(root);',
    'assert.deepEqual((await ws.glob({})).paths, ["src.txt"]);',
    'assert.deepEqual((await ws.search({query:"test-marker"})).matches.map(item=>item.path), ["src.txt"]);',
    'await assert.rejects(ws.read({path:"runtime-state/tokens.json"}), /excluded/);',
    'await assert.rejects(attach(root,"runtime-state/tokens.json",{},undefined,{explicit:true}), /excluded/);',
    'assert.deepEqual(await completeReference(root,root,"@runtime-state/tok"), [[], "@runtime-state/tok"]);',
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root, env: { ...process.env, XCODE_HOME: localState },
  });
});

test('corrupt saved sessions do not block valid sessions or new work', async t => {
  const api = await server(t, (_body, res) => reply(res, 'Ready.'));
  const { state, cli } = await profile(t, api);
  await cli('ask', 'Earlier valid session');
  const corrupt = join(state, 'sessions', '00000000-0000-4000-8000-000000000000.json');
  await writeFile(corrupt, '{ malformed');
  const listed = await cli('sessions');
  assert.match(listed.stdout, /Earlier valid session/);
  assert.match(listed.stderr, /1 unreadable saved session/);
  assert.match((await cli('ask', 'Continue working')).stdout, /Ready/);
  assert.equal(await readFile(corrupt, 'utf8'), '{ malformed');
});

test('review separates distant changes and previews both sides of a selected move', async () => {
  const { reviewDiff } = await import('../src/changes.mjs');
  const before = Array.from({ length: 25 }, (_, i) => 'line ' + i).join('\n') + '\n';
  const after = before.replace('line 2\n', 'updated first\n').replace('line 22\n', 'updated last\n');
  const diff = reviewDiff({ files: [{ path: 'file.txt', before, after }] }).join('\n');
  assert.equal((diff.match(/^@@/gm) ?? []).length, 2);
  assert.doesNotMatch(diff, /[-+]line 10/);
  assert.match(diff, /\+updated last/);
  const move = reviewDiff({ files: [
    { path: 'old.txt', before: 'original\n', after: null, move: { to: 'new.txt' } },
    { path: 'new.txt', before: null, after: 'moved with edits\n', move: { from: 'old.txt' } },
  ] }, 'old.txt').join('\n');
  assert.match(move, /\+moved with edits/);
  assert.match(move, /-original/);
});

test('verification records bounded output and redacts the model token before retaining it', async t => {
  const { runCheck } = await import('../src/checks.mjs');
  const root = await temp(t);
  const secret = ['fixture', 'private', 'value'].join('-');
  const result = await runCheck(root, {
    unit: { argv: ['node', '-e', 'process.stdout.write("x".repeat(15000));process.stderr.write(process.argv[1]);', secret], timeout: 8 },
  }, 'unit', undefined, { secrets: [secret] });
  assert.equal(result.status, 'passed');
  assert.equal(result.stdout.length, 12000);
  assert.deepEqual(result.truncated, { stdout: true, stderr: false });
  assert.equal(result.stderr, '[redacted]');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('replay drops old blocks before current tool history and retains the same stage input', async () => {
  const { modelPolicy } = await import('../src/model-profile.mjs');
  const { completeWireStage, startWire, wireStage } = await import('../src/wire-history.mjs');
  const profile = { endpoint: 'http://model.example/v1', model: 'deepseek-flash', contextWindow: 4096 };
  const policy = modelPolicy(profile);
  const session = { turns: [] };
  const job = { prompt: 'Original requested change', completed: [], attachments: [] };
  startWire(job, profile, policy);
  const initial = wireStage(session, job, policy, { name: 'Inspect' });
  completeWireStage(job, initial.input, { role: 'assistant', content: 'Observed ' + 'a'.repeat(2400) }, policy);
  const stage = { name: 'Check' };
  const next = wireStage(session, job, policy, stage);
  assert.equal(next.history.length, 2);
  job.stageHistory = [{ role: 'tool', content: 'b'.repeat(3200) }];
  const resumed = wireStage(session, JSON.parse(JSON.stringify(job)), policy, stage);
  assert.equal(resumed.history.length, 0);
  assert.deepEqual(resumed.input, next.input);
  assert.equal(resumed.originalPrompt, job.prompt);
});

test('profile diagnostics emit a parseable report in JSON mode and preserve failure status', async t => {
  const api = await server(t, (_body, res) => reply(res, 'OK'));
  const { cli } = await profile(t, api);
  const chat = await cli('profile', 'test', 'work', '--only', 'chat', '--json');
  assert.equal(JSON.parse(chat.stdout).results[0].status, 'pass');
  await assert.rejects(cli('profile', 'test', 'work', '--only', 'sse', '--json'), error => {
    const report = JSON.parse(error.stdout);
    return error.code === 1 && report.profile === 'work' && report.results[0].status === 'fail' &&
      report.results[0].name === 'sse';
  });
});

test('listing many sessions retains only status summaries while reopening loads the original data', async t => {
  const api = await server(t, (_body, res) => reply(res, 'Retained prior content.'));
  const { work, state, cli } = await profile(t, api);
  await cli('ask', 'Session summary title');
  const module = new URL('../src/session.mjs', import.meta.url).href;
  const program = [
    'import assert from "node:assert/strict";',
    'const { Sessions } = await import(' + JSON.stringify(module) + ');',
    'const sessions = new Sessions(process.cwd());',
    'const [row] = await sessions.list();',
    'assert.equal(row.turns[0].status,"complete");',
    'assert.equal(row.turns[0].answer,undefined);',
    'try { assert.equal((await sessions.select(row.id,{})).session.turns[0].answer, "Retained prior content."); }',
    'finally { await sessions.close(); }',
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: work, env: { ...process.env, XCODE_HOME: state },
  });
});

test('custom harness imports, project skills and native PDF attachments retain their boundaries', async t => {
  const root = await temp(t);
  const state = await temp(t);
  const env = { ...process.env, XCODE_HOME: state };
  const cli = (...args) => exec(process.execPath, [cliPath, ...args], { cwd: root, env });
  await mkdir(join(root, '.xcode', 'skills', 'verify-doc'), { recursive: true });
  await writeFile(join(root, '.xcode', 'skills', 'verify-doc', 'SKILL.md'), '---\nname: verify-doc\ndescription: Check local documents\n---\nUse the document summary.');
  await writeFile(join(root, 'workflow.json'), JSON.stringify({
    description: 'Document workflow', skills: ['verify-doc'], stages: [{ name: 'Read', instruction: 'Read the selected document.', tools: ['skill_read', 'read'] }],
  }));
  assert.match((await cli('harness', 'import', 'docs', 'workflow.json')).stdout, /Skills: verify-doc/);
  assert.match((await cli('harness', 'show', 'docs')).stdout, /Document workflow/);
  const bytes = '%PDF-1.7\n% fixture\n';
  await writeFile(join(root, 'fixture.pdf'), bytes);
  const document = await attach(root, 'fixture.pdf', { pdfInput: true });
  assert.equal(document.parts[0].file.file_data, 'data:application/pdf;base64,' + Buffer.from(bytes).toString('base64'));
  const { skillsAt, skillRead } = await import('../src/harness.mjs');
  const skills = await skillsAt(root);
  assert.match((await skillRead(skills, 'verify-doc')).content, /Use the document summary/);
  await assert.rejects(skillRead(skills, 'verify-doc', '../other.md'), /inside the skill/);
});

test('session listing rebuilds a missing or invalid summary without changing the saved conversation', async t => {
  const api = await server(t, (_body, res) => reply(res, 'Keep this reply.'));
  const { cli, state } = await profile(t, api);
  await cli('ask', 'First title');
  const dir = join(state, 'sessions');
  const files = await readdir(dir);
  const summary = join(dir, files.find(name => name.endsWith('.summary')));
  const session = join(dir, files.find(name => name.endsWith('.json')));
  const original = JSON.parse(await readFile(session, 'utf8'));
  assert.doesNotMatch(await readFile(summary, 'utf8'), /Keep this reply/);
  await writeFile(summary, '{');
  assert.match((await cli('sessions')).stdout, /First title/);
  assert.equal(JSON.parse(await readFile(summary, 'utf8')).summary.title, 'First title');
  await writeFile(session, JSON.stringify({ ...original, title: 'Updated title' }));
  assert.match((await cli('sessions')).stdout, /Updated title/);
  assert.equal(JSON.parse(await readFile(session, 'utf8')).turns[0].answer, 'Keep this reply.');
});

test('workspace queries distinguish definitions and references and honor file filters', async t => {
  const root = await temp(t);
  const state = await temp(t);
  await writeFile(join(root, 'example.ts'), 'export function invoiceTotal() { return 4; }\nconsole.log(invoiceTotal());\n');
  await writeFile(join(root, 'sample.txt'), 'invoiceTotal should not be here');
  const args = { cwd: root, env: { ...process.env, XCODE_HOME: state } };
  try { await exec('rg', ['--version']); } catch { return t.skip('ripgrep is not installed'); }
  const symbol = JSON.parse((await exec(process.execPath, [cliPath, 'symbol', 'invoiceTotal', '--json'], args)).stdout);
  assert.deepEqual(symbol.definitions.map(item => item.line), [1]);
  assert.deepEqual(symbol.references.map(item => item.line), [2]);
  const result = JSON.parse((await exec(process.execPath, [cliPath, 'search', 'invoiceT.*', '--regex', '--type', 'ts', '--json'], args)).stdout);
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every(item => item.path === 'example.ts'));
});

test('search resumes at the next line and attachments load only selected text ranges', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'notes.txt'), Array.from({ length: 70000 }, (_, index) => 'needle ' + (index + 1)).join('\n'));
  const workspace = new Workspace(root);
  const first = await workspace.search({ query: 'needle' });
  assert.equal(first.scanned, 1);
  assert.equal(first.matches.length, 60);
  assert.deepEqual(first.next, { offset: 0, start: 61 });
  assert.equal((await workspace.search({ query: 'needle', ...first.next })).matches[0].line, 61);
  const file = await attach(root, 'notes.txt#L2-L3', {});
  assert.match(file.parts[0].text, /needle 2\nneedle 3\n/);
  assert.doesNotMatch(file.parts[0].text, /needle 4/);
});

test('workspace pages glob results and reads from the requested line or EOF', async t => {
  const root = await temp(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), 'first\nsecond');
  const project = new Workspace(root);
  assert.deepEqual(await project.glob({ count: 2 }), { paths: ['a.txt', 'b.txt'], truncated: true, nextOffset: 2 });
  assert.deepEqual(await project.glob({ offset: 2 }), { paths: ['c.txt'], truncated: false });
  assert.equal((await project.read({ path: 'a.txt', count: 1 })).nextStart, 2);
  assert.equal((await project.read({ path: 'a.txt', start: 3 })).lines, '');
});

test('literal inline @ references coexist with files and explicit missing attachments fail', async t => {
  const api = await server(t, (body, res) => {
    const parts = body.messages.at(-1).content;
    assert.match(parts[0].text, /@scope\/module/);
    assert.match(parts[1].text, /Actual attached content/);
    assert.equal(parts.length, 2);
    reply(res, 'Attached.');
  });
  const { cli, work } = await profile(t, api);
  await writeFile(join(work, 'source.txt'), 'Actual attached content');
  await cli('ask', 'Check @scope/module using @source.txt');
  await assert.rejects(cli('ask', 'Check the file', '--attach', 'missing.txt'), /ENOENT/);
});

test('slow model profiles can tune the request deadline without changing their endpoint', async t => {
  const api = await server(t, (_body, res) => reply(res, 'Ready.'));
  const { cli } = await profile(t, api);
  assert.match((await cli('profile', 'tune', 'work', '--request-timeout', '240')).stdout, /Request timeout · 240s/);
  await assert.rejects(cli('profile', 'tune', 'work', '--request-timeout', '2'), /Request timeout seconds/);
  assert.match((await cli('profile', 'show', 'work')).stdout, /Request timeout · 240s/);
  assert.match((await cli('profile', 'tune', 'work', '--request-timeout', 'default')).stdout, /Request timeout · 180s/);
});

test('a broken one-shot model stream leaves stdout free of partial answers', async t => {
  const api = await server(t, (_body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n');
  });
  const { cli } = await profile(t, api);
  await assert.rejects(cli('ask', 'Explain the fixture'), error =>
    error.code === 1 && error.stdout === '' && /stream ended early/.test(error.stderr));
});

test('model and check concurrency are limited independently and queued work can be cancelled', async () => {
  const { modelLimit, checkLimit, executionLimits, setLimits } = await import('../src/limits.mjs');
  setLimits(executionLimits({}, { 'model-jobs': '1', 'check-jobs': '2' }));
  try {
    let release;
    const first = modelLimit.run(undefined, () => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = modelLimit.run(controller.signal, () => assert.fail('cancelled work ran'));
    assert.equal(await checkLimit.run(undefined, async () => 'available'), 'available');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    release('done');
    assert.equal(await first, 'done');
    assert.equal(await modelLimit.run(undefined, async () => 'next'), 'next');
  } finally {
    setLimits();
  }
});

test('stream first-event and idle limits are independent', async () => {
  const { readEvents } = await import('../src/model-transport.mjs');
  const empty = new ReadableStream();
  await assert.rejects(readEvents(empty, undefined, { firstEventTimeout: 0.03 }).next(), /first event/);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: {"ready":true}\n\n')); } });
  const events = readEvents(stream, undefined, { firstEventTimeout: 0.03, idleTimeout: 0.03 });
  assert.deepEqual((await events.next()).value, { ready: true });
  await assert.rejects(events.next(), /idle/);
});

test('domain harness stages can be composed, customized and exported', async t => {
  const root = await temp(t);
  const state = await temp(t);
  const env = { ...process.env, XCODE_HOME: state };
  const cli = (...args) => exec(process.execPath, [cliPath, ...args], { cwd: root, env });
  const recipe = { role: 'data', stages: [
    { use: 'data-pipeline-review:Lineage', set: { name: 'Count sources', tools: ['read'] } },
    { use: 'design-review:3', set: { done: 'Write the data migration decision.' } },
  ] };
  await writeFile(join(root, 'recipe.json'), JSON.stringify(recipe));
  await cli('harness', 'compose', 'migration', 'recipe.json');
  const exported = JSON.parse((await cli('harness', 'export', 'migration')).stdout);
  assert.equal(exported.role, 'data');
  assert.deepEqual(exported.stages.map(stage => stage.name), ['Count sources', 'Decision']);
  assert.deepEqual(exported.stages[0].tools, ['read']);
  assert.match(exported.stages[1].done, /data migration/);
});

test('profile comparison and effective model-specific harnesses respect permissions', async t => {
  const api = await server(t, (_body, res) => reply(res, 'OK'));
  const { cli } = await profile(t, api);
  await cli('profile', 'set', 'alt', '--endpoint', api.url, '--model', 'different');
  await cli('profile', 'tune', 'alt', '--idle-timeout', '30');
  const compare = JSON.parse((await cli('profile', 'compare', 'work', '--against', 'alt', '--json')).stdout);
  assert.deepEqual(compare.changes.map(change => change.field), ['model', 'idleTimeout']);
  const baseline = JSON.parse((await cli('harness', 'effective', 'deepseek-flash-code', '--json')).stdout);
  const editor = JSON.parse((await cli('harness', 'effective', 'deepseek-flash-code', '--write', '--json')).stdout);
  assert.ok(!baseline.stages[1].tools.includes('propose_changes'));
  assert.ok(editor.stages[1].tools.includes('propose_changes'));
  const small = JSON.parse((await cli('harness', 'effective', 'small-model', '--json')).stdout);
  assert.ok(small.stages.every(stage => stage.tools.length <= 2));
});

test('model discovery, cached capabilities and streaming fallback use the configured endpoint', async t => {
  const api = await server(t, (body, res) => {
    if (!body) { res.end(JSON.stringify({ data: [{ id: 'fixture' }, { id: 'alternative' }] })); return; }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: invalid\n\n');
      return;
    }
    return reply(res, 'Regular reply');
  });
  const { cli } = await profile(t, api);
  const directory = JSON.parse((await cli('profile', 'models', 'work', '--json')).stdout);
  assert.equal(directory.verified, true);
  assert.deepEqual(directory.ids, ['fixture', 'alternative']);
  await cli('profile', 'test', 'work', '--only', 'chat');
  const { tests } = JSON.parse((await cli('profile', 'capabilities', 'work', '--json')).stdout);
  assert.equal(tests.chat.status, 'pass');
  await cli('profile', 'tune', 'work', '--stream-fallback', 'on');
  const recovered = await cli('ask', 'Recover stream');
  assert.match(recovered.stdout, /Regular reply/);
  assert.match(recovered.stderr, /regular JSON response/);
  const { networkSettings } = await import('../src/model-discovery.mjs');
  const network = await networkSettings({ HTTPS_PROXY: 'http://private-proxy.local', NODE_USE_ENV_PROXY: '1' });
  assert.equal(network.environmentProxy.https, true);
  assert.ok(!JSON.stringify(network).includes('private-proxy.local'));
});

test('connection diagnostics separate HTTP authentication and malformed model streams', async t => {
  const api = await server(t, (_body, res, request) => {
    if (request === 1) {
      res.writeHead(401).end('private provider message');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: malformed\n\n');
  });
  const { diagnose } = await import('../src/diagnostic.mjs');
  const model = { endpoint: api.url, model: 'fixture' };
  const [auth] = await diagnose(model, 'fixture-token', { only: 'chat' });
  assert.equal(auth.phase, 'auth');
  assert.equal(auth.httpStatus, 401);
  assert.doesNotMatch(auth.detail, /private provider message/);
  const [stream] = await diagnose(model, 'fixture-token', { only: 'sse' });
  assert.equal(stream.phase, 'stream');
  assert.equal(stream.status, 'fail');
  assert.match(stream.detail, /Response stream/);
});

test('diagnostic reports omit credentials, locations, and session contents and only probe on request', async t => {
  const api = await server(t, (_body, res) => res.writeHead(401).end('upstream-secret-marker'));
  const { work, state, cli } = await profile(t, api);
  await assert.rejects(cli('ask', 'private draft marker'));
  const sessionDir = join(state, 'sessions');
  const [file] = (await readdir(sessionDir)).filter(name => name.endsWith('.json'));
  const before = await readFile(join(sessionDir, file), 'utf8');

  const about = await cli('report');
  const result = JSON.parse(about.stdout);
  assert.equal(api.requests.length, 1);
  assert.equal(result.model.transport, 'http');
  assert.equal(result.session.state, 'failed');
  assert.deepEqual(result.session.failure, { phase: 'auth', httpStatus: 401 });
  assert.equal(result.probe, undefined);
  const probed = await cli('report', 'latest', '--probe', '--only', 'chat');
  assert.equal(api.requests.length, 2);
  assert.deepEqual(JSON.parse(probed.stdout).probe.tests, [
    { name: 'chat', status: 'fail', failure: { phase: 'auth', httpStatus: 401 } },
  ]);
  for (const output of [about.stdout, probed.stdout]) {
    for (const value of [api.url, '127.0.0.1', work, state, file, 'fixture-token', 'private draft marker', 'upstream-secret-marker'])
      assert.ok(!output.includes(value));
  }
  assert.equal(await readFile(join(sessionDir, file), 'utf8'), before);
});

test('chat completion and compose options respect the current editor mode', async () => {
  const { completeCommand, configureEditor, editorKeys, previewDraft } = await import('../src/chat-input.mjs');
  const help = '/settings         View settings\n/sessions         Browse sessions\n/paste            Compose';
  assert.deepEqual(completeCommand('/set', help, false), [['/settings '], '/set']);
  assert.match(completeCommand('/s', help, false)[0].join(' '), /Browse sessions/);
  assert.deepEqual(completeCommand('/set', help, true), [[], '/set']);
  assert.deepEqual(completeCommand('/pre', help, true), [['/preview '], '/pre']);
  assert.equal(completeCommand('use /set', help, false), null);
  const config = configureEditor({ color: 'on' }, { 'send-key': 'ctrl+x', 'newline-key': 'ctrl+o' });
  assert.deepEqual(editorKeys(config), { send: 'ctrl+x', newline: 'ctrl+o' });
  assert.equal(config.color, 'on');
  assert.throws(() => configureEditor(config, { 'send-key': 'ctrl+c' }), /Send key/);
  assert.match(previewDraft(Array(14).fill('example'), 40, line => line), /2 more lines/);
});

test('terminal recalls distinct matches and copies a selected fenced response block', async () => {
  const { recallEntries, terminalStyle } = await import('../src/chat-input.mjs');
  const { clipboardCommands, responseSelection } = await import('../src/clipboard.mjs');
  assert.deepEqual(recallEntries([{ prompt: 'Fix timeout' }, { prompt: 'Fix timeout' }], ['/profile', '/settings'], 'time'), ['Fix timeout']);
  assert.equal(terminalStyle({ theme: 'dark' }, { NO_COLOR: '' }).color, false);
  assert.equal(terminalStyle({ theme: 'light', accessible: true }, {}).plain, true);
  assert.deepEqual(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' }), [['wl-copy']]);
  const answer = 'a\n~~~sh\nprintf hello\n~~~\nb\n~~~text\nsecond\n~~~';
  assert.equal(responseSelection(answer), answer);
  assert.equal(responseSelection(answer, '2'), 'second');
  assert.throws(() => responseSelection(answer, '3'), /from 1 to 2/);
});

test('terminal views clip Korean and emoji on display columns without breaking graphemes', async () => {
  const { terminalClip, terminalWidth } = await import('../src/terminal.mjs');
  assert.equal(terminalWidth('가🙂e\u0301'), 5);
  assert.equal(terminalClip('가🙂e\u0301', 3), '가…');
  assert.equal(terminalClip('가🙂e\u0301', 4, 2), '…🙂e\u0301');
  assert.equal(terminalWidth('a\t가'), 6);
});

test('session listing and the recent page avoid loading a large archived transcript', async t => {
  const root = await temp(t);
  const state = await temp(t);
  const module = new URL('../src/store.mjs', import.meta.url).href;
  const program = [
    'import assert from "node:assert/strict";',
    'import { mkdir, readFile, rm } from "node:fs/promises";',
    'import { join } from "node:path";',
    'const store = await import(' + JSON.stringify(module) + ');',
    'await mkdir(store.sessionsDir);',
    'const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";',
    'const chunk = "x".repeat(128 * 1024);',
    'const turns = Array.from({ length: 140 }, (_, index) => ({ answer: chunk + index, prompt: String(index), status: "complete" }));',
    'await store.writeSession({ id, root: process.cwd(), title: "Large", updated: "2026-01-01", turns, queue: [] });',
    'const main = JSON.parse(await readFile(store.sessionPath(id), "utf8"));',
    'await rm(join(store.sessionsDir, id + ".records"), { recursive: true });',
    'assert.equal((await store.listSessions(process.cwd())).length, 1);',
    'assert.equal((await store.readSessionPage(id, undefined, 1)).entries[0].number, 140);',
    'assert.equal(main.turns.length, 12);',
    'assert.equal(main.olderTurns.length, 128);',
  ].join('\n');
  await exec(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', program], { cwd: root, env: { ...process.env, XCODE_HOME: state } });
});

test('long session history reads a bounded page without hydrating archived turns or model state', async t => {
  const root = await temp(t);
  const state = await temp(t);
  const file = new URL('../src/store.mjs', import.meta.url).href;
  const script = [
    'import assert from "node:assert/strict";',
    'import { mkdir, readFile, rm } from "node:fs/promises";',
    'import { join } from "node:path";',
    'const m = await import(' + JSON.stringify(file) + ');',
    'await mkdir(m.sessionsDir, { recursive: true });',
    'const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";',
    'const turns = Array.from({ length: 15 }, (_, i) => ({ status: "complete", prompt: String(i), answer: "Answer " + i }));',
    'turns[14].wire = { messages: [{ private: "model-only state" }] };',
    'await m.writeSession({ id, root: process.cwd(), title: "Long", updated: "2026-01-01", turns, queue: [] });',
    'const record = JSON.parse(await readFile(m.sessionPath(id), "utf8"));',
    'assert.equal(record.turns.length, 12);',
    'assert.equal(record.olderTurns.length, 3);',
    'assert.equal(record.turns.at(-1).wire, undefined);',
    'assert.deepEqual((await m.readSession(id)).turns, turns);',
    'await rm(join(m.sessionsDir, id + ".records", record.olderTurns[0] + ".json"));',
    'assert.equal((await m.readSessionPage(id, undefined, 1)).entries[0].turn.answer, "Answer 14");',
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...process.env, XCODE_HOME: state } });
});

test('session history pages by turn and forks or exports a saved conversation', async t => {
  const api = await server(t, (_body, res, n) => reply(res, 'Reply ' + n));
  const { cli } = await profile(t, api);
  await cli('ask', 'Initial question');
  const id = (await cli('session', 'fork', 'latest', '1')).stdout.trim();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.match((await cli('session', 'history', id)).stdout, /#1 · complete/);
  assert.match((await cli('session', 'export', id)).stdout, /## Turn 1[\s\S]*Initial question[\s\S]*Reply 1/);
  const { historyPage } = await import('../src/session-history.mjs');
  assert.deepEqual(historyPage(['one', 'two', 'three'], '3', '1'), { entries: [{ turn: 'two', number: 2 }], nextBefore: 2 });
  assert.throws(() => historyPage([], '3'), /turn number/);
});

test('session metadata persists and archived sessions filter separately', async t => {
  const api = await server(t, (_body, res) => reply(res, 'OK'));
  const { cli } = await profile(t, api);
  await cli('ask', 'Keep visible');
  await cli('session', 'rename', 'latest', 'Renamed session');
  await cli('session', 'pin', 'latest');
  await cli('ask', 'Archive this item');
  const listing = (await cli('sessions')).stdout;
  assert.match(listing.split('\n')[0], /pinned · Renamed/);
  const id = listing.split('\n').find(line => line.includes('Archive this item')).trim().slice(0, 8);
  await cli('session', 'archive', id);
  assert.doesNotMatch((await cli('sessions')).stdout, /Archive this item/);
  assert.match((await cli('sessions', '--status', 'archived')).stdout, /archived · Archive this item/);
  await cli('session', 'restore', id);
  assert.match((await cli('sessions')).stdout, /Archive this item/);
});

test('waiting messages can be edited, dropped, moved and selected for immediate send', async () => {
  const { Sessions } = await import('../src/session.mjs');
  const sessions = new Sessions('.');
  sessions.persist = async () => {};
  const active = { controller: new AbortController() };
  const running = { prompt: 'Current', harness: {} };
  const queue = [running, { prompt: 'Second' }, { prompt: 'Third' }, { prompt: 'Fourth' }];
  const live = { active, session: { queue } };
  await sessions.updateQueue(live, 'edit', '3', 'Revised');
  await sessions.updateQueue(live, 'drop', '2', '');
  await sessions.updateQueue(live, 'move', '3', '2');
  assert.deepEqual(queue.map(job => job.prompt), ['Current', 'Fourth', 'Revised']);
  await assert.rejects(sessions.updateQueue(live, 'edit', '1', 'No'), /has started/);
  await sessions.updateQueue(live, 'send', '3', '');
  assert.deepEqual(queue.map(job => job.prompt), ['Current', 'Revised', 'Fourth']);
  assert.equal(active.controller.signal.aborted, true);
  assert.equal(active.advance, true);
});

test('session listing can be filtered by title without opening the session', async t => {
  const api = await server(t, (_body, res) => reply(res, 'Ready.'));
  const { cli } = await profile(t, api);
  await cli('ask', 'Find the build changelog');
  await cli('ask', 'Read another note');
  const listed = await cli('sessions', 'build changelog');
  assert.match(listed.stdout, /Find the build changelog/);
  assert.doesNotMatch(listed.stdout, /Read another note/);
  assert.match((await cli('sessions', 'missing title')).stdout, /No sessions match/);
});

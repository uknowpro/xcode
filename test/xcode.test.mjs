import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
      const body = JSON.parse(text);
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
  await cli('review', 'apply');
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(join(work, 'new', 'path', 'b.txt'), 'utf8'), 'created\n');
  const result = await cli('continue');
  assert.match(result.stdout, /Updated a\.txt/);
  assert.match(result.stderr, /validate · passed · exit 0/);
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
    cwd: root, env: { ...process.env, XCODE_HOME: state }, timeout: 12000,
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
    'import { setTimeout as wait } from "node:timers/promises";',
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
    cwd: work, env: { ...process.env, XCODE_HOME: state }, timeout: 10000,
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

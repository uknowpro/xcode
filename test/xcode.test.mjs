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
import { Workspace } from '../src/workspace.mjs';

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
  await ws.edit({ path: 'src/a.js', oldText: 'const retryOption = 3;\nend', newText: 'const retryOption = 4;\nend' });
  assert.equal(await readFile(join(root, 'src', 'a.js'), 'utf8'), '\uFEFFstart\r\nconst retryOption = 4;\r\nend\r\n');
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

test('stages use separate tools and apply a bounded opt-in edit', async t => {
  const api = await server(t, (body, res, request) => {
    if (request <= 2) assert.ok(body.tools.every(tool => tool.function.name !== 'edit'));
    if (request === 1) return tool(res, 'read', '{"path":"a.txt"}');
    if (request === 2) return reply(res, 'Change a.txt.');
    if (request === 3) {
      assert.ok(body.tools.some(tool => tool.function.name === 'edit'));
      return tool(res, 'edit', '{"path":"a.txt","oldText":"before","newText":"after"}');
    }
    if (request === 4) return reply(res, 'Edited a.txt.');
    assert.ok(body.tools.some(tool => tool.function.name === 'verify_edits'));
    assert.ok(body.tools.every(tool => tool.function.name !== 'edit'));
    return reply(res, 'Updated a.txt.');
  });
  const { work, cli } = await profile(t, api);
  await writeFile(join(work, 'a.txt'), 'before\n');
  const result = await cli('ask', 'Rename test contents', '--harness', 'implement', '--write');
  assert.match(result.stdout, /Updated a\.txt/);
  assert.equal(await readFile(join(work, 'a.txt'), 'utf8'), 'after\n');
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

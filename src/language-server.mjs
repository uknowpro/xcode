import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative } from 'node:path';
import { readText, verifiedFile, within } from './workspace.mjs';

export async function languageLocations(root, argv, file, language, row, column) {
  const source = await verifiedFile(root, file);
  const uri = pathToFileURL(source.path).href;
  const rootUri = pathToFileURL(root).href;
  const env = { ...process.env };
  delete env.XCODE_API_TOKEN;
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    signal: AbortSignal.timeout(12000) });
  let pending, sequence = 0, failed;
  let buffer = Buffer.alloc(0);
  const fail = () => {
    failed = new Error('Language server stopped or returned an invalid response.');
    pending?.reject(failed);
    pending = undefined;
  };
  const send = data => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...data }));
    child.stdin.write('Content-Length: ' + bytes.length + '\r\n\r\n');
    child.stdin.write(bytes);
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 2 * 1024 * 1024) return fail();
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
      if (!Number.isSafeInteger(length) || length < 2 || length > 1048576) return fail();
      if (buffer.length < end + 4 + length) return;
      let data;
      try { data = JSON.parse(buffer.subarray(end + 4, end + 4 + length)); } catch { return fail(); }
      buffer = buffer.subarray(end + 4 + length);
      if (data.method && data.id !== undefined) send({ id: data.id, error: { code: -32601, message: 'Unsupported client request' } });
      else if (pending && data.id === pending.id) {
        const item = pending;
        pending = undefined;
        if (data.error) item.reject(new Error('Language server rejected ' + item.method));
        else item.resolve(data.result);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    pending = { id: ++sequence, method, resolve, reject };
    send({ id: sequence, method, params });
  });
  const locations = value => (Array.isArray(value) ? value : value ? [value] : []).flatMap(location => {
    try {
      const path = fileURLToPath(location.uri ?? location.targetUri);
      const pos = (location.range ?? location.targetSelectionRange)?.start;
      return within(root, path) && Number.isInteger(pos?.line) && Number.isInteger(pos?.character)
        ? [{ path: relative(root, path), line: pos.line + 1, column: pos.character + 1 }] : [];
    } catch { return []; }
  }).slice(0, 100);
  try {
    await request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: { general: { positionEncodings: ['utf-16'] } } });
    send({ method: 'initialized', params: {} });
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: language, version: 1,
      text: await readText(root, source.path) } } });
    const params = { textDocument: { uri }, position: { line: row - 1, character: column - 1 } };
    const definitions = locations(await request('textDocument/definition', params));
    const references = locations(await request('textDocument/references', { ...params, context: { includeDeclaration: false } }));
    await request('shutdown', null).catch(() => {});
    send({ method: 'exit' });
    return { definitions, references };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function mcpCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 32 ||
      argv.some(arg => typeof arg !== 'string' || !arg || arg.length > 1000 || arg.includes('\0')))
    throw new Error('Register one local executable and up to 31 arguments.');
  return argv;
}

export async function withMcp(root, argv, work) {
  const [command, ...args] = mcpCommand(argv);
  const env = { ...process.env };
  delete env.XCODE_API_TOKEN;
  const signal = AbortSignal.timeout(15000);
  const child = spawn(command, args, { cwd: root, env, shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'], signal });
  const decoder = new StringDecoder('utf8');
  let buffer = '', id = 0;
  let active, failure;
  const fail = error => {
    failure = error;
    active?.reject(error);
    active = null;
  };
  child.stdin.on('error', () => fail(new Error('The local MCP server closed its input.')));
  child.on('error', () => fail(new Error('Could not start or communicate with the local MCP server.')));
  child.on('exit', () => fail(new Error('The local MCP server exited.')));
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    active = { id: ++id, resolve, reject };
    send({ id, method, params });
  });
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > 512 * 1024) { fail(new Error('Local MCP output exceeds the response limit.')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { fail(new Error('Invalid JSON-RPC frame from the local MCP server.')); return; }
      if (message?.method && message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'Method not supported by xcode' } });
      } else if (active && message?.id === active.id) {
        const completion = active;
        active = null;
        if (message.error) completion.reject(new Error('The MCP server rejected the request.'));
        else completion.resolve(message.result);
      }
    }
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'xcode', version: '1' } });
    if (!['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized?.protocolVersion))
      throw new Error('Unsupported local MCP protocol version.');
    send({ method: 'notifications/initialized' });
    return await work(request, initialized);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

export async function mcpTools(request) {
  const items = [];
  let cursor;
  for (let page = 0; page < 4; page++) {
    const result = await request('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(result?.tools)) throw new Error('The server did not return a tool list.');
    for (const tool of result.tools) {
      if (typeof tool?.name !== 'string' || tool.name.length > 180) continue;
      items.push({ name: tool.name, description: String(tool.description ?? '').slice(0, 600),
        inputSchema: tool.inputSchema, annotations: tool.annotations });
      if (items.length >= 150) return { tools: items, truncated: true };
    }
    cursor = result.nextCursor;
    if (typeof cursor !== 'string' || !cursor) break;
  }
  return { tools: items, truncated: Boolean(cursor) };
}

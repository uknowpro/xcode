import { createHash } from 'node:crypto';
import { mcpTools, withMcp } from './local-mcp.mjs';
import { validateContract } from './json-contract.mjs';
import { redactSecrets } from './checks.mjs';

export class McpApproval extends Error {}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function serverCommand(config, root, server) {
  const registry = config.localMcp?.[root] ?? {};
  if (!Object.hasOwn(registry, server)) throw new Error('Register the local MCP server first.');
  return registry[server];
}

export async function bindMcp(config, root, alias, server, tool, mode = 'approve') {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(alias) || !tool || !['read', 'approve'].includes(mode))
    throw new Error('Use an alias, server, tool and approve or read mode.');
  const command = serverCommand(config, root, server);
  return withMcp(root, command, async request => {
    const info = (await mcpTools(request)).tools.find(item => item.name === tool);
    if (!info) throw new Error('Tool is unavailable on the selected server.');
    if (mode === 'read' && info.annotations?.readOnlyHint !== true)
      throw new Error('Automatic execution requires the selected tool to advertise read-only access.');
    return { alias, server, tool, mode, schema: info.inputSchema ?? { type: 'object' },
      signature: digest([command, info.inputSchema, info.annotations]) };
  });
}

export function prepareMcpCall(bindings, args) {
  const binding = bindings.find(item => item.alias === args?.alias);
  if (!binding || !args.input || typeof args.input !== 'object' || Array.isArray(args.input))
    throw new Error('Choose a session MCP alias and JSON input object.');
  if (Buffer.byteLength(JSON.stringify(args.input)) > 12000) throw new Error('MCP arguments exceed 12 KiB.');
  validateContract(binding.schema, args.input);
  return { ...binding, input: args.input };
}

export async function performMcp(config, root, call, token) {
  const command = serverCommand(config, root, call.server);
  return withMcp(root, command, async request => {
    const info = (await mcpTools(request)).tools.find(item => item.name === call.tool);
    if (!info || digest([command, info.inputSchema, info.annotations]) !== call.signature)
      throw new Error('The MCP tool or command changed. Link it again to review the new scope.');
    validateContract(call.schema, call.input);
    const result = await request('tools/call', { name: call.tool, arguments: call.input });
    const text = redactSecrets(JSON.stringify(result ?? null), [token]);
    return text.length <= 12000 ? JSON.parse(text) : { excerpt: text.slice(0, 11500), truncated: true };
  });
}

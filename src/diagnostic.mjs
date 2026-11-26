import { complete } from './model.mjs';

const probe = {
  type: 'function',
  function: {
    name: 'xcode_probe',
    description: 'Use this harmless function to verify that tool calls reach the client.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export async function diagnose(profile, token, { timeout = 15000, only, onResult = () => {} } = {}) {
  const chat = [{ role: 'user', content: 'Reply with OK.' }];
  const tests = [
    ['chat', async signal => {
      await complete(profile, token, chat, { stream: false, signal });
      return 'Plain chat response received.';
    }],
    ['sse', async signal => {
      let format;
      await complete(profile, token, chat, { signal, onFormat: value => { format = value; } });
      if (format !== 'sse') throw new Error('The endpoint replied with JSON to a streaming request.');
      return 'SSE stream completed.';
    }],
    ['tools', async signal => {
      if (profile.tools === false) return null;
      const result = await complete(profile, token, [
        { role: 'user', content: 'Call xcode_probe once with empty arguments. Do not answer in plain text.' },
      ], { signal, tools: [probe] });
      const call = result.tool_calls?.find(call => call.function.name === probe.function.name);
      let args;
      try {
        args = call && JSON.parse(call.function.arguments);
      } catch {
        // A malformed argument is a distinct diagnostic result.
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
        throw new Error('The model did not return a valid xcode_probe function call.');
      return 'Function call and arguments received.';
    }],
  ];
  if (only && !tests.some(([name]) => name === only)) throw new Error('Use --only chat, sse or tools.');
  const results = [];
  for (const [name, test] of tests) {
    if (only && name !== only) continue;
    let result;
    try {
      const detail = await test(AbortSignal.timeout(timeout));
      result = detail ? { name, status: 'pass', detail } :
        { name, status: 'skip', detail: 'Tools are disabled in this profile.' };
    } catch (error) {
      result = { name, status: 'fail', detail: error.name === 'TimeoutError' ? 'Probe timed out.' : error.message };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}

import { complete } from './model.mjs';
import { modelPolicy } from './model-profile.mjs';
import { modelFailure } from './model-transport.mjs';

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
    ['image', async signal => {
      if (profile.imageInput !== true) return null;
      const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2V8AAAAASUVORK5CYII=';
      await complete(profile, token, [{ role: 'user', content: [{ type: 'text', text: 'Reply OK for this test image.' },
        { type: 'image_url', image_url: { url: image } }] }], { stream: false, signal });
      return 'Image input accepted by this endpoint.';
    }],
    ['pdf', async signal => {
      if (profile.pdfInput !== true) return null;
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
      ];
      let pdf = '%PDF-1.4\n';
      const positions = [];
      for (const [index, object] of objects.entries()) {
        positions.push(pdf.length);
        pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
      }
      const xref = pdf.length;
      pdf += 'xref\n0 4\n0000000000 65535 f \n' +
        positions.map(pos => String(pos).padStart(10, '0') + ' 00000 n \n').join('') +
        'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
      const data = 'data:application/pdf;base64,' + Buffer.from(pdf).toString('base64');
      await complete(profile, token, [{ role: 'user', content: [{ type: 'text', text: 'Reply OK for this test PDF.' },
        { type: 'file', file: { filename: 'fixture.pdf', file_data: data } }] }], { stream: false, signal });
      return 'PDF input accepted by this endpoint.';
    }],
    ['tools', async signal => {
      if (profile.tools === false) return null;
      const input = [{ role: 'user', content: 'Call xcode_probe once with empty arguments. After its result, reply with OK.' }];
      const result = await complete(profile, token, input, { signal, tools: [probe] });
      const call = result.tool_calls?.find(call => call.function.name === probe.function.name);
      let args;
      try {
        args = call && JSON.parse(call.function.arguments);
      } catch {
        // A malformed argument is a distinct diagnostic result.
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
        throw new Error('The model did not return a valid xcode_probe function call.');
      const policy = modelPolicy(profile);
      if (!policy.replay) return 'Function call and arguments received.';
      if (result.tool_calls.length !== 1) throw new Error('The tool probe expected exactly one function call.');
      const hasReasoning = typeof result.reasoning_content === 'string' && result.reasoning_content.length > 0;
      if (policy.adapter === 'deepseek-flash' && policy.thinking === 'on' && !hasReasoning)
        throw new Error('Function call received without reasoning_content. Check thinking mode and the server reasoning parser, or use --thinking off.');
      const final = await complete(profile, token, [
        ...input, result, { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' },
      ], { signal, tools: [probe] });
      if (final.tool_calls?.length) throw new Error('The model issued another tool call after receiving the probe result.');
      if (hasReasoning) return 'Function call, reasoning replay, and follow-up passed.';
      if (policy.protocol !== 'chat-completions' || policy.adapter === 'gemini')
        return 'Function call and provider-specific continuation passed.';
      return 'Function call and follow-up passed. The server did not send reasoning content.';
    }],
  ];
  if (only && !tests.some(([name]) => name === only)) throw new Error('Use --only chat, sse, tools, image or pdf.');
  const results = [];
  for (const [name, test] of tests) {
    if (only ? name !== only : name === 'image' || name === 'pdf') continue;
    let result;
    try {
      const detail = await test(AbortSignal.timeout(timeout));
      result = detail ? { name, status: 'pass', detail } :
              { name, status: 'skip', detail: 'This capability is disabled in the profile.' };
    } catch (error) {
      result = { name, status: 'fail', ...modelFailure(error) };
    }
    results.push(result);
    onResult(result);
  }
  return results;
}

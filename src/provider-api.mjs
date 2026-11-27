import { randomUUID } from 'node:crypto';
import { failed, ModelError, readEvents, readJsonResponse } from './model-transport.mjs';

function formatError(message) {
  return new ModelError(message);
}

function attachmentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content ?? [];
}

function inlineData(part) {
  const url = part.type === 'image_url' ? part.image_url.url : part.file.file_data;
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw formatError('Expected an inline image or PDF attachment.');
  return { mimeType: match[1], data: match[2] };
}

function callReply(id, name, args) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } };
}

function responseInput(messages) {
  const input = [];
  for (const turn of messages) {
    if (turn.role === 'user') {
      input.push({ role: 'user', content: attachmentParts(turn.content).map(part => {
        if (part.type === 'text') return { type: 'input_text', text: part.text };
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, detail: 'auto' };
        return { type: 'input_file', ...part.file };
      }) });
    } else if (turn.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: turn.tool_call_id, output: turn.content });
    } else {
      const saved = turn.providerState;
      if (saved) input.push(...saved);
      else if (turn.content) input.push({ role: 'assistant', content: turn.content });
    }
  }
  return input;
}

function appendRole(messages, role, contents) {
  if (messages.at(-1)?.role === role) messages.at(-1).content.push(...contents);
  else messages.push({ role, content: [...contents] });
}

function anthropicInput(messages) {
  const input = [];
  for (const turn of messages) {
    if (turn.role === 'tool') {
      appendRole(input, 'user', [{ type: 'tool_result', tool_use_id: turn.tool_call_id, content: turn.content }]);
    } else if (turn.role === 'assistant') {
      appendRole(input, 'assistant', turn.providerState ?? [{ type: 'text', text: turn.content }]);
    } else {
      appendRole(input, 'user', attachmentParts(turn.content).map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        const data = inlineData(part);
        return {
          type: part.type === 'image_url' ? 'image' : 'document',
          source: { type: 'base64', media_type: data.mimeType, data: data.data },
        };
      }));
    }
  }
  return input;
}

function geminiInput(messages) {
  const input = [];
  const calls = new Map();
  const append = (role, parts) => {
    if (input.at(-1)?.role === role) input.at(-1).parts.push(...parts);
    else input.push({ role, parts: [...parts] });
  };
  const pending = new Map();
  for (const turn of messages) {
    if (turn.role === 'tool') {
      const result = calls.get(turn.tool_call_id);
      if (!result) throw formatError('Gemini tool result is missing its function call.');
      pending.set(turn.tool_call_id, { functionResponse: {
        name: result.name, response: { output: turn.content }, ...(result.id ? { id: result.id } : {}),
      } });
      continue;
    }
    if (pending.size) {
      // Gemini expects responses for a parallel batch in the original call order.
      append('user', [...calls.keys()].filter(id => pending.has(id)).map(id => pending.get(id)));
      pending.clear();
    }
    if (turn.role === 'assistant') {
      calls.clear();
      const parts = turn.providerState ?? [{ text: turn.content }];
      const providerCalls = parts.flatMap(part => part.functionCall ? [part.functionCall] : []);
      turn.tool_calls?.forEach((call, index) => calls.set(call.id, providerCalls[index]));
      append('model', parts);
    } else {
      append('user', attachmentParts(turn.content).map(part => part.type === 'text' ? { text: part.text } : { inlineData: inlineData(part) }));
    }
  }
  if (pending.size) append('user', [...calls.keys()].filter(id => pending.has(id)).map(id => pending.get(id)));
  return input;
}

export function nativeRequest(profile, policy, token, messages, tools, stream) {
  const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
  const conversation = messages.filter(item => item.role !== 'system');
  const functions = tools.map(tool => tool.function);
  const effort = policy.effort === 'default' ? undefined : policy.effort;
  if (policy.protocol === 'responses') return {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    payload: {
      model: profile.model, stream, store: false, include: ['reasoning.encrypted_content'],
      ...(system ? { instructions: system } : {}), input: responseInput(conversation),
      ...(functions.length ? { tools: functions.map(fn => ({ type: 'function', ...fn, strict: false })) } : {}),
      ...(policy.thinking === 'off' || effort ? { reasoning: { effort: policy.thinking === 'off' ? 'none' : effort } } : {}),
      ...(policy.maxTokens ? { max_output_tokens: policy.maxTokens } : {}),
    },
  };
  if (policy.protocol === 'anthropic') return {
    headers: { 'anthropic-version': '2023-06-01', ...(token ? { 'x-api-key': token } : {}) },
    payload: {
      model: profile.model, stream, max_tokens: policy.maxTokens ?? 8192,
      ...(system ? { system } : {}), messages: anthropicInput(conversation),
      ...(functions.length ? { tools: functions.map(fn => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })) } : {}),
      ...(policy.thinking === 'default' ? {} : { thinking: { type: policy.thinking === 'on' ? 'adaptive' : 'disabled' } }),
      ...(effort && policy.thinking !== 'off' ? { output_config: { effort } } : {}),
    },
  };
  if (policy.thinking === 'off' && !/^gemini-2\.5-flash/i.test(profile.model.replace(/^models\//, '')))
    throw formatError('This Gemini profile does not expose thinking off. Use server defaults or an effort level.');
  const level = effort === 'max' ? 'XHIGH' : effort?.toUpperCase();
  return {
    headers: token ? { 'x-goog-api-key': token } : {},
    payload: {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: geminiInput(conversation),
      ...(functions.length ? { tools: [{ functionDeclarations: functions.map(fn => ({
        name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters,
      })) }] } : {}),
      generationConfig: {
        ...(policy.maxTokens ? { maxOutputTokens: policy.maxTokens } : {}),
        ...(level || policy.thinking === 'off' ? { thinkingConfig: policy.thinking === 'off'
          ? { thinkingBudget: 0 } : { thinkingLevel: level } } : {}),
      },
    },
  };
}

async function responsesBody(events, onText) {
  let final;
  for await (const part of events) {
    if (!part) break;
    if (part.type === 'response.output_text.delta') onText(part.delta);
    if (part.type === 'response.completed') final = part.response;
    if (part.type === 'response.incomplete') throw formatError('The Responses API ended before completing the turn.');
    if (part.type === 'response.failed' || part.type === 'error') throw failed(0, JSON.stringify(part.response?.error ?? part));
  }
  if (!final) throw new ModelError('The Responses stream ended early.', { retryable: true });
  return final;
}

async function anthropicBody(events, onText) {
  const content = [];
  const input = new Map();
  let stop_reason;
  let stopped = false;
  for await (const part of events) {
    if (!part) break;
    const index = part.index;
    if (part.type === 'content_block_start') {
      content[index] = structuredClone(part.content_block);
      if (content[index].type === 'text' && content[index].text) onText(content[index].text);
    } else if (part.type === 'content_block_delta') {
      const block = content[index];
      const delta = part.delta;
      if (!block) throw formatError('The Claude stream returned a delta before its block.');
      if (delta.type === 'text_delta') {
        block.text = (block.text ?? '') + delta.text;
        onText(delta.text);
      } else if (delta.type === 'thinking_delta') {
        block.thinking = (block.thinking ?? '') + delta.thinking;
      } else if (delta.type === 'signature_delta') {
        block.signature = (block.signature ?? '') + delta.signature;
      } else if (delta.type === 'input_json_delta') {
        input.set(index, (input.get(index) ?? '') + delta.partial_json);
      }
    } else if (part.type === 'content_block_stop' && input.has(index)) {
      try { content[index].input = JSON.parse(input.get(index)); }
      catch { throw formatError('The Claude stream returned malformed tool arguments.'); }
    } else if (part.type === 'message_delta') stop_reason = part.delta?.stop_reason ?? stop_reason;
    else if (part.type === 'error') throw failed(0, JSON.stringify(part.error ?? part));
    else if (part.type === 'message_stop') stopped = true;
  }
  if (!stopped) throw new ModelError('The Claude stream ended early.', { retryable: true });
  return { content, stop_reason };
}

async function geminiBody(events, onText) {
  const parts = [];
  let finishReason;
  for await (const chunk of events) {
    if (!chunk) break;
    if (chunk.error) throw failed(chunk.error.code ?? 0, JSON.stringify(chunk.error));
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      parts.push(part);
      if (!part.thought && part.text) onText(part.text);
    }
  }
  if (!finishReason) throw new ModelError('The Gemini stream ended early.', { retryable: true });
  return { candidates: [{ content: { parts }, finishReason }] };
}

function modelReply(protocol, value) {
  if (value.error) throw failed(value.error.code ?? 0, JSON.stringify(value.error));
  let providerState;
  let content;
  let toolCalls;
  if (protocol === 'responses') {
    if (value.status === 'incomplete' || value.status === 'failed') throw formatError('The Responses API did not complete the turn.');
    providerState = value.output ?? [];
    content = providerState.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('');
    toolCalls = providerState.filter(item => item.type === 'function_call')
      .map(item => callReply(item.call_id, item.name, item.arguments));
  } else if (protocol === 'anthropic') {
    if (value.stop_reason === 'max_tokens') throw formatError('Claude reached its output limit.');
    providerState = value.content ?? [];
    content = providerState.filter(item => item.type === 'text').map(item => item.text).join('');
    toolCalls = providerState.filter(item => item.type === 'tool_use').map(item => callReply(item.id, item.name, item.input));
  } else {
    const candidate = value.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') throw formatError('Gemini reached its output limit.');
    providerState = candidate?.content?.parts ?? [];
    content = providerState.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
    toolCalls = providerState.filter(part => part.functionCall).map(part =>
      callReply(part.functionCall.id ?? 'gemini_' + randomUUID(), part.functionCall.name, part.functionCall.args));
  }
  if (toolCalls.some(call => !call.id || !call.function.name)) throw formatError('The model returned an incomplete tool call.');
  if (!content.trim() && !toolCalls.length) throw formatError('The model returned an empty reply.');
  return { role: 'assistant', content, providerState, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

export async function nativeResponse(protocol, response, { sse, signal, onText }) {
  const parse = { responses: responsesBody, anthropic: anthropicBody, gemini: geminiBody }[protocol];
  const body = sse ? await parse(readEvents(response.body, signal), onText) : await readJsonResponse(response, signal);
  const message = modelReply(protocol, body);
  if (!sse && message.content) onText(message.content);
  return message;
}

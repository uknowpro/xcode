import { modelEndpoint, modelPolicy, requestOptions } from './model-profile.mjs';
import { failed, fetchModel, ModelError, readEvents, readJsonResponse } from './model-transport.mjs';
import { nativeRequest, nativeResponse } from './provider-api.mjs';
import { modelLimit } from './limits.mjs';
import { usageFrame } from './model-usage.mjs';

export { ModelError } from './model-transport.mjs';

export function completionUrl(input) {
  return modelEndpoint({ endpoint: input }, { protocol: 'chat-completions' }).href;
}

function identityFragment(previous, next) {
  if (!next || next === previous) return previous;
  if (previous && next.startsWith(previous)) return next;
  return previous + next;
}

function applyChoice(result, part, onText) {
  if (part.error) {
    const error = part.error;
    throw failed(Number(error.status ?? error.code) || 0, JSON.stringify(error));
  }
  const choice = part.choices?.[0];
  const delta = choice?.delta ?? choice?.message;
  if (typeof delta?.content === 'string') {
    result.content += delta.content;
    onText(delta.content);
  }
  // Some reasoning-model servers expect these fields back on tool turns.
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof delta?.[key] === 'string') result[key] = (result[key] ?? '') + delta[key];
  }
  if (delta?.extra_content) result.extra_content = delta.extra_content;
  for (const call of delta?.tool_calls ?? []) {
    const index = call.index ?? result.tool_calls.size;
    if (!Number.isInteger(index) || index < 0 || index >= 64) throw new ModelError('Invalid model tool index.');
    const existing = result.tool_calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    existing.id = identityFragment(existing.id, call.id);
    existing.function.name = identityFragment(existing.function.name, call.function?.name);
    if (call.function?.arguments) existing.function.arguments += call.function.arguments;
    if (call.extra_content) existing.extra_content = call.extra_content;
    result.tool_calls.set(index, existing);
  }
  if (choice?.finish_reason) result.finished = choice.finish_reason;
}

export async function complete(profile, token, messages, options = {}) {
  return modelLimit.run(options.signal, () => completeRequest(profile, token, messages, options));
}

async function completeRequest(profile, token, messages, { tools = [], stream = true, signal, onText = () => {}, onFormat = () => {}, onMeta = () => {} } = {}) {
  const policy = modelPolicy(profile);
  const url = modelEndpoint(profile, policy, stream);
  const native = policy.protocol !== 'chat-completions';
  const request = native ? nativeRequest(profile, policy, token, messages, tools, stream) : {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    payload: { model: profile.model, messages, stream, ...(stream && profile.usageReporting === 'on' ? { stream_options: { include_usage: true } } : {}), ...(tools.length ? { tools } : {}), ...requestOptions(policy) },
  };
  const response = await fetchModel(url, request.headers, request.payload, signal, policy.headerTimeout);
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
  if (requestId && /^[A-Za-z0-9_.:-]{1,100}$/.test(requestId) && !(token && requestId.includes(token))) onMeta({ requestId });
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  onFormat(sse ? 'sse' : 'json');
  const onFrame = part => {
    const usage = usageFrame(part);
    if (Object.keys(usage).length) onMeta({ usage });
  };
  try {
    return native ? await nativeResponse(policy.protocol, response, { sse, signal, onText, timeouts: policy, onFrame }) :
      await chatResponse(response, { policy, sse, signal, onText, onFrame, trailingUsage: profile.usageReporting === 'on' });
  } catch (error) {
    if (error instanceof ModelError) error.phase ??= sse ? 'stream' : 'response';
    throw error;
  }
}

async function chatResponse(response, { policy, sse, signal, onText, onFrame, trailingUsage }) {
  const result = { role: 'assistant', content: '', tool_calls: new Map() };
  if (sse) {
    let completed = false;
    for await (const part of readEvents(response.body, signal, policy)) {
      if (!part) { completed = true; break; }
      onFrame(part);
      applyChoice(result, part, onText);
      if (result.finished && !trailingUsage) break;
    }
    if (!completed && !result.finished) throw new ModelError('The model stream ended early.', { retryable: true });
  } else {
    const part = await readJsonResponse(response, signal);
    onFrame(part);
    applyChoice(result, part, onText);
  }
  if (result.finished === 'length') throw new ModelError('The model reached its output limit.');
  if (result.finished === 'content_filter') throw new ModelError('The model declined to return this response.');
  const { finished, tool_calls: calls, ...message } = result;
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some(call => !call.id || !call.function.name) || (finished === 'tool_calls' && !toolCalls.length))
    throw new ModelError('The model returned an incomplete tool call.');
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (['deepseek-flash', 'qwen', 'kimi'].includes(policy.adapter)) {
    // Some compatible servers expose the same stream under the alias reasoning.
    if (!message.reasoning_content && typeof message.reasoning === 'string')
      message.reasoning_content = message.reasoning;
    delete message.reasoning;
  }
  if (!message.content.trim() && !toolCalls.length) throw new ModelError('The model returned an empty reply.');
  return message;
}

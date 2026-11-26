const maxResponse = 16 * 1024 * 1024;

export function completionUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS model URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Enter an HTTP or HTTPS model URL without credentials or a fragment.');
  const base = url.pathname.replace(/\/+$/, '') || '/v1';
  url.pathname = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  return url.href;
}

export class ModelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.retryable = Boolean(options.retryable);
    this.status = options.status;
  }
}

function failed(status, detail = '') {
  if (status === 429 || status === 402 || /quota|insufficient.{0,20}(?:credit|balance)|resource.exhausted|rate.limit|usage.{0,20}(?:limit|exceed)|billing/i.test(detail))
    return new ModelError('Model rate or usage limit reached' + (status ? ' (HTTP ' + status + ')' : '') + '.', { status });
  const explanation = {
    400: 'Check the model ID, request format, and supported inputs or tools.',
    401: 'Check the API token.',
    403: 'Check access to this model.',
    404: 'Check the Chat Completions URL and model ID.',
  }[status] ?? 'Check the endpoint and model server.';
  return new ModelError((status ? 'HTTP ' + status + '. ' : 'Model request failed. ') + explanation, {
    status,
    retryable: status === 408 || status >= 500,
  });
}

function networkError(error, signal) {
  if (signal?.aborted) throw signal.reason;
  const code = error.cause?.code ?? '';
  if (error.cause?.message === 'unexpected redirect')
    return new ModelError('The server redirected this request. Configure its final Chat Completions URL.');
  if (/CERT|TLS|SSL/.test(code))
    return new ModelError('The model endpoint certificate could not be verified (' + code + ').');
  return new ModelError('Model connection failed' + (/^[A-Z0-9_]+$/.test(code) ? ' (' + code + ')' : '') + '.', {
    retryable: true,
  });
}

async function responseText(response, limit, truncate = false) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      const remaining = limit - count;
      if (value.byteLength > remaining) {
        if (!truncate) throw new ModelError('Model response exceeds the size limit.');
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        return Buffer.concat(chunks).toString('utf8');
      }
      count += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
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
  for (const call of delta?.tool_calls ?? []) {
    const index = call.index ?? result.tool_calls.size;
    if (!Number.isInteger(index) || index < 0 || index >= 64) throw new ModelError('Invalid model tool index.');
    const existing = result.tool_calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (call.id) existing.id += call.id;
    if (call.function?.name) existing.function.name += call.function.name;
    if (call.function?.arguments) existing.function.arguments += call.function.arguments;
    result.tool_calls.set(index, existing);
  }
  if (choice?.finish_reason) result.finished = choice.finish_reason;
}

async function streamResponse(body, result, onText, signal) {
  const reader = body?.getReader();
  if (!reader) throw new ModelError('The model sent an empty stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(error => { throw networkError(error, signal); });
      received += value?.byteLength ?? 0;
      if (received > maxResponse) throw new ModelError('Model stream exceeds the size limit.');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      if (buffer.length > 1024 * 1024) throw new ModelError('Model stream event exceeds the size limit.');
      if (done && buffer.trim()) events.push(buffer);
      for (const event of events) {
        if (event.length > 1024 * 1024) throw new ModelError('Model stream event exceeds the size limit.');
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data.trim()) continue;
        if (data.trim() === '[DONE]') {
          completed = true;
          break;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new ModelError('Invalid data from the model stream.');
        }
        applyChoice(result, chunk, onText);
      }
      if (completed || done || result.finished) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!completed && !result.finished) throw new ModelError('The model stream ended early.', { retryable: true });
}

export async function complete(profile, token, messages, { tools = [], stream = true, signal, onText = () => {}, onFormat = () => {} } = {}) {
  const body = JSON.stringify({
    model: profile.model,
    messages,
    stream,
    ...(tools.length ? { tools } : {}),
  });
  if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new ModelError('Model request exceeds 24 MiB.');
  const response = await fetch(completionUrl(profile.endpoint), {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body,
  }).catch(error => { throw networkError(error, signal); });
  if (!response.ok) {
    const detail = await responseText(response, 4096, true).catch(() => '');
    throw failed(response.status, detail);
  }
  const result = { role: 'assistant', content: '', tool_calls: new Map() };
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    onFormat('sse');
    await streamResponse(response.body, result, onText, signal);
  } else {
    onFormat('json');
    let part;
    try {
      part = JSON.parse(await responseText(response, maxResponse));
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new ModelError('Expected an SSE or JSON Chat Completions response.');
    }
    applyChoice(result, part, onText);
  }
  if (result.finished === 'length') throw new ModelError('The model reached its output limit.');
  if (result.finished === 'content_filter') throw new ModelError('The model declined to return this response.');
  const { finished, tool_calls: calls, ...message } = result;
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some(call => !call.id || !call.function.name) || (finished === 'tool_calls' && !toolCalls.length))
    throw new ModelError('The model returned an incomplete tool call.');
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (!message.content.trim() && !toolCalls.length) throw new ModelError('The model returned an empty reply.');
  return message;
}

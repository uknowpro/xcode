const maxResponse = 16 * 1024 * 1024;

export class ModelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.retryable = Boolean(options.retryable);
    this.status = options.status;
  }
}

export function failed(status, detail = '') {
  if (status === 429 || status === 402 || /quota|insufficient.{0,20}(?:credit|balance)|resource.exhausted|rate.limit|usage.{0,20}(?:limit|exceed)|billing/i.test(detail))
    return new ModelError('Model rate or usage limit reached' + (status ? ' (HTTP ' + status + ')' : '') + '.', { status });
  const explanation = {
    400: /reasoning_content|(?:thinking|reasoning).{0,50}(?:unsupported|required|invalid|not supported)/i.test(detail)
      ? 'The server rejected reasoning settings or conversation state. Run the profile tool probe and check the serving backend.'
      : 'Check the model ID, request format, and supported inputs or tools.',
    401: 'Check the API token.',
    403: 'Check access to this model.',
    404: 'Check the API URL, protocol, and model ID.',
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
    return new ModelError('The server redirected this request. Configure its final API URL.');
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


export async function fetchModel(url, headers, payload, signal) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new ModelError('Model request exceeds 24 MiB.');
  const response = await fetch(url, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...headers },
    body,
  }).catch(error => { throw networkError(error, signal); });
  if (!response.ok) {
    const detail = await responseText(response, 4096, true).catch(() => '');
    signal?.throwIfAborted();
    throw failed(response.status, detail);
  }
  return response;
}

export async function readJsonResponse(response, signal) {
  let data;
  try {
    data = await responseText(response, maxResponse);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw networkError(error, signal);
  }
  try {
    const value = JSON.parse(data);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // A non-JSON proxy response also uses this diagnostic.
  }
  throw new ModelError('Expected a JSON or SSE model response.');
}

export async function* readEvents(body, signal) {
  const reader = body?.getReader();
  if (!reader) throw new ModelError('The model sent an empty stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(error => { throw networkError(error, signal); });
      received += value?.byteLength ?? 0;
      if (received > maxResponse) throw new ModelError('Model stream exceeds the size limit.');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const trailingCr = !done && buffer.endsWith('\r');
      const events = (trailingCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n').split('\n\n');
      buffer = events.pop() + (trailingCr ? '\r' : '');
      if (buffer.length > 1024 * 1024) throw new ModelError('Model stream event exceeds the size limit.');
      if (done && buffer.trim()) events.push(buffer);
      for (const event of events) {
        if (event.length > 1024 * 1024) throw new ModelError('Model stream event exceeds the size limit.');
        const lines = event.split('\n');
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data.trim()) continue;
        if (data.trim() === '[DONE]') { yield null; return; }
        let part;
        try { part = JSON.parse(data); }
        catch { throw new ModelError('Invalid data from the model stream.'); }
        if (!part || typeof part !== 'object' || Array.isArray(part)) throw new ModelError('Invalid model stream event.');
        const eventType = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        if (eventType && eventType !== 'message' && !part.type) part.type = eventType;
        yield part;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const maxResponse = 16 * 1024 * 1024;

export class ModelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.retryable = Boolean(options.retryable);
    this.status = options.status;
    this.phase = options.phase;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }
}

const failureLabels = {
  request: 'Request',
  dns: 'DNS',
  connect: 'Connection',
  tls: 'TLS',
  auth: 'Authentication',
  http: 'HTTP response',
  response: 'Model response',
  stream: 'Response stream',
};

export function modelFailure(error) {
  if (!(error instanceof ModelError)) return { detail: error.message };
  const label = failureLabels[error.phase];
  return {
    detail: label ? label + ' · ' + error.message : error.message,
    ...(label ? { phase: error.phase } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.status ? { httpStatus: error.status } : {}),
  };
}

export function failed(status, detail = '', phase) {
  if (status === 401 || status === 403) phase = 'auth';
  if (status === 429 || status === 402 || /quota|insufficient.{0,20}(?:credit|balance)|resource.exhausted|rate.limit|usage.{0,20}(?:limit|exceed)|billing/i.test(detail))
    return new ModelError('Model rate or usage limit reached' + (status ? ' (HTTP ' + status + ')' : '') + '.', { status, phase });
  const explanation = {
    400: /reasoning_content|(?:thinking|reasoning).{0,50}(?:unsupported|required|invalid|not supported)/i.test(detail)
      ? 'The server rejected reasoning settings or conversation state. Run the profile tool probe and check the serving backend.'
      : 'Check the model ID, request format, and supported inputs or tools.',
    401: 'Check the API token.',
    403: 'Check access to this model.',
    404: 'Check the API URL, protocol, and model ID.',
  }[status] ?? 'Check the endpoint and model server.';
  return new ModelError((status ? 'HTTP ' + status + '. ' : 'Model request failed. ') + explanation, {
    status, phase,
    retryable: status === 408 || status >= 500,
  });
}

function networkError(error, signal, phase = 'connect') {
  if (signal?.aborted) {
    if (signal.reason?.name !== 'TimeoutError') throw signal.reason;
    return new ModelError('The request timed out.', { phase, code: 'TIMEOUT', retryable: true });
  }
  const rawCode = error.cause?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : undefined;
  if (error.cause?.message === 'unexpected redirect')
    return new ModelError('The server redirected this request. Configure its final API URL.', { phase: 'http' });
  if (code && /CERT|TLS|SSL/.test(code))
    return new ModelError('The TLS connection could not be verified (' + code + ').', { phase: 'tls', code });
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL')
    return new ModelError('Could not resolve the model hostname (' + code + ').', { phase: 'dns', code, retryable: true });
  const message = phase === 'connect' ? 'Model connection failed' : 'Connection closed while receiving the model response';
  return new ModelError(message + (code ? ' (' + code + ')' : '') + '.', { phase, code, retryable: true });
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


export async function fetchModel(url, headers, payload, signal, headerTimeout) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new ModelError('Model request exceeds 24 MiB.', { phase: 'request' });
  const controller = headerTimeout ? new AbortController() : null;
  const attempt = controller && signal ? AbortSignal.any([signal, controller.signal]) : controller?.signal ?? signal;
  const clock = controller ? setTimeout(() => controller.abort(new DOMException('Connection deadline', 'TimeoutError')), headerTimeout * 1000) : undefined;
  const response = await fetch(url, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: attempt,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...headers },
    body,
  }).catch(error => { throw networkError(error, attempt); }).finally(() => clearTimeout(clock));
  if (!response.ok) {
    const detail = await responseText(response, 4096, true).catch(() => '');
    if (signal?.aborted) throw networkError(signal.reason, signal, 'http');
    const failure = failed(response.status, detail, 'http');
    const header = response.headers.get('retry-after');
    if (header) {
      const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
      if (Number.isFinite(seconds)) failure.retryAfter = Math.max(0, Math.min(3600, seconds));
    }
    throw failure;
  }
  return response;
}

export async function readJsonResponse(response, signal) {
  let data;
  try {
    data = await responseText(response, maxResponse);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw networkError(error, signal, 'response');
  }
  try {
    const value = JSON.parse(data);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // A non-JSON proxy response also uses this diagnostic.
  }
  throw new ModelError('Expected a JSON or SSE model response.');
}

export async function* readEvents(body, signal, timeouts = {}) {
  const reader = body?.getReader();
  if (!reader) throw new ModelError('The model sent an empty stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let eventSeen = false;
  let last = Date.now();
  let timer;
  try {
    for (;;) {
      const bound = eventSeen ? timeouts.idleTimeout : timeouts.firstEventTimeout;
      const read = reader.read().catch(error => { throw networkError(error, signal, 'stream'); });
      const { done, value } = bound ? await Promise.race([read, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new ModelError(eventSeen ? 'The model stream went idle.' :
          'The model did not send its first event in time.', { phase: 'stream', code: 'TIMEOUT', retryable: true })),
        Math.max(0, last + bound * 1000 - Date.now()));
      })]) : await read;
      clearTimeout(timer);
      if (eventSeen && value) last = Date.now();
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
        eventSeen = true;
        last = Date.now();
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
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

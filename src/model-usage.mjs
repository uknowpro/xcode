export function usageFrame(frame) {
  const value = frame?.usage ?? frame?.response?.usage ?? frame?.message?.usage ?? frame?.usageMetadata;
  if (!value || typeof value !== 'object') return {};
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const cache = value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ??
    value.cache_read_input_tokens ?? value.cachedContentTokenCount;
  let input = value.prompt_tokens ?? value.input_tokens ?? value.promptTokenCount;
  const output = value.completion_tokens ?? value.output_tokens ?? value.candidatesTokenCount;
  if (valid(value.cache_read_input_tokens) && valid(input)) input += value.cache_read_input_tokens;
  if (valid(value.cache_creation_input_tokens) && valid(input)) input += value.cache_creation_input_tokens;
  return Object.fromEntries(Object.entries({ input, output, cached: cache }).filter(([, value]) => valid(value)));
}

export function requestedBudget(existing = {}, options = {}) {
  const parse = (key, flag, max) => {
    const value = Number(options[flag] ?? existing[key] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid ' + flag + '.');
    return value;
  };
  return { requests: parse('requests', 'request-budget', 500), tools: parse('tools', 'tool-budget', 2000),
    tokens: parse('tokens', 'token-budget', 10000000) };
}

export function usageSummary(turns, inputPrice, outputPrice) {
  const models = {};
  for (const turn of turns) {
    for (const [model, item] of Object.entries(turn.usage?.models ?? {})) {
      if (!Object.hasOwn(models, model)) Object.defineProperty(models, model,
        { value: { requests: 0, input: 0, output: 0, cached: 0, estimated: 0 }, enumerable: true });
      for (const key of Object.keys(models[model])) models[model][key] += item[key] ?? 0;
    }
  }
  return Object.fromEntries(Object.entries(models).map(([model, value]) => [model, { ...value,
    uncached: Math.max(0, value.input - value.cached),
    ...(inputPrice !== undefined || outputPrice !== undefined ? {
      measuredCost: (value.input * (inputPrice ?? 0) + value.output * (outputPrice ?? 0)) / 1000000,
      estimatedUnreportedInputCost: value.estimated * (inputPrice ?? 0) / 1000000,
    } : {}),
  }]));
}

export function traceAttempt(job, name, estimate) {
  const log = job.usage ??= { requests: 0, models: {}, attempts: [] };
  const item = { model: name, start: new Date().toISOString(), estimatedInput: estimate };
  if (!Object.hasOwn(log.models, name)) Object.defineProperty(log.models, name,
    { value: { requests: 0, input: 0, output: 0, cached: 0, estimated: 0 }, enumerable: true });
  const counts = log.models[name];
  counts.requests++;
  log.requests++;
  log.attempts.push(item);
  if (log.attempts.length > 50) log.attempts.shift();
  const start = performance.now();
  return (meta, error) => {
    const tokens = meta.usage ?? {};
    counts.estimated += tokens.input === undefined ? estimate : 0;
    for (const key of ['input', 'output', 'cached']) counts[key] += tokens[key] ?? 0;
    Object.assign(item, { durationMs: Math.round(performance.now() - start), status: error ? 'failed' : 'ok',
      ...(meta.requestId ? { requestId: meta.requestId } : {}), ...(error?.phase ? { phase: error.phase } : {}) });
  };
}

export function requestFootprint(messages, limit) {
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  const tokens = Math.ceil(bytes / 4);
  if (limit && tokens > limit) throw new Error('Estimated request exceeds the configured context. Use session fit to trim attachments, keep a summary, or start fresh.');
  return { bytes, tokens, limit: limit ?? null };
}

const adapters = ['auto', 'compatible', 'deepseek-flash', 'qwen', 'kimi', 'gpt', 'claude', 'gemini'];
const protocols = ['auto', 'chat-completions', 'responses', 'anthropic', 'gemini'];
const thinkingModes = ['default', 'on', 'off'];
const efforts = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const presets = ['default', 'coding'];

function integer(value, name, min, max) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(name + ' must be an integer from ' + min + ' to ' + max + '.');
  return value;
}

function option(value, choices, name, fallback) {
  const selected = value ?? fallback;
  if (!choices.includes(selected)) throw new Error(name + ' must be ' + choices.join(', ') + '.');
  return selected;
}

export function endpointUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS model URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Enter an HTTP or HTTPS model URL without credentials or a fragment.');
  return url;
}

function inferProtocol(url) {
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|openai)$/.test(path)) return 'chat-completions';
  if (path.endsWith('/responses') || url.hostname === 'api.openai.com') return 'responses';
  if (path.endsWith('/messages') || url.hostname === 'api.anthropic.com') return 'anthropic';
  if (/:(?:stream)?generateContent$/i.test(path) || url.hostname === 'generativelanguage.googleapis.com')
    return 'gemini';
  return 'chat-completions';
}

function inferAdapter(name, protocol) {
  if (protocol === 'responses') return 'gpt';
  if (protocol === 'anthropic') return 'claude';
  if (protocol === 'gemini') return 'gemini';
  if (/^deepseek-(?:v4[.-]1-)?flash(?:-[0-9]{4})?$/i.test(name)) return 'deepseek-flash';
  if (/^qwen(?:3\.6|3-coder|3\.5)(?:[-.]|$)/i.test(name)) return 'qwen';
  if (/^kimi-(?:k3|k2(?:[.-]|$))/i.test(name)) return 'kimi';
  if (/^gemini-/i.test(name)) return 'gemini';
  return 'compatible';
}

export function modelPolicy(profile) {
  const selected = option(profile.adapter, adapters, 'Adapter', 'auto');
  const selection = option(profile.protocol, protocols, 'Protocol', 'auto');
  const protocol = selection === 'auto'
    ? (selected === 'compatible' ? 'chat-completions' : inferProtocol(endpointUrl(profile.endpoint))) : selection;
  const name = profile.model?.trim().split('/').at(-1);
  const adapter = selected === 'auto' ? inferAdapter(name, protocol) : selected;
  const preset = option(profile.modelPreset, presets, 'Model preset', 'default');
  const thinking = option(profile.thinking, thinkingModes, 'Thinking', 'default');
  const effort = option(profile.reasoningEffort, efforts, 'Effort', 'default');
  if (adapter === 'deepseek-flash' && !['default', 'low', 'high', 'max'].includes(effort))
    throw new Error('DeepSeek Flash effort must be default, low, high or max.');
  const contextWindow = integer(profile.contextWindow, 'Context window', 4096, 2097152);
  const maxTokens = integer(profile.maxTokens, 'Output tokens', 64, 131072);
  const requestTimeout = integer(profile.requestTimeout, 'Request timeout seconds', 5, 1800) ?? 180;
  if (contextWindow && maxTokens && maxTokens >= contextWindow)
    throw new Error('Output tokens must be smaller than the context window.');
  const headerTimeout = integer(profile.headerTimeout, 'Connection timeout seconds', 1, 600);
  const firstEventTimeout = integer(profile.firstEventTimeout, 'First event timeout seconds', 1, 600);
  const idleTimeout = integer(profile.idleTimeout, 'Stream idle timeout seconds', 1, 600);
  const streamFallback = option(profile.streamFallback, ['off', 'on'], 'Stream fallback', 'off') === 'on';
  const retryLimited = option(profile.retryLimited, ['off', 'on'], 'Rate limit retry', 'off') === 'on';
  const replay = protocol !== 'chat-completions' || ['deepseek-flash', 'qwen', 'kimi', 'gemini'].includes(adapter);
  return { adapter, selected, protocol, selection, preset, thinking, effort, contextWindow, maxTokens, requestTimeout, headerTimeout, firstEventTimeout, idleTimeout, streamFallback, retryLimited, replay };
}

export function modelEndpoint(profile, policy, stream = false) {
  const url = endpointUrl(profile.endpoint);
  const path = url.pathname.replace(/\/+$/, '');
  const base = path.replace(/\/(?:chat\/completions|responses|messages|models\/[^/]+:(?:streamGenerateContent|generateContent))$/, '');
  if (policy.protocol === 'gemini') {
    const model = profile.model.replace(/^models\//, '');
    if (!/^[\w.-]+$/.test(model)) throw new Error('Enter a Gemini model ID such as gemini-4-neon.');
    url.pathname = (base || '/v1beta') + '/models/' + model + (stream ? ':streamGenerateContent' : ':generateContent');
    if (stream) url.searchParams.set('alt', 'sse');
    else url.searchParams.delete('alt');
  } else {
    const route = { 'chat-completions': '/chat/completions', responses: '/responses', anthropic: '/messages' }[policy.protocol];
    url.pathname = (base || '/v1') + route;
  }
  return url;
}

export function configureModel(profile, options) {
  const value = { ...profile };
  for (const [flag, key] of [
    ['adapter', 'adapter'], ['protocol', 'protocol'], ['preset', 'modelPreset'],
    ['thinking', 'thinking'], ['effort', 'reasoningEffort'],
    ['stream-fallback', 'streamFallback'], ['retry-limited', 'retryLimited'],
  ]) {
    if (options[flag] !== undefined) value[key] = options[flag];
  }
  for (const [flag, key] of [['context-window', 'contextWindow'], ['max-tokens', 'maxTokens'], ['request-timeout', 'requestTimeout'],
    ['header-timeout', 'headerTimeout'], ['first-event-timeout', 'firstEventTimeout'], ['idle-timeout', 'idleTimeout']]) {
    const input = options[flag];
    if (input === undefined) continue;
    if (input === 'default') delete value[key];
    else {
      if (!/^[0-9]+$/.test(input)) throw new Error('--' + flag + ' expects an integer or default.');
      value[key] = Number(input);
    }
  }
  modelEndpoint(value, modelPolicy(value));
  return value;
}

export function requestOptions(policy) {
  if (policy.adapter === 'compatible') return {};
  const options = policy.maxTokens ? { max_tokens: policy.maxTokens } : {};
  const effort = policy.effort !== 'default' && policy.thinking !== 'off' ? policy.effort : undefined;
  if (policy.adapter === 'qwen') {
    if (policy.preset === 'coding') Object.assign(options, { temperature: 0.6, top_p: 0.95, top_k: 20 });
    if (policy.thinking !== 'default' || policy.preset === 'coding') options.chat_template_kwargs = {
      ...(policy.thinking !== 'default' ? { enable_thinking: policy.thinking === 'on' } : {}),
      ...(policy.thinking !== 'off' && policy.preset === 'coding' ? { preserve_thinking: true } : {}),
    };
  } else if (policy.adapter === 'deepseek-flash' || policy.adapter === 'kimi') {
    if (policy.thinking !== 'default') options.thinking = { type: policy.thinking === 'on' ? 'enabled' : 'disabled' };
    if (policy.adapter === 'kimi' && policy.preset === 'coding') {
      options.temperature = 1;
      options.top_p = 1;
      if (policy.thinking !== 'off') options.reasoning_effort = 'max';
    }
    if (effort) options.reasoning_effort = effort;
  } else if (effort) {
    options.reasoning_effort = effort;
  }
  return options;
}

export function modelTuning(profile) {
  const policy = modelPolicy(profile);
  return [
    'Protocol · ' + policy.protocol + (policy.selection === 'auto' ? ' (auto)' : ''),
    'Adapter · ' + policy.adapter + (policy.selected === 'auto' ? ' (auto)' : ''),
    'Request timeout · ' + policy.requestTimeout + 's',
    'JSON fallback · ' + (policy.streamFallback ? 'on' : 'off'),
    'Rate limit retry · ' + (policy.retryLimited ? 'on' : 'off'),
    ...(policy.headerTimeout ? ['Connection timeout · ' + policy.headerTimeout + 's'] : []),
    ...(policy.firstEventTimeout ? ['First event timeout · ' + policy.firstEventTimeout + 's'] : []),
    ...(policy.idleTimeout ? ['Stream idle timeout · ' + policy.idleTimeout + 's'] : []),
    ...(policy.adapter === 'compatible' ? [] : [
      'Model preset · ' + (policy.preset === 'default' ? 'server defaults' : policy.preset),
      'Thinking · ' + (policy.thinking === 'default' ? 'server default' : policy.thinking),
      'Effort · ' + (policy.thinking === 'off' ? 'off' : policy.effort === 'default' ? 'server default' : policy.effort),
      'Context window · ' + (policy.contextWindow ?? 'automatic replay budget'),
      'Output cap · ' + (policy.maxTokens ?? 'server default'),
    ]),
  ];
}

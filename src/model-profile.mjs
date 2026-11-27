const flashModel = /^deepseek-(?:v4[.-]1-)?flash(?:-[0-9]{4})?$/i;
const adapters = ['auto', 'compatible', 'deepseek-flash'];
const thinkingModes = ['default', 'on', 'off'];
const efforts = ['default', 'low', 'high', 'max'];

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

export function modelPolicy(profile) {
  const selected = option(profile.adapter, adapters, 'Adapter', 'auto');
  const name = profile.model?.trim().split('/').at(-1);
  const adapter = selected === 'auto' ? (flashModel.test(name) ? 'deepseek-flash' : 'compatible') : selected;
  const thinking = option(profile.thinking, thinkingModes, 'Thinking', 'default');
  const effort = option(profile.reasoningEffort, efforts, 'Effort', 'default');
  const contextWindow = integer(profile.contextWindow, 'Context window', 4096, 1048576);
  const maxTokens = integer(profile.maxTokens, 'Output tokens', 64, 131072);
  if (contextWindow && maxTokens && maxTokens >= contextWindow)
    throw new Error('Output tokens must be smaller than the context window.');
  return { adapter, selected, thinking, effort, contextWindow, maxTokens };
}

export function configureModel(profile, options) {
  const value = { ...profile };
  for (const [flag, key] of [['adapter', 'adapter'], ['thinking', 'thinking'], ['effort', 'reasoningEffort']]) {
    if (options[flag] !== undefined) value[key] = options[flag];
  }
  for (const [flag, key] of [['context-window', 'contextWindow'], ['max-tokens', 'maxTokens']]) {
    const input = options[flag];
    if (input === undefined) continue;
    if (input === 'default') delete value[key];
    else {
      if (!/^[0-9]+$/.test(input)) throw new Error('--' + flag + ' expects an integer or default.');
      value[key] = Number(input);
    }
  }
  modelPolicy(value);
  return value;
}

export function requestOptions(policy) {
  if (policy.adapter !== 'deepseek-flash') return {};
  return {
    ...(policy.thinking === 'default' ? {} : { thinking: { type: policy.thinking === 'on' ? 'enabled' : 'disabled' } }),
    ...(policy.thinking !== 'off' && policy.effort !== 'default' ? { reasoning_effort: policy.effort } : {}),
    ...(policy.maxTokens ? { max_tokens: policy.maxTokens } : {}),
  };
}

export function modelTuning(profile) {
  const policy = modelPolicy(profile);
  return [
    'Adapter · ' + policy.adapter + (policy.selected === 'auto' ? ' (auto)' : ''),
    ...(policy.adapter === 'deepseek-flash' ? [
      'Thinking · ' + (policy.thinking === 'default' ? 'server default' : policy.thinking),
      'Effort · ' + (policy.thinking === 'off' ? 'off' : policy.effort === 'default' ? 'server default' : policy.effort),
      'Context window · ' + (policy.contextWindow ?? 'automatic replay budget'),
      'Output cap · ' + (policy.maxTokens ?? 'server default'),
    ] : []),
  ];
}

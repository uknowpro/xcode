import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { modelEndpoint, modelPolicy } from './model-profile.mjs';
import { failed, readJsonResponse } from './model-transport.mjs';
import { modelLimit } from './limits.mjs';
import { lock, readJson, saveJson, storage } from './store.mjs';
import { join } from 'node:path';

const capabilityPath = join(storage, 'capabilities.json');

export function diagnosticKey(profile) {
  return createHash('sha256').update(JSON.stringify([
    profile.endpoint, profile.model, modelPolicy(profile), profile.tools, profile.imageInput, profile.pdfInput,
  ])).digest('hex');
}

export async function modelDirectory(profile, token, signal) {
  const { protocol } = modelPolicy(profile);
  const url = modelEndpoint(profile, modelPolicy(profile));
  url.pathname = protocol === 'gemini' ? url.pathname.replace(/\/models\/.*$/, '/models') :
    url.pathname.replace(/\/(?:chat\/completions|responses|messages)$/, '/models');
  const headers = {};
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (token) headers['x-api-key'] = token;
  } else if (protocol === 'gemini') {
    if (token) headers['x-goog-api-key'] = token;
  } else if (token) headers.Authorization = 'Bearer ' + token;
  return modelLimit.run(signal, async () => {
    const response = await fetch(url, { headers, signal, redirect: 'error', credentials: 'omit' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failed(response.status, '', 'http');
    }
    const data = await readJsonResponse(response, signal);
    const items = protocol === 'gemini' ? data.models : data.data;
    if (!Array.isArray(items)) throw new Error('The endpoint did not return a model directory.');
    const ids = [...new Set(items.map(item => protocol !== 'gemini' ? item?.id :
      (typeof item?.name === 'string' ? item.name.replace(/^models\//, '') : undefined))
      .filter(value => typeof value === 'string' && value.length <= 180 && !/[\x00-\x1f\x7f-\x9f]/.test(value)))].slice(0, 2000);
    return { ids, verified: ids.includes(profile.model.replace(/^models\//, '')),
      more: Boolean(data.nextPageToken || data.has_more || items.length > 2000) };
  });
}

export async function networkSettings(env = process.env) {
  const enabled = (flag, key) => process.execArgv.includes(flag) || env[key] === '1' ||
    (env.NODE_OPTIONS ?? '').split(/\s+/).includes(flag);
  const ca = env.NODE_EXTRA_CA_CERTS;
  const caState = !ca ? 'unset' : (await lstat(ca).catch(() => null))?.isFile() ? 'configured' : 'unreadable';
  return {
    systemCA: enabled('--use-system-ca', 'NODE_USE_SYSTEM_CA'),
    extraCA: caState,
    environmentProxy: {
      supported: process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
      enabled: enabled('--use-env-proxy', 'NODE_USE_ENV_PROXY'),
      http: Boolean(env.http_proxy || env.HTTP_PROXY), https: Boolean(env.https_proxy || env.HTTPS_PROXY),
      exceptions: Boolean(env.no_proxy || env.NO_PROXY),
    },
  };
}

export async function savedCapabilities(profileName) {
  const value = await readJson(capabilityPath, {}).catch(() => ({}));
  return value && Object.hasOwn(value, profileName) ? value[profileName] : undefined;
}

export async function cacheCapabilities(profileName, key, results = []) {
  const unlock = await lock(storage, 'capabilities');
  try {
    const value = await readJson(capabilityPath, {}).catch(() => ({})) ?? {};
    if (!key) delete value[profileName];
    else {
      const prior = Object.hasOwn(value, profileName) ? value[profileName] : undefined;
      const time = new Date().toISOString();
      value[profileName] = { key, tests: {
        ...(prior?.key === key ? prior.tests : {}),
        ...Object.fromEntries(results.map(item => [item.name, { status: item.status, time }])),
      } };
    }
    await saveJson(capabilityPath, value);
  } finally {
    await unlock();
  }
}

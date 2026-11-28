import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configureEditor } from './chat-input.mjs';
import { defineCheck } from './checks.mjs';
import { executionLimits } from './limits.mjs';
import { modelEndpoint, modelPolicy } from './model-profile.mjs';
import { settings, storage } from './store.mjs';

const schemaUrl = new URL('../docs/settings.schema.json', import.meta.url);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const settingsSchema = () => readFile(schemaUrl, 'utf8');

function invalidJsonOffset(text) {
  let at = 0;
  const match = pattern => {
    pattern.lastIndex = at;
    const value = pattern.exec(text);
    if (value) at = pattern.lastIndex;
    return Boolean(value);
  };
  const spaces = () => match(/[ \t\r\n]*/y);
  const string = () => match(/"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y);
  const consume = character => {
    spaces();
    if (text[at] !== character) return false;
    at++;
    return true;
  };
  function value(depth) {
    spaces();
    if (depth > 256) throw at;
    if (string() || match(/(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y)) return;
    const object = consume('{');
    if (!object && !consume('[')) throw at;
    const end = object ? '}' : ']';
    if (consume(end)) return;
    do {
      spaces();
      if (object && (!string() || !consume(':'))) throw at;
      value(depth + 1);
      if (consume(end)) return;
    } while (consume(','));
    throw at;
  }
  try {
    value(0);
    spaces();
    return at;
  } catch (position) {
    return typeof position === 'number' ? position : at;
  }
}

function jsonPosition(error, text) {
  const explicit = /line (\d+) column (\d+)/i.exec(error.message);
  if (explicit) return { line: Number(explicit[1]), column: Number(explicit[2]) };
  const index = Number(/at position (\d+)/i.exec(error.message)?.[1] ?? invalidJsonOffset(text));
  const rows = text.slice(0, index).split('\n');
  return { line: rows.length, column: rows.at(-1).length + 1 };
}

export async function validateSettings() {
  const text = await readFile(join(storage, 'settings.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return [{ field: '$', issue: 'Invalid JSON syntax', ...jsonPosition(error, text) }];
  }
  if (!object(config)) return [{ field: '$', issue: 'Expected a JSON object', line: 1 }];
  const schema = JSON.parse(await settingsSchema());
  const issues = [];
  const check = (field, validate) => {
    try { validate(); } catch (error) { issues.push({ field, issue: error.message }); }
  };
  for (const [key, value] of Object.entries(config)) {
    const rule = Object.hasOwn(schema.properties, key) && schema.properties[key];
    const at = text.indexOf(JSON.stringify(key));
    const location = at >= 0 ? { line: text.slice(0, at).split('\n').length } : {};
    if (!rule) issues.push({ field: '$.' + key, issue: 'Unknown setting', ...location });
    else if (rule.type === 'object' ? !object(value) : typeof value !== rule.type)
      issues.push({ field: '$.' + key, issue: 'Expected ' + rule.type, ...location });
  }
  for (const [name, profile] of Object.entries(object(config.profiles) ? config.profiles : {})) {
    check('$.profiles.' + name, () => {
      if (!object(profile) || typeof profile.model !== 'string' || !profile.model.trim()) throw new Error('A model ID is required.');
      for (const key of ['tools', 'imageInput', 'pdfInput']) {
        if (profile[key] !== undefined && typeof profile[key] !== 'boolean') throw new Error(key + ' must be true or false.');
      }
      modelEndpoint(profile, modelPolicy(profile));
    });
  }
  if (config.terminal) check('$.terminal', () => configureEditor(config.terminal, {}));
  if (config.execution) check('$.execution', () => executionLimits(config.execution));
  for (const [project, checks] of Object.entries(object(config.projectChecks) ? config.projectChecks : {})) {
    for (const [name, value] of Object.entries(object(checks) ? checks : {}))
      check('$.projectChecks.' + project + '.' + name, () => defineCheck(value?.argv, value?.timeout, value?.directory));
  }
  return issues;
}

export async function doctor(root) {
  const results = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  results.push({ check: 'node', status: major > 22 || (major === 22 && minor >= 5) ? 'pass' : 'fail', detail: process.versions.node });
  results.push({ check: 'terminal', status: process.stdin.isTTY && process.stdout.isTTY ? 'pass' : 'info',
    detail: process.stdin.isTTY && process.stdout.isTTY ? 'Interactive terminal' : 'Noninteractive output' });
  for (const [check, path] of [['workspace', root], ['state', storage]]) {
    if (check === 'state') await settings().catch(() => {});
    const writable = await access(path, constants.R_OK | constants.W_OK).then(() => true, () => false);
    results.push({ check, status: writable ? 'pass' : 'fail', detail: writable ? 'Readable and writable' : 'Unavailable or not writable' });
  }
  const issues = await validateSettings().catch(() => [{ field: '$', issue: 'Settings could not be read' }]);
  results.push({ check: 'settings', status: issues.length ? 'fail' : 'pass',
    detail: issues.length ? issues.length + ' issue(s). Run xcode settings validate.' : 'Configuration valid' });
  return { results, issues };
}

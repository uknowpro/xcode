const keywords = new Set(['$schema', 'title', 'description', 'type', 'properties', 'required', 'items', 'enum', 'const',
  'additionalProperties', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateContract(schema, value) {
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function verify(rule, data, path, depth) {
    if (depth > 32 || (typeof rule !== 'boolean' && !isObject(rule))) throw new Error('Invalid schema at ' + path);
    if (typeof rule === 'boolean') {
      if (!rule) throw new Error('Schema rejects ' + path);
      return;
    }
    for (const key of Object.keys(rule)) if (!keywords.has(key)) throw new Error('Unsupported schema keyword ' + key + ' at ' + path);
    const type = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    const expected = typeof rule.type === 'string' ? [rule.type] : rule.type;
    if (expected && (!Array.isArray(expected) || !expected.some(item => item === type || item === 'integer' && Number.isInteger(data))))
      throw new Error('Incorrect type at ' + path);
    if (rule.enum && (!Array.isArray(rule.enum) || !rule.enum.some(item => equal(item, data)))) throw new Error('Value outside enum at ' + path);
    if (Object.hasOwn(rule, 'const') && !equal(rule.const, data)) throw new Error('Incorrect constant at ' + path);
    const bounds = type === 'string' ? ['minLength', 'maxLength', [...data].length] :
      type === 'array' ? ['minItems', 'maxItems', data.length] : type === 'number' ? ['minimum', 'maximum', data] : null;
    if (bounds && ((rule[bounds[0]] ?? -Infinity) > bounds[2] || (rule[bounds[1]] ?? Infinity) < bounds[2]))
      throw new Error('Value outside bounds at ' + path);
    if (type === 'array' && rule.items !== undefined)
      for (const [index, item] of data.entries()) verify(rule.items, item, path + '/' + index, depth + 1);
    if (type === 'object') {
      for (const key of rule.required ?? []) if (!Object.hasOwn(data, key)) throw new Error('Missing field at ' + path + '/' + key);
      for (const [key, item] of Object.entries(data)) {
        const child = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : rule.additionalProperties;
        if (child !== undefined) verify(child, item, path + '/' + key, depth + 1);
      }
    }
  }
  verify(schema, value, '$', 0);
}

export function validateAnswer(schema, text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The answer did not contain a valid JSON value.'); }
  validateContract(schema, data);
  return data;
}

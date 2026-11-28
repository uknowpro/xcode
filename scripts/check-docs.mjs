import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { version, engines } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const file of ['README.md', 'README.ko.md']) {
  const document = await readFile(new URL('../' + file, import.meta.url), 'utf8');
  const tags = [...document.matchAll(/uknowpro-xcode-([\d.]+)\.tgz/g)].map(match => match[1]);
  assert.ok(tags.length && tags.every(tag => tag === version), file + ' installation version');
  assert.ok(document.includes('Node.js ' + engines.node.slice(2)), file + ' Node requirement');
  for (const command of ['xcode setup', 'xcode profile test', 'xcode report', 'xcode completion'])
    assert.ok(document.includes(command), file + ' is missing ' + command);
}
console.log('English and Korean installation examples match the package.');

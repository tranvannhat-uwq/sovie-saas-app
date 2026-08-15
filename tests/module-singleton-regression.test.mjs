import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsRoot = path.join(root, 'js');

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listJavaScriptFiles(target) : (entry.name.endsWith('.js') ? [target] : []);
  });
}

test('stateful browser modules use one URL identity across the entire import graph', () => {
  const imports = listJavaScriptFiles(jsRoot).flatMap(file => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(/from\s+['"]([^'"]+\?v=([^'"]+))['"]/g)]
      .map(match => ({ file, specifier: match[1], version: match[2] }));
  });

  const versions = new Set(imports.map(item => item.version));
  assert.deepEqual([...versions], ['20260814-invoice-discount-label-v19']);

  for (const moduleName of ['main.js', 'services/supabase.js']) {
    const identities = new Set(imports
      .filter(item => item.specifier.includes(moduleName))
      .map(item => item.specifier.replace(/^.*?(?=(?:services\/)?(?:main|supabase)\.js)/, '')));
    assert.equal(identities.size, 1, `${moduleName} must not be instantiated more than once`);
  }
});

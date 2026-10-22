import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsRoot = path.join(root, 'js');

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listJavaScriptFiles(target) : (entry.name.endsWith('.js') ? [target] : []);
  });
}

test('browser module imports resolve to one canonical file URL', () => {
  const files = listJavaScriptFiles(jsRoot);
  const canonicalUrls = new Map();

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)]
      .map(match => match[2])
      .filter(specifier => specifier.startsWith('.'));

    for (const specifier of specifiers) {
      const resolvedUrl = new URL(specifier, pathToFileURL(file));
      assert.equal(resolvedUrl.search, '', `${path.relative(root, file)} imports ${specifier} with a query string`);
      assert.equal(resolvedUrl.hash, '', `${path.relative(root, file)} imports ${specifier} with a fragment`);
      assert.ok(resolvedUrl.pathname.endsWith('.js'), `${specifier} should resolve to a JavaScript module`);
      assert.ok(fs.existsSync(fileURLToPath(resolvedUrl)), `${path.relative(root, file)} imports missing ${specifier}`);

      const resolvedPath = path.resolve(fileURLToPath(resolvedUrl));
      const priorUrl = canonicalUrls.get(resolvedPath);
      if (priorUrl) assert.equal(priorUrl, resolvedUrl.href, `${resolvedPath} has multiple browser URL identities`);
      else canonicalUrls.set(resolvedPath, resolvedUrl.href);
    }
  }

  for (const moduleName of ['state.js', 'services/supabase.js', 'components/products.js', 'components/pricelists.js']) {
    assert.ok(fs.existsSync(path.join(jsRoot, moduleName)), `${moduleName} must exist in the application module graph`);
  }
});

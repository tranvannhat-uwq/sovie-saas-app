import fs from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidMigrationChain } from './migration-inventory.mjs';
import { publicFiles } from './project-files.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'js');
const indexPath = join(projectRoot, 'index.html');

function stripQueryAndHash(value) {
  return value.split(/[?#]/, 1)[0];
}

function isLocalReference(value) {
  return value
    && !value.startsWith('#')
    && !value.startsWith('data:')
    && !value.startsWith('//')
    && !/^[a-z][a-z\d+.-]*:/i.test(value);
}

function assertInsideProject(target, description) {
  const pathFromRoot = relative(projectRoot, target);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`${description} resolves outside the project: ${target}`);
  }
}

async function assertExists(target, description) {
  try {
    await access(target);
  } catch {
    throw new Error(`${description} is missing: ${relative(projectRoot, target)}`);
  }
}

async function verifyIndexAssets() {
  const html = await readFile(indexPath, 'utf8');
  const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map(match => stripQueryAndHash(match[1].trim()))
    .filter(isLocalReference);

  for (const reference of references) {
    const target = resolve(projectRoot, reference);
    assertInsideProject(target, `index.html reference ${reference}`);
    await assertExists(target, `index.html reference ${reference}`);

    if (!reference.startsWith('js/') && !publicFiles.includes(reference)) {
      throw new Error(`Local asset ${reference} is referenced by index.html but is not included in scripts/project-files.mjs.`);
    }
  }
}

async function verifyModuleGraph() {
  const visited = new Set();
  const pending = [join(sourceRoot, 'main.js'), join(sourceRoot, 'landing-motion.js')];

  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    await assertExists(current, 'JavaScript entry or import');

    const source = await readFile(current, 'utf8');
    const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)]
      .map(match => stripQueryAndHash(match[1]))
      .filter(reference => reference.startsWith('.'));

    for (const imported of imports) {
      const target = normalize(resolve(dirname(current), imported));
      assertInsideProject(target, `Import ${imported} from ${relative(projectRoot, current)}`);
      await assertExists(target, `Import ${imported} from ${relative(projectRoot, current)}`);
      if (extname(target) === '.js') pending.push(target);
    }
  }

  return visited.size;
}

const [migrationNames, moduleCount] = await Promise.all([
  Promise.resolve(assertValidMigrationChain(join(projectRoot, 'migrations'))),
  verifyModuleGraph(),
  verifyIndexAssets()
]);

console.log(`Verified ${moduleCount} reachable JavaScript modules, ${publicFiles.length} deployed root files, and ${migrationNames.length} ordered migrations.`);

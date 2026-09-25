import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { immutablePublicFiles, publicFiles } from './project-files.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(projectRoot, 'dist');
if (dirname(outputRoot) !== projectRoot || outputRoot === projectRoot) {
  throw new Error('Refusing to build outside the project dist directory.');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(join(projectRoot, 'js'), join(outputRoot, 'js'), { recursive: true });

for (const relativePath of publicFiles) {
  const destination = join(outputRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(projectRoot, relativePath), destination);
}

const headers = `/*
  Cache-Control: no-cache
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY
  Content-Security-Policy: base-uri 'self'; object-src 'none'; frame-ancestors 'none'

/index.html
  Cache-Control: no-store

/js/*
  Cache-Control: no-cache
${immutablePublicFiles
    .map(relativePath => `\n/${relativePath}\n  Cache-Control: public, max-age=31536000, immutable`)
    .join('\n')}
`;
await writeFile(join(outputRoot, '_headers'), headers, 'utf8');

const index = await readFile(join(outputRoot, 'index.html'), 'utf8');
if (!index.includes('mqxqswwssmemkimnolfu') && !index.includes('js/main.js')) {
  throw new Error('Built index does not look like the SoVie SaaS staging app.');
}

console.log(`Static staging bundle created at ${outputRoot}`);

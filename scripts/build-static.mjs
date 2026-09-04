import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(projectRoot, 'dist');
const publicFiles = [
  'CNAME',
  'index.html',
  'style.css',
  'landing.css',
  'landing-premium.css',
  'ui-system.css',
  'sovie-favicon.png',
  'sovie-logo.png',
  'absjapan.png',
  'festiva.png',
  'hatacco.png',
];

if (dirname(outputRoot) !== projectRoot || outputRoot === projectRoot) {
  throw new Error('Refusing to build outside the project dist directory.');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(join(projectRoot, 'js'), join(outputRoot, 'js'), { recursive: true });

for (const relativePath of publicFiles) {
  await cp(join(projectRoot, relativePath), join(outputRoot, relativePath));
}

const headers = `/*
  Cache-Control: no-cache
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY

/index.html
  Cache-Control: no-store

/js/*
  Cache-Control: public, max-age=300, must-revalidate
`;
await writeFile(join(outputRoot, '_headers'), headers, 'utf8');

const index = await readFile(join(outputRoot, 'index.html'), 'utf8');
if (!index.includes('mqxqswwssmemkimnolfu') && !index.includes('js/main.js')) {
  throw new Error('Built index does not look like the SoVie SaaS staging app.');
}

console.log(`Static staging bundle created at ${outputRoot}`);

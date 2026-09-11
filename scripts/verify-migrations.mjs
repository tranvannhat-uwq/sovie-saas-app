import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidMigrationChain } from './migration-inventory.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationNames = assertValidMigrationChain(join(projectRoot, 'migrations'));

console.log(`Verified ${migrationNames.length} ordered migrations (${migrationNames.at(-1)} is current).`);

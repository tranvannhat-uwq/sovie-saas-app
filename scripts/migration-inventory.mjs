import fs from 'node:fs';

export const migrationFilePattern = /^(\d{4})_.+\.sql$/;

/**
 * The filesystem is the canonical ordered migration inventory. Keeping a
 * second hard-coded list in tests or deployment scripts made every new
 * migration require unrelated edits and was prone to drift.
 */
export function listOrderedMigrations(migrationDirectory) {
  return fs.readdirSync(migrationDirectory)
    .filter(name => migrationFilePattern.test(name))
    .sort();
}

export function assertValidMigrationChain(migrationDirectory, readFile = file => fs.readFileSync(file, 'utf8')) {
  const migrationNames = listOrderedMigrations(migrationDirectory);
  if (migrationNames.length === 0) {
    throw new Error('No ordered SQL migrations were found.');
  }

  migrationNames.forEach((name, index) => {
    const expectedVersion = String(index + 1).padStart(4, '0');
    const match = name.match(migrationFilePattern);
    if (!match || match[1] !== expectedVersion) {
      throw new Error(`Expected migration ${expectedVersion}, found ${name}. Migration versions must be contiguous.`);
    }

    const sql = readFile(`${migrationDirectory}/${name}`);
    if (!new RegExp(`VALUES\\s*\\(\\s*'${expectedVersion}'`).test(sql)) {
      throw new Error(`${name} does not register version ${expectedVersion} in public.schema_migrations.`);
    }
    if (!/\bBEGIN\s*;/i.test(sql) || !/\bCOMMIT\s*;/i.test(sql)) {
      throw new Error(`${name} must contain an explicit BEGIN; / COMMIT; transaction boundary.`);
    }
  });

  return migrationNames;
}

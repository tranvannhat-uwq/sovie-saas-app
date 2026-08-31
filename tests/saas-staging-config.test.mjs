import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');

test('SaaS web app is pinned to the unused mobile staging clone', () => {
  assert.match(config, /SAAS_STAGING_PROJECT_REF = 'mqxqswwssmemkimnolfu'/);
  assert.doesNotMatch(config, /coebrkerpcgwckkwxlfo/);
  assert.match(config, /COMPANY_SUPABASE_URL = `https:\/\/\$\{SAAS_STAGING_PROJECT_REF\}\.supabase\.co`/);
  assert.match(config, /COMPANY_SUPABASE_KEY = "sb_publishable_/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(
  new URL('../scripts/apply-migration-0100-staging.ps1', import.meta.url),
  'utf8'
);
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

test('the activation repair deploy script is staging-locked and verifies the deployed RPC', () => {
  assert.match(script, /\$stagingProjectRef = 'mqxqswwssmemkimnolfu'/);
  assert.match(script, /Type \$stagingProjectRef to confirm this is STAGING/);
  assert.match(script, /PREREQUISITE_0082_OK/);
  assert.match(script, /0100_manual_trial_activation\.sql/);
  assert.match(script, /NOTIFY pgrst, 'reload schema'/);
  assert.match(script, /MIGRATION_0100_VERIFIED/);
  assert.match(script, /has_function_privilege\('authenticated'/);
  assert.match(script, /NOT has_function_privilege\('anon'/);
  assert.match(script, /customer_activated/);
  assert.doesNotMatch(script, /\bpassword\s*=\s*['"][^'"]+['"]/i);
  assert.match(packageJson, /"db:apply-trial-activation"/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '0065_tenant_activity_conflict_keys.sql'), 'utf8');

test('legacy activity trigger conflict targets are rewritten for tenant identity', () => {
  for (const name of ['p36_log_activity_row', 'p37_log_draft_activity', 'p52_log_price_change']) {
    assert.match(sql, new RegExp(name));
  }
  assert.match(sql, /ON CONFLICT \(organization_id, operation_key, module, target_type, target_id\)/);
  assert.doesNotMatch(sql, /ADD CONSTRAINT[\s\S]*operation_key, module, target_type, target_id/);
});

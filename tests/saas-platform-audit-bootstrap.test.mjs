import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '0059_platform_audit_tenant_bootstrap.sql'),
  'utf8'
);

test('only unauthenticated platform audit bootstrap may omit tenant', () => {
  assert.match(
    sql,
    /is_platform_audit boolean := TG_TABLE_NAME IN \('audit_logs', 'activity_logs'\)\s+AND auth\.uid\(\) IS NULL/
  );
  assert.match(
    sql,
    /IF NEW\.organization_id IS NULL THEN\s+IF is_platform_audit THEN\s+RETURN NEW;\s+END IF;/
  );
  assert.match(sql, /cross-organization write rejected/);
});

test('trigger function remains unavailable as a browser RPC', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.enforce_business_row_organization\(\)/);
  assert.match(sql, /FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /VALUES \('0059'/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'scripts/copy-dashboard-production-to-staging.ps1'), 'utf8');

test('dashboard transfer hard-codes source and target project identities', () => {
  assert.match(script, /productionRef = 'coebrkerpcgwckkwxlfo'/);
  assert.match(script, /stagingRef = 'mqxqswwssmemkimnolfu'/);
  assert.match(script, /URI does not contain expected project ref/);
  assert.match(script, /COPY_ANONYMIZED_DASHBOARD_TO_STAGING/);
});

test('production connection is forced read-only and credentials are not persisted', () => {
  assert.match(script, /default_transaction_read_only=on/);
  assert.match(script, /-SourceReadOnly/);
  assert.match(script, /UseSystemPasswordChar = \$true/);
  assert.match(script, /\[REDACTED_DATABASE_URL\]/);
  assert.doesNotMatch(script, /Set-Content[^\n]*(?:databasePassword|productionUrl|stagingUrl)/i);
});

test('transfer can use the installed Docker runtime when psql is absent', () => {
  assert.match(script, /Get-Command psql[\s\S]*Get-Command docker/);
  assert.match(script, /docker info --format/);
  assert.match(script, /Docker Desktop is installed but its engine is not running/);
  assert.match(script, /No connection to production or staging was opened/);
  assert.match(script, /postgres:17-alpine', 'psql'/);
  assert.match(script, /docker image inspect postgres:17-alpine/);
  assert.match(script, /docker pull postgres:17-alpine/);
  assert.match(script, /Downloading PostgreSQL client image \(first run only\)/);
  assert.match(script, /\$ErrorActionPreference = 'Continue'[\s\S]*docker @dockerArguments/);
  assert.match(script, /type=bind,source=\$workDirectory,target=\/work/);
  assert.match(script, /\/work\/import\.sql/);
});

test('customer and order identity fields are anonymized before export', () => {
  for (const field of ['phone', 'phone2', 'email', 'facebook', 'address', 'invoice_address', 'company_name', 'tax_code', 'notes']) {
    assert.match(script, new RegExp(`'${field}', NULL`));
  }
  assert.match(script, /'Kh' \|\| chr\(225\) \|\| 'ch h' \|\| chr\(224\)/);
  assert.match(script, /source_row\.customer_id[\s\S]*chr\(7867\)/);
  assert.match(script, /contains_direct_customer_pii', false/);
});

test('transfer does not delete staging business rows and imports atomically', () => {
  assert.match(script, /BEGIN;/);
  assert.match(script, /ON_ERROR_STOP=1/);
  assert.match(script, /\$importLines\.Add\('COMMIT;'\)/);
  assert.match(script, /ON CONFLICT \(%I\) DO UPDATE/);
  assert.doesNotMatch(script, /(?:DELETE|TRUNCATE) FROM public\.(?:customers|orders|order_items|products)/i);
  assert.match(script, /customers_with_contact_pii/);
  assert.match(script, /dashboard_net_sales_90d/);
  assert.match(script, /coalesce\(sum\(net_revenue\), 0\)/);
  assert.doesNotMatch(script, /verification[\s\S]*rpc_get_phase5_dashboard/);
});

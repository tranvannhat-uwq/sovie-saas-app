import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '0071_billing_control_plane.sql'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'migrations', 'tests', 'saas_billing_control_plane_integration.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const workspaces = fs.readFileSync(path.join(root, 'js', 'components', 'workspaces.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('billing requests are Owner-only and never mutate subscriptions from the browser', () => {
  assert.match(sql, /rpc_request_plan_change/);
  assert.match(sql, /ARRAY\['owner'\]/);
  assert.match(sql, /billing_checkout_requests_one_open_uidx/);
  assert.match(integration, /non_owner_cannot_request_plan_change/);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE).*billing_checkout_requests.*authenticated/is);
});

test('billing invoices are tenant-private and webhook events are service-only idempotent', () => {
  assert.match(sql, /billing_invoices_owner_read/);
  assert.match(sql, /billing_webhook_events[\s\S]*event_key text NOT NULL UNIQUE/);
  assert.match(sql, /rpc_apply_billing_event/);
  assert.match(sql, /FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /TO service_role/);
  assert.match(integration, /invoice_is_tenant_private/);
});

test('paid and failed invoices drive the existing subscription lifecycle', () => {
  assert.match(sql, /WHEN 'invoice_paid' THEN 'active'/);
  assert.match(sql, /WHEN 'invoice_failed' THEN 'past_due'/);
  assert.match(sql, /rpc_apply_subscription_state/);
  assert.match(sql, /billing:/);
  assert.match(integration, /failed_invoice_enters_subscription_grace/);
});

test('Owner billing UI reads the summary and only requests plan changes', () => {
  assert.match(service, /rpc_my_billing_summary/);
  assert.match(service, /rpc_request_plan_change/);
  assert.doesNotMatch(service, /rpc_apply_billing_event/);
  assert.match(workspaces, /renderBillingManagement/);
  assert.match(html, /id="billing-management-section"/);
});

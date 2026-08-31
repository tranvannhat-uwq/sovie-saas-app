import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0072_signed_billing_event_ordering.sql'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'migrations', 'tests', 'saas_signed_billing_event_ordering_integration.sql'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'billing-webhook', 'index.ts'), 'utf8');

test('signed billing RPC rejects stale state transitions and future events', () => {
  assert.match(migration, /billing_event_at/);
  assert.match(migration, /last_event_at <= EXCLUDED\.last_event_at/);
  assert.match(migration, /stale_event/);
  assert.match(migration, /p_occurred_at > now\(\) \+ interval '5 minutes'/);
  assert.match(integration, /stale_failure_cannot_regress_paid_state/);
});

test('unsigned service RPC is retired and signed RPC remains service-only', () => {
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.rpc_apply_billing_event[\s\S]*FROM service_role/);
  assert.match(migration, /rpc_apply_signed_billing_event/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /TO service_role/);
});

test('Edge webhook authenticates the raw body with timestamped HMAC before service RPC', () => {
  assert.match(edge, /BILLING_WEBHOOK_SECRET/);
  assert.match(edge, /HMAC/);
  assert.match(edge, /SHA-256/);
  assert.match(edge, /timestamp}\.\$\{rawBody}/);
  assert.match(edge, /> 300/);
  assert.match(edge, /safeEqual/);
  assert.match(edge, /rpc_apply_signed_billing_event/);
  assert.doesNotMatch(edge, /Access-Control-Allow-Origin/);
});

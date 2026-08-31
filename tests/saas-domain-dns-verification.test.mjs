import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(root,'migrations','0073_domain_dns_verification_attempts.sql'),'utf8');
const edge=fs.readFileSync(path.join(root,'supabase','functions','verify-custom-domain','index.ts'),'utf8');
const integration=fs.readFileSync(path.join(root,'migrations','tests','saas_domain_dns_verification_integration.sql'),'utf8');
const service=fs.readFileSync(path.join(root,'js','services','supabase.js'),'utf8');
const workspaces=fs.readFileSync(path.join(root,'js','components','workspaces.js'),'utf8');

test('DNS attempts are Owner-only, tenant-scoped and rate-limited',()=>{
  assert.match(migration,/rpc_begin_domain_dns_verification/);
  assert.match(migration,/ARRAY\['owner'\]/);
  assert.match(migration,/candidate\.organization_id = active_organization_id/);
  assert.match(migration,/interval '1 minute'/);
  assert.match(migration,/domain_verification_attempts_owner_read/);
  assert.match(integration,/other_tenant_cannot_begin_attempt/);
});
test('only service role can finish an attempt and SSL is never self-asserted',()=>{
  assert.match(migration,/rpc_finish_domain_dns_verification/);
  assert.match(migration,/FROM PUBLIC, anon, authenticated/);
  assert.match(migration,/TO service_role/);
  assert.match(migration,/COALESCE\(p_verified,false\),\s*false, 'system'/);
  assert.match(integration,/dns_verification_never_self_activates_ssl/);
});
test('Edge function uses authenticated Owner RPC and fixed DNS-over-HTTPS endpoint',()=>{
  assert.match(edge,/auth\.getUser\(\)/);
  assert.match(edge,/rpc_begin_domain_dns_verification/);
  assert.match(edge,/https:\/\/cloudflare-dns\.com\/dns-query/);
  assert.match(edge,/type=TXT/);
  assert.match(edge,/AbortSignal\.timeout\(8000\)/);
  assert.match(edge,/rpc_finish_domain_dns_verification/);
  assert.match(service,/functions\.invoke\('verify-custom-domain'/);
  assert.match(workspaces,/domain-dns-check-btn/);
});

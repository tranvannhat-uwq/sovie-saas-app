import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(root,'migrations','0074_cloudflare_ssl_provisioning.sql'),'utf8');
const edge=fs.readFileSync(path.join(root,'supabase','functions','provision-custom-domain','index.ts'),'utf8');
const integration=fs.readFileSync(path.join(root,'migrations','tests','saas_cloudflare_ssl_provisioning_integration.sql'),'utf8');
const service=fs.readFileSync(path.join(root,'js','services','supabase.js'),'utf8');
const workspaces=fs.readFileSync(path.join(root,'js','components','workspaces.js'),'utf8');

test('Cloudflare jobs require Owner, DNS verification and tenant scope',()=>{
  assert.match(migration,/rpc_begin_domain_ssl_provisioning/);
  assert.match(migration,/ARRAY\['owner'\]/);
  assert.match(migration,/candidate\.organization_id=active_organization_id/);
  assert.match(migration,/candidate\.status IN \('verified','active'\)/);
  assert.match(migration,/domain_provisioning_jobs_one_open_uidx/);
  assert.match(integration,/other_tenant_cannot_queue_ssl/);
});
test('only service role records provider readiness and both statuses must be active',()=>{
  assert.match(migration,/rpc_finish_domain_ssl_provisioning/);
  assert.match(migration,/hostname_ready AND ssl_ready/);
  assert.match(migration,/FROM PUBLIC,anon,authenticated/);
  assert.match(migration,/TO service_role/);
  assert.match(integration,/both_active_statuses_activate_custom_domain/);
});
test('Edge adapter is fail-closed and uses the official custom-hostnames API',()=>{
  assert.match(edge,/CLOUDFLARE_API_TOKEN/);
  assert.match(edge,/CLOUDFLARE_ZONE_ID/);
  assert.match(edge,/CLOUDFLARE_ORIGIN_HOSTNAME/);
  assert.match(edge,/CLOUDFLARE_CNAME_TARGET/);
  assert.match(edge,/api\.cloudflare\.com\/client\/v4\/zones\/\$\{zoneId\}\/custom_hostnames/);
  assert.match(edge,/ssl:\{method:'http',type:'dv'/);
  assert.match(edge,/rpc_finish_domain_ssl_provisioning/);
  assert.match(service,/functions\.invoke\('provision-custom-domain'/);
  assert.match(workspaces,/domain-ssl-btn/);
});

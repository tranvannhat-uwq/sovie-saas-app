import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(root,'migrations','0075_plan_catalog_branch_warehouse_management.sql'),'utf8');
const integration=fs.readFileSync(path.join(root,'migrations','tests','saas_branch_warehouse_management_integration.sql'),'utf8');
const service=fs.readFileSync(path.join(root,'js','services','supabase.js'),'utf8');
const workspace=fs.readFileSync(path.join(root,'js','components','workspaces.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

test('plan catalog carries the documented Starter, Pro and Business quotas',()=>{
 assert.match(migration,/'pro'[\s\S]*"users":20[\s\S]*"branches":5[\s\S]*"monthly_orders":5000/);
 assert.match(migration,/'business'[\s\S]*"users":100[\s\S]*"branches":20[\s\S]*"monthly_orders":25000[\s\S]*"custom_domains":1/);
 assert.match(integration,/plan_catalog_has_baseline_quotas/);
});
test('Owner and Admin manage branches and warehouses through secured RPCs in the settings UI',()=>{
 assert.match(service,/saveSaasBranch[\s\S]*rpc_upsert_organization_branch/);
 assert.match(service,/saveSaasWarehouse[\s\S]*rpc_upsert_organization_warehouse/);
 assert.match(workspace,/renderLocationManagement/);
 assert.match(workspace,/role === 'owner' \|\| role === 'admin'/);
 assert.match(html,/id="location-management-section"/);
 assert.match(html,/id="branch-management-form"/);
 assert.match(html,/id="warehouse-management-form"/);
});
test('branch and warehouse mutations are tenant-derived, role-bound and quota serialized',()=>{
 assert.match(migration,/rpc_upsert_organization_branch/);
 assert.match(migration,/rpc_upsert_organization_warehouse/);
 assert.match(migration,/ARRAY\['owner','admin'\]/);
 assert.match(migration,/FOR UPDATE/);
 assert.match(migration,/limits->>'branches'/);
 assert.match(migration,/limits->>'warehouses'/);
 assert.match(integration,/other_tenant_cannot_update_branch/);
 assert.match(integration,/cross_tenant_branch_link_is_rejected/);
});
test('default locations remain active and direct table writes are not opened',()=>{
 assert.match(migration,/Default branch must be active/);
 assert.match(migration,/Default warehouse must be active/);
 assert.doesNotMatch(migration,/GRANT\s+(?:INSERT|UPDATE|DELETE).*organization_(?:branches|warehouses).*authenticated/is);
 assert.match(integration,/default_branch_cannot_be_deactivated_directly/);
});

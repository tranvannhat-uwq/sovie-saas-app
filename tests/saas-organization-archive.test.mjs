import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import test from 'node:test';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const migration=read('migrations/0078_organization_archive_workflow.sql');const integration=read('migrations/tests/saas_organization_archive_integration.sql');
const service=read('js/services/supabase.js');const workspace=read('js/components/workspaces.js');const html=read('index.html');
test('archive requires Owner, exact slug, backup evidence and completed retention',()=>{
 assert.match(migration,/ARRAY\['owner'\]/);assert.match(migration,/confirmation_slug/);assert.match(migration,/backup_reference/);assert.match(migration,/read_only_ends_at>now\(\)/);assert.match(integration,/early_archive_is_blocked/);assert.match(integration,/admin_cannot_request_archive/);
});
test('Owner UI submits only the request RPC and explains soft archive',()=>{
 assert.match(service,/requestSaasOrganizationArchive[\s\S]*rpc_request_organization_archive/);assert.match(workspace,/renderOrganizationArchiveManagement/);assert.match(workspace,/organizationRole === 'owner'/);assert.match(html,/id="organization-archive-section"/);assert.match(html,/không xóa vật lý dữ liệu/i);
});
test('archive execution is service-only, idempotent and never deletes tenant rows',()=>{
 assert.match(migration,/auth\.role\(\)<>'service_role'/);assert.match(migration,/completed_event_key/);assert.match(migration,/'dataDeleted',false/);assert.doesNotMatch(migration,/DELETE\s+FROM/i);assert.match(integration,/browser_cannot_apply_archive/);assert.match(integration,/service_retry_is_idempotent/);
});

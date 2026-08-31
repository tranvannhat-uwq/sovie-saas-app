import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('migrations/0076_tenant_backup_inventory.sql');
const hotfix=read('migrations/0077_backup_inventory_membership_hotfix.sql');
const integration=read('migrations/tests/saas_tenant_backup_inventory_integration.sql');
const backup=read('js/services/backup.js');

test('backup inventory is tenant-derived and restricted to workspace managers',()=>{
 assert.match(migration,/rpc_my_backup_inventory/);
 assert.match(migration,/current_organization_id\(\)/);
 assert.match(migration,/ARRAY\['owner','admin'\]/);
 assert.match(migration,/WHERE organization_id=\$1/);
 assert.match(integration,/switch_changes_inventory_scope/);
 assert.match(integration,/sale_is_denied/);
 assert.match(integration,/anon_is_denied/);
 assert.match(hotfix,/membership\.auth_user_id/);
});

test('SaaS backup binds metadata and manifest to the active organization',()=>{
 assert.match(backup,/saas-tenant-v1/);
 assert.match(backup,/organization_id/);
 assert.match(backup,/state\.activeOrganizationId/);
 assert.match(backup,/manifest/i);
});

# P0 backup and staging deployment

Nothing in this guide authorizes a production deployment. Perform the complete
procedure on a staging clone first.

For Auth/profile diagnosis and manual administrator linking, also follow
`docs/P0_PROFILE_BOOTSTRAP_STAGING.md`.

## 1. Freeze and inventory

Record the Supabase project ref, Postgres version, deployment SHA, UTC time,
row counts for all business tables, installed extensions, policies, function
definitions, and the contents of `public.schema_migrations` if it exists.

Capture the supplied read-only inventory (the `users` query can be skipped on
a clean database where that legacy table does not exist):

```powershell
psql $env:P0_STAGING_DATABASE_URL `
  --file .\scripts\p0-preflight-inventory.sql `
  --output .\p0-preflight-inventory.txt
```

Do not run `update_supabase_schema.sql` or another root-level legacy SQL file.

## 2. Create two independent backups

Use the direct/session-pooler Postgres connection string from Supabase. Never
place the database password or a service-role key in source control.

PowerShell:

```powershell
$env:P0_DATABASE_URL = 'postgresql://...'
./scripts/backup-p0-database.ps1 -OutputDirectory 'D:\secure-backups\weblendon-p0'
```

The script creates:

- a custom-format full dump for reliable restore;
- a plain SQL full dump for inspection/emergency portability;
- a plain SQL schema-only dump for review;
- a checksum manifest.

Also take a Supabase Dashboard database backup/PITR snapshot when the project
plan supports it. Store backups outside the repository and test-restore the
custom dump before migration.

## 3. Restore a staging clone

Create an isolated Postgres/Supabase project, restore the custom dump, and
verify table row counts. Disable outbound integrations and use test Auth users.

```powershell
pg_restore --clean --if-exists --no-owner --no-privileges `
  --dbname $env:P0_STAGING_DATABASE_URL '.\backup.full.dump'
```

Before switching the frontend, create/invite a Supabase Auth identity for each
legacy interactive user. Require password reset; do not copy `users.password`
into Auth. Match `profiles.auth_user_id` to `auth.users.id`. Any unmatched
legacy profile remains inactive for login by design.

For the first administrator on a clean staging project, use the exact Auth UUID
shown in Supabase Dashboard and run once as the database owner:

```sql
UPDATE public.profiles
SET role = 'admin', updated_at = now()
WHERE auth_user_id = '<EXACT-STAGING-AUTH-UUID>'::uuid;
```

Confirm exactly one row changed. Never derive this UUID from browser input.

## 4. Apply P0 migrations

Run the five files in `migrations/README.md` order. After every file:

```powershell
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\0001_core_schema_and_migration_registry.sql
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\0002_auth_profiles_and_rls.sql
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\0003_secure_rpc_boundary.sql
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\0004_lock_down_legacy_objects.sql
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f .\migrations\0005_profile_identity_integrity.sql
```

Use only a staging URL. Each file is transactional and `ON_ERROR_STOP` prevents
the next file from running after an error. Check the registry after every file:

```sql
SELECT version, description, applied_at
FROM public.schema_migrations
ORDER BY version;
```

No file should be partially copied into the SQL editor. Stop on the first
error; do not mark the version manually.

## 5. Verify staging

Run `migrations/tests/p0_security_integration.sql`. Then test login with one
Admin, one Accounting, and one Sale account whose `profiles.auth_user_id`
matches `auth.users.id`.

Compare pre/post row counts for customers, products, variants, price lists,
orders, order items, drafts, debt ledger, cashbook, returns, and inventory.
P0 is additive and must not reduce any count.

Run this twice: first against a clean Supabase staging project, then against a
separate staging clone restored from the current database backup. The clean run
proves bootstrap compatibility; the restored-clone run plus pre/post row counts
proves the upgrade path without deleting rows.

```powershell
psql $env:P0_STAGING_DATABASE_URL -v ON_ERROR_STOP=1 `
  -f .\migrations\tests\p0_security_integration.sql
```

If the preflight reports any `wl_*` table, stop. Export the real prefixed schema
and prepare a separately reviewed mapping migration; `0001` intentionally
refuses that unknown layout.

## 6. Restore drill

Restore the full dump into a second empty staging database. Confirm that Auth
identities, profiles, business row counts, functions, and RLS policies match
the pre-deploy inventory. A backup is not accepted until this drill succeeds.

## 7. Production gate

Production deployment requires a separate approval, maintenance window,
verified backup, tested restore, signed migration output, and a matching
frontend release. This repository change does not perform that deployment.

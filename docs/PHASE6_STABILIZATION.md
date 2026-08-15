# Phase 6: backup, restore, synchronization, performance and stabilization

## Safety boundary

- Supabase/PostgreSQL is authoritative. Browser cache is read-only fallback.
- Offline business writes are disabled until an idempotent outbox, row versions
  and conflict resolution exist.
- Excel export is a versioned inspection/export artifact. It is not replayed
  into the live database.
- A full restore is allowed only into a new, empty staging database.
- Inventory, production, KPI and payroll are outside this phase.

## Create a full database backup

Set `P0_DATABASE_URL` only in the current PowerShell process, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-p0-database.ps1 -OutputDirectory .\backups\phase6
```

The command creates a custom dump, full SQL, schema SQL and SHA-256 manifest.
Verify that every file is non-empty and keep the connection string out of logs
and source control.

## Restore into a new staging project

Never use the current production or staging database as the target. Create a
new Supabase staging project and verify its `public` schema is empty.

```powershell
$env:PHASE6_TARGET_DATABASE_URL = 'postgresql://...new-staging...'
$env:PHASE6_RESTORE_CONFIRM = 'RESTORE_NEW_STAGING'
powershell -ExecutionPolicy Bypass -File .\scripts\restore-phase6-staging.ps1 -BackupDirectory .\backups\phase6
```

The script verifies the checksum, refuses a non-empty `public` schema, restores
without changing the source database and prints core row counts.

## Excel dry-run

In the Admin settings screen:

1. Export the Phase 6 Excel file.
2. Select the file under “Kiểm tra file sao lưu”.
3. Run dry-run.
4. Review version, missing sheets, row counts and duplicate keys.

Dry-run never writes to Supabase. Use the database restore procedure above for
disaster recovery.

## Stabilization checks

1. Run `node --test tests/*.test.mjs`.
2. Run SQL integration tests only on the restored staging project.
3. Log in as Admin, Accounting and Sale and verify RLS boundaries.
4. Verify order confirmation, payment, cancellation, returns, purchases and all
   reversal ledger histories.
5. Compare source and restored row counts and financial totals before any later
   production rollout is approved.


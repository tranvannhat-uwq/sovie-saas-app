# Restore guidance for migration 0006

Do not roll back by deleting orders or business rows.

Before staging deployment, take the backup described in
`docs/P0_BACKUP_AND_STAGING.md`. If application verification fails, first roll
the frontend back to its previous version; the additive columns, indexes and
sequence are backward compatible.

To restore the previous RPC implementation, restore only the function
`public.rpc_confirm_order(jsonb)` from the pre-0006 schema-only backup. Do not
re-run a legacy root SQL bundle. Keep the new columns and any orders already
created through 0006 so their idempotency keys and snapshots are preserved.

If a full database restore is required, restore the staging backup into a new
Supabase project/database and switch staging configuration only after row-count
and checksum comparison. Never restore over production in place.

# Rollback policy

P0 deliberately does not provide a down migration that reopens `anon` access,
restores plaintext-password login, or recreates permissive policies. Such a
rollback would reintroduce the incident being fixed.

Before deployment, create both a custom-format full backup and a plain SQL
schema backup as documented in `docs/P0_BACKUP_AND_STAGING.md`.

If staging validation fails before traffic is switched:

1. Stop using the staging project.
2. Keep the failed database for diagnosis.
3. Restore the pre-deploy dump to a new isolated Supabase/Postgres project.
4. Point a staging build—not production—at the restored project and verify row
   counts/checksums.

If a production rollout is later approved, rollback must restore the complete
pre-deploy dump and the matching frontend build together. Do not selectively
run legacy root SQL files after P0.

Recovery by version:

- `0001`: do not drop additive columns/tables because existing installations
  may already depend on them; restore the full pre-migration dump.
- `0002`: do not reopen `anon` or restore plaintext login. Restore the full
  dump and matching pre-P0 frontend in an isolated project.
- `0003`: RPC bodies replace several conflicting legacy definitions. Restore
  the schema/full dump; do not replay one root-level `CREATE OR REPLACE` file.
- `0004`: function grants, view grants, actor/audit triggers, and policies are
  a single security boundary. Restore the complete dump rather than attempting
  a partial ACL rollback that could expose financial data.
- `0005`: the Auth foreign key and unique/role constraints protect identity
  integrity. Do not drop them as a login workaround. Restore the complete
  pre-0005 staging dump and matching frontend if validation fails.

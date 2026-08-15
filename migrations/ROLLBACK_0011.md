# Recovery for migration 0011

Migration 0011 does not modify business rows or monetary formulas. It recompiles
`public.rpc_confirm_order(jsonb)` with explicit PL/pgSQL variable-conflict
resolution and preserves `SECURITY DEFINER`, the safe `search_path`, and the
authenticated-only grant.

Do not restore the ambiguous pre-0011 function because it prevents order
finalization. If a later implementation replaces the RPC, deploy that corrected
function in a new migration and retain the migration history. For full staging
recovery, restore the verified pre-0009 backup into a separate project.

# Rollback migration 0075

Migration 0075 is additive and does not delete business data. Prefer rolling
back the frontend first so no new branch/warehouse mutations are submitted.

If the database API must be disabled, revoke `EXECUTE` on
`rpc_upsert_organization_branch` and `rpc_upsert_organization_warehouse` from
`authenticated`. Do not drop branch or warehouse rows created after deployment.

The plan rows and quota JSON should only be restored from the pre-deployment
staging backup after confirming no subscription has changed plan and no tenant
currently exceeds the old limits. A full restore must be rehearsed on a separate
staging project before any production rollout.

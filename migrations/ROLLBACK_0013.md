# Rollback 0013

Migration 0013 is additive and does not delete business data. Before applying it,
take a staging database dump. If application rollback is required:

1. Restore the frontend files from the same release as migration 0012.
2. Reapply the `rpc_cancel_cashbook_transaction`, `rpc_cancel_customer_payment`,
   `rpc_cancel_order`, and `p2_cashbook_response` definitions from migration 0007.
3. Revoke and drop `rpc_cancel_cashbook_entry(text,text)` and
   `p13_classify_cashbook(text)`.
4. Keep `operation_type`, `reference_type`, and `reference_id`. They are nullable
   compatibility metadata and leaving them in place is safer than dropping data.
5. Delete only version `0013` from `schema_migrations` after the old RPCs have
   been restored and verified.

If any cancellation was performed after 0013, do not restore only the schema.
Restore the full pre-deployment backup or review the appended reversal ledgers;
otherwise financial history and schema can become inconsistent.

# Rollback migration 0012

Do not drop Phase 5 tables after they contain payroll or commission data. Restore the pre-0012 backup if a full rollback is required.

For a non-destructive application rollback:

1. Revert the frontend to the previous release.
2. Revoke execute on the six `rpc_*phase5*` / payroll RPCs from `authenticated`.
3. Disable `p5_order_item_commission` only if no Phase 5 payroll period has been locked.
4. Keep `kpi_targets`, `payroll_periods`, `payroll_adjustments`, `payroll_entries` and commission rows for audit/recovery.
5. Record the rollback operator, reason and timestamp outside the affected database.

Never delete existing commission or payroll rows as part of rollback.

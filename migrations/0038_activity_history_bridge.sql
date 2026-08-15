BEGIN;

-- Bring the trustworthy, pre-Activity-Log audit trail into the read model.
-- Business tables and the legacy audit table are never updated or deleted.
-- Rows without a profile-backed actor are intentionally left untouched because
-- presenting them as a user action would create a false audit identity.
WITH cutoff AS (
  SELECT COALESCE(min(created_at), now()) AS first_native_activity
  FROM public.activity_logs
), ranked AS (
  SELECT
    audit.*,
    actor.id AS matched_profile_id,
    actor.auth_user_id AS matched_auth_user_id,
    actor.username AS matched_username,
    actor.display_name AS matched_name,
    actor.role AS matched_role,
    COALESCE(audit.new_data, audit.old_data, '{}'::jsonb) AS source,
    row_number() OVER (
      PARTITION BY audit.table_name, audit.record_id, audit.performed_by, date_trunc('second', audit.created_at)
      ORDER BY
        CASE WHEN upper(audit.action) IN ('INSERT', 'UPDATE', 'DELETE') THEN 2 ELSE 1 END,
        audit.created_at DESC,
        audit.id DESC
    ) AS operation_rank
  FROM public.audit_logs audit
  CROSS JOIN cutoff
  JOIN LATERAL (
    SELECT profile.*
    FROM public.profiles profile
    WHERE audit.performed_by IN (profile.auth_user_id::text, profile.id, profile.username)
    ORDER BY CASE WHEN audit.performed_by = profile.auth_user_id::text THEN 0 ELSE 1 END
    LIMIT 1
  ) actor ON true
  WHERE audit.created_at < cutoff.first_native_activity
    AND audit.table_name IN (
      'orders', 'draft_orders', 'customers', 'profiles', 'payments',
      'sales_returns', 'cashbook_transactions', 'suppliers', 'purchases',
      'products', 'brands', 'pricelists'
    )
), normalized AS (
  SELECT
    ranked.*,
    public.p36_activity_changes(
      COALESCE(ranked.old_data, '{}'::jsonb),
      COALESCE(ranked.new_data, '{}'::jsonb)
    ) AS diff
  FROM ranked
  WHERE operation_rank = 1
    AND upper(action) <> 'IMPORT_FINANCIAL_BASELINE'
)
INSERT INTO public.activity_logs (
  operation_key, actor_id, actor_profile_id, actor_username, actor_name, actor_role,
  action, module, target_type, target_id, target_name, order_id, customer_id,
  company_id, description, old_value, new_value, changes, metadata, created_at
)
SELECT
  'legacy-audit:' || id,
  matched_auth_user_id,
  matched_profile_id,
  matched_username,
  matched_name,
  matched_role,
  CASE table_name
    WHEN 'orders' THEN CASE
      WHEN upper(action) IN ('INSERT', 'CONFIRM') THEN 'create_order'
      WHEN upper(action) = 'DELETE' THEN 'delete_order'
      WHEN upper(action) LIKE '%CANCEL%' OR upper(action) LIKE '%REVERSE%' THEN 'cancel_order'
      WHEN upper(action) IN ('ANNOTATE', 'UPDATE_NOTES') THEN 'update_order_notes'
      WHEN diff ? 'status' THEN 'change_order_status'
      WHEN diff ? 'paid_amount' OR diff ? 'payment_status' OR diff ? 'payment_method' THEN 'confirm_payment'
      ELSE 'update_order' END
    WHEN 'draft_orders' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_draft_order' WHEN upper(action) = 'DELETE' THEN 'delete_draft_order' WHEN diff ? 'notes' AND (SELECT count(*) FROM jsonb_object_keys(diff)) = 1 THEN 'update_draft_order_notes' ELSE 'update_draft_order' END
    WHEN 'customers' THEN CASE WHEN upper(action) IN ('INSERT', 'QUICK_CREATE') THEN 'create_customer' WHEN upper(action) = 'DELETE' THEN 'delete_customer' ELSE 'update_customer' END
    WHEN 'profiles' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_employee' WHEN upper(action) = 'DELETE' THEN 'delete_employee' WHEN diff ? 'role' THEN 'change_employee_role' WHEN diff ? 'is_active' THEN 'change_employee_status' ELSE 'update_employee' END
    WHEN 'payments' THEN CASE WHEN upper(action) = 'INSERT' THEN 'confirm_payment' WHEN diff ? 'status' THEN 'change_payment_status' ELSE 'update_payment' END
    WHEN 'sales_returns' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_sales_return' WHEN upper(action) LIKE '%CANCEL%' OR upper(action) LIKE '%REVERSE%' THEN 'cancel_sales_return' ELSE 'update_sales_return' END
    WHEN 'cashbook_transactions' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_cashbook_transaction' WHEN upper(action) LIKE '%CANCEL%' OR upper(action) LIKE '%REVERSE%' THEN 'cancel_cashbook_transaction' ELSE 'update_cashbook_transaction' END
    WHEN 'suppliers' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_supplier' WHEN upper(action) = 'DELETE' THEN 'delete_supplier' ELSE 'update_supplier' END
    WHEN 'purchases' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_purchase' WHEN upper(action) LIKE '%CANCEL%' OR upper(action) LIKE '%REVERSE%' THEN 'cancel_purchase' ELSE 'update_purchase' END
    WHEN 'products' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_product' WHEN upper(action) = 'DELETE' THEN 'delete_product' ELSE 'update_product' END
    WHEN 'brands' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_brand' WHEN upper(action) = 'DELETE' THEN 'delete_brand' ELSE 'update_brand' END
    WHEN 'pricelists' THEN CASE WHEN upper(action) = 'INSERT' THEN 'create_pricelist' WHEN upper(action) = 'DELETE' THEN 'delete_pricelist' ELSE 'update_pricelist' END
  END,
  CASE table_name WHEN 'draft_orders' THEN 'orders' WHEN 'profiles' THEN 'employees' WHEN 'sales_returns' THEN 'returns' WHEN 'cashbook_transactions' THEN 'cashbook' ELSE table_name END,
  CASE table_name WHEN 'orders' THEN 'order' WHEN 'draft_orders' THEN 'draft_order' WHEN 'profiles' THEN 'employee' WHEN 'sales_returns' THEN 'sales_return' WHEN 'cashbook_transactions' THEN 'cashbook_transaction' ELSE rtrim(table_name, 's') END,
  COALESCE(record_id, source->>'id', id),
  COALESCE(source->>'customer_name', source->>'display_name', source->>'name', source->>'code', record_id),
  CASE
    WHEN table_name IN ('orders', 'draft_orders') THEN COALESCE(record_id, source->>'id')
    WHEN table_name = 'sales_returns' THEN COALESCE(source->>'sale_id', source->>'order_id')
    WHEN table_name IN ('payments', 'cashbook_transactions') THEN source->>'order_id'
    ELSE NULL
  END,
  CASE WHEN table_name = 'customers' THEN COALESCE(record_id, source->>'id') ELSE source->>'customer_id' END,
  source->>'company_id',
  'legacy:' || table_name || ':' || action || ':' || COALESCE(record_id, source->>'id', id),
  NULLIF(old_data, '{}'::jsonb),
  NULLIF(new_data, '{}'::jsonb),
  diff,
  jsonb_build_object('legacy', true, 'legacy_audit_id', id, 'legacy_action', action, 'table', table_name),
  created_at
FROM normalized
WHERE COALESCE(record_id, source->>'id', id) IS NOT NULL
ON CONFLICT (operation_key, module, target_type, target_id) DO NOTHING;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0038', 'Expose profile-attributed legacy audit history in Activity Log without changing business data')
ON CONFLICT(version) DO NOTHING;

COMMIT;

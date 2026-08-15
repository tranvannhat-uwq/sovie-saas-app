BEGIN;

-- Notes are operational annotations, not financial amendments. This RPC
-- updates only the note/audit metadata and never touches order status, totals,
-- customer debt, payments, returns, cashbook or commission ledgers.
CREATE OR REPLACE FUNCTION public.rpc_update_order_notes(
  p_order_id text,
  p_notes text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  target_order public.orders%ROWTYPE;
  normalized_notes text := btrim(COALESCE(p_notes, ''));
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: only Admin or Accounting may update order notes'
      USING ERRCODE = '42501';
  END IF;
  IF p_order_id IS NULL OR btrim(p_order_id) = '' THEN
    RAISE EXCEPTION 'Order id is required';
  END IF;
  IF length(normalized_notes) > 2000 THEN
    RAISE EXCEPTION 'Order notes cannot exceed 2000 characters';
  END IF;

  SELECT * INTO STRICT target_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF COALESCE(target_order.notes, '') IS NOT DISTINCT FROM normalized_notes THEN
    RETURN jsonb_build_object(
      'success', true,
      'unchanged', true,
      'order_id', target_order.id,
      'notes', normalized_notes,
      'status', target_order.status,
      'updated_at', target_order.updated_at
    );
  END IF;

  UPDATE public.orders
  SET notes = normalized_notes,
      updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = target_order.id;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'orders', 'UPDATE_NOTES', target_order.id,
    jsonb_build_object('notes', COALESCE(target_order.notes, '')),
    jsonb_build_object(
      'notes', normalized_notes,
      'status_unchanged', target_order.status,
      'financial_impact', false
    ),
    actor.auth_user_id::text, now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'unchanged', false,
    'order_id', target_order.id,
    'notes', normalized_notes,
    'status', target_order.status,
    'updated_at', now(),
    'financial_impact', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_order_notes(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_order_notes(text, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0029', 'Edit order notes independently without financial amendment')
ON CONFLICT (version) DO NOTHING;

COMMIT;

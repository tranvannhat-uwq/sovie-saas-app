BEGIN;

-- Allow Accounting to apply a per-line deduction to returned coloured goods.
-- The browser supplies only the percentage; quantities, original values, debt,
-- cash refund, revenue and commission effects remain authoritative in the DB.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_record_sales_return(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0055 stopped: rpc_record_sales_return(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%item_deduction_percent numeric;%' THEN
    RETURN;
  END IF;

  IF current_definition NOT LIKE '%target_order_id text :=%'
     OR current_definition NOT LIKE '%line_refund := cumulative_amount - previous_cumulative_amount;%'
     OR current_definition NOT LIKE '%''canonical'', 0, CASE WHEN item_quantity = 0 THEN 0 ELSE line_refund / item_quantity END%'
     OR current_definition NOT LIKE '%returned_amount = cumulative_amount,%' THEN
    RAISE EXCEPTION 'Migration 0055 stopped: record-return function was not recognized';
  END IF;

  patched_definition := replace(current_definition,
    'item_quantity numeric;',
    'item_quantity numeric;' || chr(10) || '  item_deduction_percent numeric;' || chr(10) ||
    '  previous_returned_amount numeric;');

  patched_definition := replace(patched_definition,
    '''quantity'', round(COALESCE(NULLIF(item->>''quantity'', '''')::numeric, 0), 6)',
    '''quantity'', round(COALESCE(NULLIF(item->>''quantity'', '''')::numeric, 0), 6),' || chr(10) ||
    '    ''deductionPercent'', round(COALESCE(NULLIF(item->>''deductionPercent'', '''')::numeric, 0), 4)');

  patched_definition := replace(patched_definition,
    'item_quantity := COALESCE((input_item->>''quantity'')::numeric, 0);',
    'item_quantity := COALESCE((input_item->>''quantity'')::numeric, 0);' || chr(10) ||
    '    item_deduction_percent := COALESCE((input_item->>''deductionPercent'')::numeric, 0);' || chr(10) ||
    '    IF item_deduction_percent < 0 OR item_deduction_percent > 100 THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Return deduction percentage must be between 0 and 100'';' || chr(10) ||
    '    END IF;');

  patched_definition := replace(patched_definition,
    '    IF item_quantity > COALESCE(order_item.quantity, 0) - previous_quantity THEN',
    '    SELECT COALESCE(sum(previous_item.subtotal), 0) INTO previous_returned_amount' || chr(10) ||
    '    FROM public.sales_return_items previous_item' || chr(10) ||
    '    JOIN public.sales_returns previous_return ON previous_return.id = previous_item.return_id' || chr(10) ||
    '    WHERE previous_return.sale_id = sale.id' || chr(10) ||
    '      AND previous_return.status NOT IN (''cancelled'', ''canceled'')' || chr(10) ||
    '      AND previous_item.sale_item_id = order_item.id;' || chr(10) ||
    '    IF item_quantity > COALESCE(order_item.quantity, 0) - previous_quantity THEN');

  patched_definition := replace(patched_definition,
    '    v_total_refund := v_total_refund + line_refund;',
    '    line_refund := round(line_refund * (100 - item_deduction_percent) / 100);' || chr(10) ||
    '    v_total_refund := v_total_refund + line_refund;');

  patched_definition := replace(patched_definition,
    '''canonical'', 0, CASE WHEN item_quantity = 0 THEN 0 ELSE line_refund / item_quantity END,',
    '''return_deduction_percent'', item_deduction_percent, CASE WHEN item_quantity = 0 THEN 0 ELSE line_refund / item_quantity END,');

  patched_definition := replace(patched_definition,
    'returned_amount = cumulative_amount,',
    'returned_amount = previous_returned_amount + line_refund,');
  patched_definition := replace(patched_definition,
    'net_amount = GREATEST(0, item_cap - cumulative_amount)',
    'net_amount = GREATEST(0, item_cap - previous_returned_amount - line_refund)');

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%item_deduction_percent numeric;%'
     OR patched_definition NOT LIKE '%''deductionPercent'', round(%'
     OR patched_definition NOT LIKE '%previous_returned_amount numeric;%'
     OR patched_definition NOT LIKE '%SELECT COALESCE(sum(previous_item.subtotal), 0) INTO previous_returned_amount%'
     OR patched_definition NOT LIKE '%line_refund := round(line_refund * (100 - item_deduction_percent) / 100);%'
     OR patched_definition NOT LIKE '%returned_amount = previous_returned_amount + line_refund,%'
     OR patched_definition NOT LIKE '%net_amount = GREATEST(0, item_cap - previous_returned_amount - line_refund)%' THEN
    RAISE EXCEPTION 'Migration 0055 stopped: record-return patch was incomplete (declaration %, normalized input %, previous amount %, formula %, item totals %)',
      patched_definition LIKE '%item_deduction_percent numeric;%',
      patched_definition LIKE '%''deductionPercent'', round(%',
      patched_definition LIKE '%SELECT COALESCE(sum(previous_item.subtotal), 0) INTO previous_returned_amount%',
      patched_definition LIKE '%line_refund := round(line_refund * (100 - item_deduction_percent) / 100);%',
      patched_definition LIKE '%returned_amount = previous_returned_amount + line_refund,%';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

-- A cancelled return must restore the actual net values of the remaining
-- returns, including their deductions, instead of deriving value from quantity.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_cancel_sales_return(text,text)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0055 stopped: rpc_cancel_sales_return(text,text) is missing';
  END IF;

  IF current_definition LIKE '%sum(other_item.subtotal)%INTO remaining_amount%' THEN
    RETURN;
  END IF;

  IF current_definition NOT LIKE '%UPDATE public.order_items%returned_quantity = remaining_quantity,%returned_amount = remaining_amount,%' THEN
    RAISE EXCEPTION 'Migration 0055 stopped: cancel-return function was not recognized';
  END IF;

  patched_definition := replace(current_definition,
    '    UPDATE public.order_items',
    '    SELECT COALESCE(sum(other_item.subtotal), 0) INTO remaining_amount' || chr(10) ||
    '    FROM public.sales_return_items other_item' || chr(10) ||
    '    JOIN public.sales_returns other_return ON other_return.id = other_item.return_id' || chr(10) ||
    '    WHERE other_return.sale_id = sale.id' || chr(10) ||
    '      AND other_return.id <> sales_return.id' || chr(10) ||
    '      AND other_return.status NOT IN (''cancelled'', ''canceled'')' || chr(10) ||
    '      AND other_item.sale_item_id = order_item.id;' || chr(10) ||
    '    UPDATE public.order_items');

  patched_definition := replace(patched_definition,
    '    WHEN new_returned_amount = 0 THEN ''settled''',
    '    WHEN NOT EXISTS (' || chr(10) ||
    '      SELECT 1 FROM public.sales_return_items active_item' || chr(10) ||
    '      JOIN public.sales_returns active_return ON active_return.id = active_item.return_id' || chr(10) ||
    '      WHERE active_return.sale_id = sale.id' || chr(10) ||
    '        AND active_return.id <> sales_return.id' || chr(10) ||
    '        AND active_return.status NOT IN (''cancelled'', ''canceled'')' || chr(10) ||
    '        AND active_item.quantity > 0' || chr(10) ||
    '    ) THEN ''settled''');

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%sum(other_item.subtotal)%INTO remaining_amount%'
     OR patched_definition NOT LIKE '%active_item.quantity > 0%THEN ''settled''%' THEN
    RAISE EXCEPTION 'Migration 0055 stopped: cancel-return patch was incomplete';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

-- Include the saved deduction in both the immediate RPC response and later
-- reloads, using the existing immutable detail columns.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.p3_sales_return_response(text)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0055 stopped: p3_sales_return_response(text) is missing';
  END IF;

  IF current_definition LIKE '%''discountType'', item.discount_type%' THEN
    RETURN;
  END IF;

  patched_definition := replace(current_definition,
    '''refundPrice'', item.refund_price,',
    '''discountType'', item.discount_type,' || chr(10) ||
    '          ''discountValue'', COALESCE(item.discount_value, 0),' || chr(10) ||
    '          ''refundPrice'', item.refund_price,');

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%''discountValue'', COALESCE(item.discount_value, 0)%' THEN
    RAISE EXCEPTION 'Migration 0055 stopped: return response patch was incomplete';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

ALTER FUNCTION public.rpc_record_sales_return(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_record_sales_return(jsonb) SET search_path = pg_catalog, public;
ALTER FUNCTION public.rpc_cancel_sales_return(text, text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_cancel_sales_return(text, text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.p3_sales_return_response(text) SECURITY DEFINER;
ALTER FUNCTION public.p3_sales_return_response(text) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_sales_return(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.p3_sales_return_response(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sales_return(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.p3_sales_return_response(text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0055', 'Add authoritative per-item percentage deductions to sales returns')
ON CONFLICT (version) DO NOTHING;

COMMIT;

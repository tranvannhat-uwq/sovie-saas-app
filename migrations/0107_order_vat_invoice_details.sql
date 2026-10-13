BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS vat_details jsonb;
ALTER TABLE public.draft_orders
  ADD COLUMN IF NOT EXISTS vat_details jsonb;

-- Keep the established authoritative order transaction and wrap it so the
-- buyer/tax snapshot is saved atomically in the same database transaction.
ALTER FUNCTION public.rpc_confirm_order(jsonb)
  RENAME TO rpc_confirm_order_without_vat_details;
REVOKE ALL ON FUNCTION public.rpc_confirm_order_without_vat_details(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order_without_vat_details(jsonb)
  TO saas_rpc_executor;

CREATE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
#variable_conflict use_variable
DECLARE
  result jsonb;
  order_id text;
  requested_vat_details jsonb;
  saved_details jsonb;
  gross_amount numeric;
  expected_tax_base numeric;
  expected_tax_amount numeric;
  expected_total numeric;
  expected_other_fee numeric;
  changed_rows integer;
  effective_order jsonb;
  saved_items jsonb;
  line_item jsonb;
  line_count integer;
  line_index integer;
  line_base numeric;
  line_tax numeric;
  line_tax_sum numeric;
  vat_rounding_mode text;
BEGIN
  IF jsonb_typeof(p_order) <> 'object' THEN
    RAISE EXCEPTION 'Order payload must be an object';
  END IF;

  requested_vat_details := p_order->'vatDetails';
  IF requested_vat_details = 'null'::jsonb THEN requested_vat_details := NULL; END IF;

  IF requested_vat_details IS NOT NULL AND jsonb_typeof(requested_vat_details) <> 'object' THEN
    RAISE EXCEPTION 'VAT invoice details must be an object';
  END IF;
  IF COALESCE((requested_vat_details->>'enabled')::boolean, false) THEN
    IF NULLIF(btrim(requested_vat_details->>'buyerName'), '') IS NULL THEN
      RAISE EXCEPTION 'VAT buyer name is required';
    END IF;
    IF COALESCE((requested_vat_details->>'rate')::numeric, -1) < 0
       OR COALESCE((requested_vat_details->>'rate')::numeric, 101) > 100
       OR COALESCE(requested_vat_details->>'priceMode', '') NOT IN ('exclusive', 'inclusive') THEN
      RAISE EXCEPTION 'Invalid VAT rate or price mode';
    END IF;
  END IF;

  effective_order := p_order;
  vat_rounding_mode := COALESCE(requested_vat_details->>'roundingMode', 'invoice');
  IF COALESCE((requested_vat_details->>'enabled')::boolean, false)
     AND vat_rounding_mode = 'line' THEN
    IF requested_vat_details->>'priceMode' <> 'exclusive'
       OR p_order->>'pricelistId' <> 'retail'
       OR NOT COALESCE((p_order->>'manualPriceConfirmed')::boolean, false)
       OR COALESCE((p_order->>'discountValue')::numeric, 0) <> 0
       OR COALESCE((p_order->>'shippingFeeValue')::numeric,
                   (p_order->>'shippingFeeAmount')::numeric, 0) <> 0
       OR p_order->>'otherFeeType' <> 'percent'
       OR COALESCE((p_order->>'otherFeeValue')::numeric, -1)
          <> (requested_vat_details->>'rate')::numeric THEN
      RAISE EXCEPTION 'Line-rounded VAT requires confirmed retail manual prices with no invoice discount or shipping fee';
    END IF;
    IF jsonb_typeof(p_order->'items') IS DISTINCT FROM 'array'
       OR jsonb_typeof(requested_vat_details->'lineTaxBases') IS DISTINCT FROM 'array'
       OR jsonb_typeof(requested_vat_details->'lineTaxAmounts') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Line-rounded VAT requires one tax base and amount per order line';
    END IF;
    line_count := jsonb_array_length(p_order->'items');
    IF line_count = 0
       OR jsonb_array_length(requested_vat_details->'lineTaxBases') <> line_count
       OR jsonb_array_length(requested_vat_details->'lineTaxAmounts') <> line_count THEN
      RAISE EXCEPTION 'Line-rounded VAT does not match the order line count';
    END IF;

    line_tax_sum := 0;
    line_index := 0;
    FOR line_item IN SELECT value FROM jsonb_array_elements(p_order->'items') LOOP
      line_index := line_index + 1;
      IF COALESCE((line_item->>'discountPercent')::numeric, 0) <> 0
         OR COALESCE((line_item->>'discountValue')::numeric, 0) <> 0 THEN
        RAISE EXCEPTION 'Line-rounded VAT import does not allow discounted lines';
      END IF;
      line_base := round((line_item->>'quantity')::numeric
        * COALESCE((line_item->>'price')::numeric, (line_item->>'unitPrice')::numeric));
      line_tax := round(line_base * (requested_vat_details->>'rate')::numeric / 100);
      IF line_base IS DISTINCT FROM (requested_vat_details->'lineTaxBases'->>(line_index - 1))::numeric
         OR line_tax IS DISTINCT FROM (requested_vat_details->'lineTaxAmounts'->>(line_index - 1))::numeric THEN
        RAISE EXCEPTION 'Line-rounded VAT does not match the confirmed price on line %', line_index;
      END IF;
      line_tax_sum := line_tax_sum + line_tax;
    END LOOP;
    IF line_tax_sum <> COALESCE((requested_vat_details->>'taxAmount')::numeric, -1)
       OR COALESCE((requested_vat_details->>'taxBaseAmount')::numeric, -1)
          <> (SELECT sum((value)::numeric)
              FROM jsonb_array_elements_text(requested_vat_details->'lineTaxBases')) THEN
      RAISE EXCEPTION 'Line-rounded VAT totals do not match their line breakdown';
    END IF;

    -- The established RPC calculates percentage fees over the whole invoice.
    -- Pass the independently verified sum of per-line VAT as a fixed fee so
    -- the same authoritative transaction records the source invoice total.
    effective_order := jsonb_set(effective_order, '{otherFeeType}', to_jsonb('amount'::text), true);
    effective_order := jsonb_set(effective_order, '{otherFeeValue}', to_jsonb(line_tax_sum), true);
  END IF;

  result := public.rpc_confirm_order_without_vat_details(effective_order);
  order_id := NULLIF(result->>'order_id', '');
  IF order_id IS NULL THEN
    RETURN result;
  END IF;

  SELECT round(sale.subtotal - sale.discount_amount), sale.vat_details,
    sale.other_fee_amount, sale.items
  INTO gross_amount, saved_details, expected_other_fee, saved_items
  FROM public.orders sale
  WHERE sale.id = order_id
    AND sale.organization_id = public.current_organization_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Confirmed order was not found in the active workspace';
  END IF;

  IF COALESCE((requested_vat_details->>'enabled')::boolean, false) THEN
    IF vat_rounding_mode = 'line' THEN
      line_count := jsonb_array_length(saved_items);
      IF line_count <> jsonb_array_length(requested_vat_details->'lineTaxBases')
         OR line_count <> jsonb_array_length(requested_vat_details->'lineTaxAmounts') THEN
        RAISE EXCEPTION 'Confirmed order line count changed while validating VAT';
      END IF;
      line_tax_sum := 0;
      line_index := 0;
      FOR line_item IN SELECT value FROM jsonb_array_elements(saved_items) LOOP
        line_index := line_index + 1;
        line_base := (line_item->>'lineTotal')::numeric;
        line_tax := round(line_base * (requested_vat_details->>'rate')::numeric / 100);
        IF line_base IS DISTINCT FROM (requested_vat_details->'lineTaxBases'->>(line_index - 1))::numeric
           OR line_tax IS DISTINCT FROM (requested_vat_details->'lineTaxAmounts'->>(line_index - 1))::numeric THEN
          RAISE EXCEPTION 'Confirmed order VAT differs from source line %', line_index;
        END IF;
        line_tax_sum := line_tax_sum + line_tax;
      END LOOP;
      expected_tax_base := gross_amount;
      expected_tax_amount := line_tax_sum;
      expected_total := gross_amount + line_tax_sum;
      IF COALESCE(expected_other_fee, 0) <> line_tax_sum THEN
        RAISE EXCEPTION 'Confirmed order total does not include the verified line-rounded VAT';
      END IF;
    ELSIF requested_vat_details->>'priceMode' = 'inclusive' THEN
      expected_tax_base := round(gross_amount / (1 + (requested_vat_details->>'rate')::numeric / 100));
      expected_tax_amount := gross_amount - expected_tax_base;
      expected_total := gross_amount;
      IF COALESCE(expected_other_fee, 0) <> 0 THEN
        RAISE EXCEPTION 'VAT-inclusive prices cannot also add VAT as a separate fee';
      END IF;
    ELSE
      expected_tax_base := gross_amount;
      expected_tax_amount := round(gross_amount * (requested_vat_details->>'rate')::numeric / 100);
      expected_total := gross_amount + expected_tax_amount;
      IF effective_order->>'otherFeeType' <> 'percent'
         OR COALESCE((effective_order->>'otherFeeValue')::numeric, 0)
           <> (requested_vat_details->>'rate')::numeric
         OR COALESCE(expected_other_fee, 0) <> expected_tax_amount THEN
        RAISE EXCEPTION 'VAT-exclusive prices must use the selected rate in the order calculation';
      END IF;
    END IF;

    requested_vat_details := jsonb_set(requested_vat_details, '{taxBaseAmount}',
      to_jsonb(expected_tax_base), true);
    requested_vat_details := jsonb_set(requested_vat_details, '{taxAmount}',
      to_jsonb(expected_tax_amount), true);
    requested_vat_details := jsonb_set(requested_vat_details, '{totalWithVat}',
      to_jsonb(expected_total), true);
  END IF;

  IF COALESCE((result->>'already_finalized')::boolean, false) THEN
    SELECT sale.vat_details INTO saved_details
    FROM public.orders sale
    WHERE sale.id = order_id
      AND sale.organization_id = public.current_organization_id();

    IF saved_details IS DISTINCT FROM requested_vat_details THEN
      RAISE EXCEPTION '409: order was already finalized with different VAT details'
        USING ERRCODE = '23505';
    END IF;
  ELSE
    UPDATE public.orders sale
    SET vat_details = requested_vat_details
    WHERE sale.id = order_id
      AND sale.organization_id = public.current_organization_id();
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Could not save VAT details for the confirmed order';
    END IF;
    saved_details := requested_vat_details;
  END IF;

  RETURN jsonb_set(
    result,
    '{order,vatDetails}',
    COALESCE(saved_details, 'null'::jsonb),
    true
  );
END;
$function$;

-- Ownership transfer requires the target role to have CREATE on the function's
-- schema. Grant it only for this statement, then restore the executor's
-- restricted schema privileges.
GRANT CREATE ON SCHEMA public TO saas_rpc_executor;
ALTER FUNCTION public.rpc_confirm_order(jsonb) OWNER TO saas_rpc_executor;
REVOKE CREATE ON SCHEMA public FROM saas_rpc_executor;
REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;

DO $verification$
BEGIN
  IF NOT has_function_privilege(
    'authenticated', 'public.rpc_confirm_order(jsonb)', 'EXECUTE'
  ) OR has_function_privilege(
    'anon', 'public.rpc_confirm_order(jsonb)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Migration 0107 stopped: order confirmation grants are invalid';
  END IF;
  IF NOT has_function_privilege(
    'saas_rpc_executor',
    'public.rpc_confirm_order_without_vat_details(jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Migration 0107 stopped: internal order confirmation is not available to the tenant executor';
  END IF;
END;
$verification$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0107', 'Persist buyer and VAT invoice details on drafts and confirmed orders')
ON CONFLICT (version) DO NOTHING;

COMMIT;

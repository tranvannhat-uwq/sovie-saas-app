BEGIN;

ALTER TABLE public.pricelists
  ADD COLUMN IF NOT EXISTS is_print_only boolean NOT NULL DEFAULT false;

-- Mark the existing business "market price" lists. The explicit flag is the
-- durable rule; name/code matching is used only once to migrate current data.
UPDATE public.pricelists
SET is_print_only = true,
    updated_at = now()
WHERE lower(COALESCE(name, '')) LIKE '%thị trường%'
   OR lower(COALESCE(name, '')) LIKE '%thi truong%'
   OR regexp_replace(upper(COALESCE(code, '')), '[^A-Z0-9]+', '', 'g') LIKE '%THITRUONG%'
   OR regexp_replace(upper(COALESCE(code, '')), '[^A-Z0-9]+', '', 'g') LIKE '%MARKET%'
   OR regexp_replace(upper(COALESCE(name, '') || ' ' || COALESCE(code, '')), '[^A-Z0-9]+', '', 'g') LIKE '%TT20072026%';

CREATE OR REPLACE FUNCTION public.p27_reject_print_only_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  blocked_list_name text;
BEGIN
  SELECT price_list.name INTO blocked_list_name
  FROM public.pricelists price_list
  WHERE price_list.is_print_only IS TRUE
    AND (
      price_list.id = NULLIF(NEW.pricelist_id, '')
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(NEW.items) = 'array' THEN NEW.items ELSE '[]'::jsonb END
        ) item
        WHERE COALESCE(NULLIF(item->>'priceListId', ''), NULLIF(item->>'price_list_id', '')) = price_list.id
      )
    )
  LIMIT 1;

  IF blocked_list_name IS NOT NULL THEN
    RAISE EXCEPTION 'Bảng giá "%" chưa được Kế toán cho phép lưu; chỉ được in và không được phát sinh công nợ',
      blocked_list_name USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS p27_orders_reject_print_only_insert ON public.orders;
CREATE TRIGGER p27_orders_reject_print_only_insert
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.p27_reject_print_only_order();

DROP TRIGGER IF EXISTS p27_drafts_reject_print_only_insert ON public.draft_orders;
CREATE TRIGGER p27_drafts_reject_print_only_insert
BEFORE INSERT ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.p27_reject_print_only_order();

DROP TRIGGER IF EXISTS p27_drafts_reject_print_only_update ON public.draft_orders;
CREATE TRIGGER p27_drafts_reject_print_only_update
BEFORE UPDATE ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.p27_reject_print_only_order();

REVOKE ALL ON FUNCTION public.p27_reject_print_only_order() FROM PUBLIC, anon, authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pricelists'
      AND column_name = 'is_print_only'
  ) OR (
    SELECT count(*) FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'p27_orders_reject_print_only_insert',
        'p27_drafts_reject_print_only_insert',
        'p27_drafts_reject_print_only_update'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'Migration 0027 stopped: print-only order guards were not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0027', 'Make restricted price lists print-only and block order or debt persistence')
ON CONFLICT (version) DO NOTHING;

COMMIT;

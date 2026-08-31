BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0093') THEN
    RAISE EXCEPTION 'Migration 0094 requires migration 0093';
  END IF;
END;
$prerequisite$;

-- The customer form already treats the brand id as the canonical relation.
-- Keep the legacy name for display/import compatibility, while adding the
-- missing nullable key expected by every current browser write.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS assigned_brand_id text;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customers_assigned_brand_id_fkey'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_assigned_brand_id_fkey
      FOREIGN KEY (assigned_brand_id)
      REFERENCES public.brands(id)
      ON DELETE SET NULL;
  END IF;
END;
$constraint$;

UPDATE public.customers customer
SET assigned_brand_id = brand.id
FROM public.brands brand
WHERE customer.assigned_brand_id IS NULL
  AND customer.organization_id = brand.organization_id
  AND NULLIF(btrim(customer.assigned_brand), '') IS NOT NULL
  AND lower(btrim(customer.assigned_brand)) = lower(btrim(brand.name));

CREATE INDEX IF NOT EXISTS customers_organization_assigned_brand_idx
  ON public.customers (organization_id, assigned_brand_id);

INSERT INTO public.schema_migrations(version, description)
VALUES ('0094', 'Add the canonical customer assigned-brand relation required by browser writes')
ON CONFLICT (version) DO NOTHING;

COMMIT;

BEGIN;

-- Optional, brand-scoped text used only by the sales-invoice print template.
-- Existing orders and all financial calculations remain unchanged.
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS invoice_warehouse_text text;

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS sales_phone text;

UPDATE public.brands
SET invoice_warehouse_text = 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên'
WHERE NULLIF(BTRIM(invoice_warehouse_text), '') IS NULL;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0047', 'Add brand-scoped warehouse text and sales phone for invoice printing')
ON CONFLICT (version) DO NOTHING;

COMMIT;

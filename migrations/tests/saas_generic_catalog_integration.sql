-- Run only on isolated Supabase staging after migration 0062.
BEGIN;

CREATE TEMP TABLE catalog_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.catalog_results TO authenticated;
GRANT ALL ON TABLE pg_temp.catalog_results TO saas_rpc_executor;

INSERT INTO catalog_results
SELECT 'legacy_products_have_generic_units',
  count(*) > 0 AND bool_and(sell_unit_code = 'kg' AND purchase_unit_code = 'kg'),
  format('products=%s', count(*))
FROM public.products;

INSERT INTO catalog_results
SELECT 'order_pricing_uses_catalog_extension_hook',
  p.prosrc LIKE '%catalog_extension_adjustment_percent(''paint_color'', item)%'
    AND pg_get_userbyid(p.proowner) = 'saas_rpc_executor',
  format('owner=%s', pg_get_userbyid(p.proowner))
FROM pg_proc p WHERE p.oid = 'public.rpc_confirm_order(jsonb)'::regprocedure;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '62000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'catalog-a@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '62000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'catalog-b@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now());
UPDATE public.profiles SET role = 'admin', is_active = true
WHERE auth_user_id IN ('62000000-0000-4000-8000-000000000001'::uuid,
  '62000000-0000-4000-8000-000000000002'::uuid);
INSERT INTO public.organizations (id, slug, name, status) VALUES
  ('62000000-0000-4000-8000-000000000011', 'catalog-a', 'Catalog A', 'active'),
  ('62000000-0000-4000-8000-000000000012', 'catalog-b', 'Catalog B', 'active');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('62000000-0000-4000-8000-000000000011', '62000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('62000000-0000-4000-8000-000000000012', '62000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());

SET LOCAL ROLE saas_rpc_executor;
SELECT set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000001', true);
INSERT INTO catalog_results
SELECT 'generic_organization_has_no_paint_adjustment',
  public.catalog_extension_adjustment_percent(
    'paint_color', '{"colorCode":"RED-A"}'::jsonb
  ) = 0,
  'new organization must be industry-neutral';
RESET ROLE;

SET LOCAL ROLE authenticated;
INSERT INTO catalog_results
SELECT 'catalog_reads_are_tenant_scoped', count(*) = 10,
  format('visible_units=%s', count(*)) FROM public.catalog_units;
RESET ROLE;

INSERT INTO public.catalog_extensions (organization_id, extension_key, enabled, config)
VALUES ('62000000-0000-4000-8000-000000000011', 'paint_color', true,
  '{"input_field":"colorCode","suffix_adjustments":[{"suffix":"A","percent":25}]}'::jsonb);

SET LOCAL ROLE saas_rpc_executor;
SELECT set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000001', true);
INSERT INTO catalog_results
SELECT 'configured_extension_is_authoritative',
  public.catalog_extension_adjustment_percent(
    'paint_color', '{"colorCode":"RED-A"}'::jsonb
  ) = 25,
  'configured suffix A must produce 25 percent';
RESET ROLE;

SET LOCAL ROLE authenticated;
INSERT INTO catalog_results
SELECT 'catalog_context_returns_current_tenant_only',
  payload->>'organizationId' = '62000000-0000-4000-8000-000000000011'
    AND jsonb_array_length(payload->'units') = 10
    AND payload->'extensions'->'paint_color'->>'enabled' = 'true',
  format('payload=%s', payload)
FROM (SELECT public.rpc_my_catalog_context() payload) result;
RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM catalog_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Generic catalog tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE catalog_results;
ROLLBACK;

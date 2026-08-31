import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const migration = read('migrations/0084_momo_checkout_and_tax_policy.sql');
const checkout = read('supabase/functions/momo-create-checkout/index.ts');
const ipn = read('supabase/functions/momo-ipn/index.ts');
const service = read('js/services/supabase.js');
const workspace = read('js/components/workspaces.js');
const platform = read('js/components/platform-admin.js');
const html = read('index.html');

test('MoMo checkout amount is authoritative, VAT-explicit and provider bounded', () => {
  assert.match(migration, /billing_platform_settings/);
  assert.match(migration, /tax_mode IN \('exclusive','not_subject'\)/);
  assert.match(migration, /plan\.price_yearly ELSE plan\.price_monthly/);
  assert.match(migration, /round\(calculated_subtotal \* settings\.vat_rate \/ 100, 0\)/);
  assert.match(migration, /1,000 to 50,000,000 VND/);
  assert.match(migration, /public\.has_organization_role\(request\.organization_id, ARRAY\['owner'\]\)/);
});

test('MoMo create checkout signs official fields and never exposes credentials', () => {
  assert.match(checkout, /requestType = 'captureWallet'/);
  assert.match(checkout, /HMAC.*SHA-256|name: 'HMAC', hash: 'SHA-256'/);
  assert.match(checkout, /accessKey=\$\{accessKey\}&amount=\$\{amount\}&extraData=/);
  assert.match(checkout, /MOMO_SECRET_KEY/);
  assert.match(checkout, /rpc\('rpc_prepare_my_momo_checkout'/);
  assert.match(checkout, /rpc\('rpc_record_momo_checkout_response'/);
  assert.doesNotMatch(service, /MOMO_(?:SECRET_KEY|ACCESS_KEY|PARTNER_CODE)/);
});

test('MoMo IPN validates signature and applies only database-bound orders', () => {
  assert.match(ipn, /safeEqual\(suppliedSignature, expectedSignature\)/);
  assert.match(ipn, /payload\?\.partnerCode !== partnerCode/);
  assert.match(ipn, /rpc\('rpc_apply_momo_ipn'/);
  assert.match(ipn, /new Response\(null, \{ status: 204 \}\)/);
  assert.match(migration, /p_amount <> request\.total/);
  assert.match(migration, /p_result_code = 0/);
  assert.match(migration, /'momo-hmac-sha256'/);
});

test('platform config and tenant checkout are wired without enabling fake billing', () => {
  assert.match(html, /id="platform-billing-form"/);
  assert.match(platform, /updatePlatformBillingConfiguration/);
  assert.match(service, /functions\.invoke\('momo-create-checkout'/);
  assert.match(workspace, /window\.location\.assign\(result\.checkout\.payUrl\)/);
  assert.match(migration, /billing_enabled boolean NOT NULL DEFAULT false/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer Excel financials use a reviewed role-restricted RPC', () => {
  const sql = read('migrations/0015_customer_opening_financial_import.sql');
  assert.match(sql, /rpc_import_customer_financial_baselines\(p_rows jsonb\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /v_actor := public\.require_authenticated_profile\(\)/);
  assert.match(sql, /v_actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(sql, /jsonb_array_length\(p_rows\).*250/s);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_import_customer_financial_baselines\(jsonb\) FROM PUBLIC, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.rpc_import_customer_financial_baselines\(jsonb\) TO authenticated/);
});

test('re-import replaces only the prior imported contribution', () => {
  const sql = read('migrations/0015_customer_opening_financial_import.sql');
  assert.match(sql, /v_customer_row\.total_transaction[\s\S]*\+ v_imported_total - COALESCE\(v_customer_row\.imported_total_transaction_baseline, 0\)/);
  assert.match(sql, /v_customer_row\.total_return[\s\S]*\+ v_imported_returns - COALESCE\(v_customer_row\.imported_total_return_baseline, 0\)/);
  assert.match(sql, /v_customer_row\.net_revenue[\s\S]*\+ v_imported_net - COALESCE\(v_customer_row\.imported_net_revenue_baseline, 0\)/);
  assert.match(sql, /v_debt_delta := v_imported_debt - COALESCE\(v_customer_row\.imported_debt_baseline, 0\)/);
  assert.match(sql, /INSERT INTO public\.customer_debt_transactions/);
  assert.match(sql, /IMPORT_FINANCIAL_BASELINE/);
});

test('direct browser updates remain blocked after adding baseline columns', () => {
  const sql = read('migrations/0015_customer_opening_financial_import.sql');
  for (const column of [
    'imported_debt_baseline',
    'imported_total_transaction_baseline',
    'imported_total_return_baseline',
    'imported_net_revenue_baseline',
    'imported_created_at_baseline',
    'financial_baseline_imported_at'
  ]) {
    assert.match(sql, new RegExp(`NEW\\.${column} IS DISTINCT FROM OLD\\.${column}`));
  }
  assert.match(sql, /BEFORE UPDATE OF debt, total_transaction, total_return, net_revenue/);
});

test('frontend saves profiles, imports financial baselines, then verifies Cloud totals', () => {
  const customers = read('js/components/customers.js');
  const service = read('js/services/supabase.js');
  const profileSave = customers.indexOf('await dbSaveCustomersBulk(uniqueImportData)');
  const financialSave = customers.indexOf('await dbImportCustomerFinancialBaselines(uniqueImportData)');
  const cloudRefresh = customers.indexOf('await dbFetchCustomers()', financialSave);
  assert.ok(profileSave >= 0 && profileSave < financialSave && financialSave < cloudRefresh);
  assert.match(service, /rpc_import_customer_financial_baselines/);
  assert.match(service, /const chunkSize = 200/);
  assert.match(service, /Number\(data\.processed\)/);
  assert.match(customers, /calculateCustomerImportedBaselineTotals\(persistedImportData\)/);
  assert.match(service, /importedTotalTransactionBaseline: parseFloat\(cust\.imported_total_transaction_baseline \|\| 0\)/);
  assert.match(service, /importedCreatedAtBaseline: cust\.imported_created_at_baseline \|\| null/);
  assert.match(customers, /customerImportDatesMatch\(uniqueImportData, persistedImportData\)/);

  const mapper = service.slice(service.indexOf('function mapCustomerToDbRow'), service.indexOf('export async function dbSaveCustomer'));
  assert.doesNotMatch(mapper, /total_transaction|total_return|net_revenue|debt:/);
});

test('imported dates replace stale legacy dates but preserve newer authoritative orders', () => {
  const sql = read('migrations/0015_customer_opening_financial_import.sql');
  const service = read('js/services/supabase.js');
  assert.match(sql, /v_imported_created := NULLIF\(v_item->>'createdAt', ''\)::timestamptz/);
  assert.match(sql, /SELECT max\(COALESCE\(sale\.order_date, sale\.confirmed_at, sale\.created_at\)\)/);
  assert.match(sql, /GREATEST\(v_imported_last_order, v_operational_last_order\)/);
  assert.match(sql, /created_at = COALESCE\(v_imported_created, v_customer_row\.created_at\)/);
  assert.match(service, /createdAt: presence\.createdAt === false \? null : \(customer\.createdAt \|\| null\)/);
  assert.match(service, /Supabase RPC payload sample/);
});

test('customer Excel overwrite is explicit, verified before cleanup and never substitutes today for a supplied date', () => {
  const customers = read('js/components/customers.js');
  const service = read('js/services/supabase.js');
  const html = read('index.html');
  assert.match(customers, /input\[name="cust-import-mode"\]:checked/);
  assert.match(customers, /await dbDeleteCustomersBulk\(obsoleteCustomerIds\)/);
  assert.ok(customers.indexOf('customerImportDatesMatch') < customers.indexOf('await dbDeleteCustomersBulk(obsoleteCustomerIds)'));
  assert.match(customers, /Lịch sử đơn hàng vẫn được giữ nguyên/);
  assert.match(service, /export async function dbDeleteCustomersBulk/);
  assert.match(service, /\.delete\(\)[\s\S]*\.in\('id', chunk\)/);
  assert.doesNotMatch(customers, /c\.createdAt\s*=\s*c\.createdAt\s*\|\|\s*new Date/);
  assert.match(customers, /c\.createdAt = c\.createdAt \|\| null/);
  assert.match(html, /value="overwrite"/);
  assert.doesNotMatch(html, /value="overwrite"[^>]*disabled/);
});

test('blank imported fields preserve prior baselines and signed values are not clamped', () => {
  const customers = read('js/components/customers.js');
  const service = read('js/services/supabase.js');
  const sql = read('migrations/0015_customer_opening_financial_import.sql');
  assert.match(sql, /v_imported_last_order := COALESCE\(v_imported_last_order,[\s\S]*imported_last_order_at_baseline\)/);
  assert.match(sql, /v_imported_created := COALESCE\(v_imported_created,[\s\S]*imported_created_at_baseline\)/);
  assert.doesNotMatch(sql, /next_total := GREATEST/);
  assert.doesNotMatch(sql, /next_returns := GREATEST/);
  assert.doesNotMatch(sql, /next_net := GREATEST/);
  assert.match(customers, /const debtDays = Math\.trunc/);
  assert.match(customers, /hasStoredNetSales/);
  assert.match(service, /createdAt: presence\.createdAt === false \? null/);
  assert.match(service, /lastOrderAt: presence\.lastOrderAt === false \? null/);
  assert.match(service, /column reference \["'\]customer_id\["'\] is ambiguous/);
  assert.match(service, /Hãy chạy migration 0016 rồi nhập lại file/);
});

test('baseline RPC has no PL/pgSQL column-variable ambiguity', () => {
  const sql = read('migrations/0015_customer_opening_financial_import.sql');
  assert.match(sql, /#variable_conflict error/);
  assert.match(sql, /v_customer_id text/);
  assert.match(sql, /sale\.customer_id = v_customer_id/);
  assert.match(sql, /customer_source\.id = v_customer_id/);
  assert.doesNotMatch(sql, /^\s*customer_id text;/m);
  assert.doesNotMatch(sql, /sale\.customer_id = customer_id/);
});

test('deployed first-revision 0015 databases receive a guarded 0016 hotfix', () => {
  const sql = read('migrations/0016_customer_import_rpc_variable_conflict_fix.sql');
  assert.match(sql, /pg_get_functiondef\('public\.rpc_import_customer_financial_baselines\(jsonb\)'::regprocedure\)/);
  assert.match(sql, /#variable_conflict use_variable/);
  assert.match(sql, /v_customer_id text/);
  assert.match(sql, /sale\.customer_id = v_customer_id/);
  assert.match(sql, /procedure\.prosecdef/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_import_customer_financial_baselines\(jsonb\) FROM PUBLIC, anon/);
  assert.match(sql, /VALUES \('0016'/);
});

test('known manager and brand aliases do not block the real customer workbook', () => {
  const customers = read('js/components/customers.js');
  assert.match(customers, /\[originalTarget, aliases\[originalTarget\]\]/);
  assert.match(customers, /'festival nano': 'festiva nano'/);
  assert.match(customers, /'tddkaw nano': 'tdkaw nano'/);
  assert.ok(
    customers.indexOf('const exact = (state.users || []).filter')
      < customers.indexOf("const partial = (state.users || []).filter")
  );
});

test('unmatched optional associations are left blank without blocking the workbook', () => {
  const customers = read('js/components/customers.js');
  assert.match(customers, /const rowWarnings = \[\]/);
  assert.match(customers, /Không tìm thấy nhãn sơn .*; đã để trống/);
  assert.match(customers, /Không tìm thấy bảng giá .*; đã để trống/);
  assert.match(customers, /Không tìm thấy người quản lý .*; đã để trống/);
  assert.match(customers, /Unmatched optional associations left blank/);
  assert.doesNotMatch(customers, /Không tìm thấy nhãn sơn[^\n]+\n\s*continue/);
  assert.doesNotMatch(customers, /Không tìm thấy bảng giá[^\n]+\n\s*continue/);
  assert.doesNotMatch(customers, /Không tìm thấy duy nhất người quản lý[^\n]+\n\s*continue/);
  assert.match(customers, /notes,\n\s*pricelistId/);
});

test('imported last transaction display uses only the authoritative last_order_at field', () => {
  const customers = read('js/components/customers.js');
  const functionStart = customers.indexOf('function getCustomerLastTransactionDate(c)');
  const functionEnd = customers.indexOf('function getFilteredCustomersForCurrentView()', functionStart);
  const displayFunction = customers.slice(functionStart, functionEnd);
  assert.match(displayFunction, /if \(hasImportedBaseline\) return c\.lastOrderAt \|\| c\.last_order_at \|\| ''/);
  assert.ok(
    displayFunction.indexOf('if (hasImportedBaseline)')
      < displayFunction.indexOf('addDate(c.lastPaymentAt')
  );
  assert.match(displayFunction, /financialBaselineImportedAt/);
});

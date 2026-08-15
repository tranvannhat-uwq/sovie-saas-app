import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer screen and Excel export share one filtered and sorted row pipeline', () => {
  const customers = read('js/components/customers.js');
  const html = read('index.html');
  assert.match(customers, /return queryCustomerRows\(buildCustomerViewRows\(\), customerViewQuery\)/);
  assert.match(customers, /customerFilteredRows = filtered/);
  assert.match(customers, /if \(scope === 'page'\) return \[\.\.\.customerCurrentPageRows\]/);
  assert.match(customers, /if \(scope === 'selected'\) return customerFilteredRows\.filter/);
  assert.match(customers, /return \[\.\.\.customerFilteredRows\]/);
  assert.doesNotMatch(customers, /customerFilteredRows\.sort\(/);
  for (const id of ['customer-search-input', 'customer-advanced-filter-panel', 'customer-sort-key',
    'customer-status', 'customer-page-size', 'customer-list-export-modal',
    'customer-filter-drawer-backdrop', 'btn-close-customer-filter',
    'btn-reset-customer-filter-modal', 'btn-apply-customer-filter-modal']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(customers, /setTimeout\(\(\) => applyCustomerQueryChange\(\), 350\)/);
  assert.match(customers, /history\.replaceState/);
  assert.match(customers, /setFilterDrawerOpen/);
  assert.match(customers, /event\.key === 'Escape'/);
  assert.match(customers, /document\.body\.appendChild\(filterBackdrop\)/);
  assert.match(customers, /document\.body\.appendChild\(filterPanel\)/);
  assert.match(customers, /function renderCustomerMultiSelect/);
  assert.match(customers, /import \{[^}]*normalizeCustomerSearch[^}]*\} from '\.\.\/domain\/customer-query\.js'/);
  assert.match(customers, /renderCustomerMultiSelect\(id, placeholder, true\)/);
  assert.match(customers, /Không thể nạp lựa chọn cho/);
  assert.match(customers, /Object\.entries\(PROVINCES\)/);
  assert.match(customers, /\.\.\.\(state\.allPricelists \|\| \[\]\), \.\.\.\(state\.pricelists \|\| \[\]\)/);
  assert.match(customers, /Chưa có dữ liệu phù hợp/);
  assert.match(customers, /type="checkbox" data-option-index/);
  assert.match(customers, /select\.dispatchEvent\(new Event\('change'/);
  assert.doesNotMatch(html, /giữ Ctrl để chọn nhiều/);
  assert.match(read('style.css'), /\.customer-filter-modal-body[^}]*overflow-y:\s*auto/);
  const headerStart = html.indexOf('<section id="customers-panel"');
  const searchRow = html.indexOf('<div class="customer-query-toolbar">', headerStart);
  const sortRow = html.indexOf('<div class="customer-sort-toolbar"', searchRow);
  assert.ok(html.indexOf('id="btn-export-customers-excel"', headerStart) < searchRow);
  assert.ok(html.indexOf('id="customer-managed-filter"', searchRow) < sortRow);
  assert.ok(html.indexOf('id="btn-reset-customer-query"', searchRow) < sortRow);
  assert.ok(html.indexOf('id="customer-sort-nulls"', sortRow) > sortRow);
  assert.ok(html.indexOf('id="btn-customer-sort-direction"', sortRow) > sortRow);
});

test('customer export creates typed XLSX data, totals and filter metadata', () => {
  const customers = read('js/components/customers.js');
  assert.match(customers, /XLSX\.utils\.aoa_to_sheet\(matrix, \{ cellDates: true \}\)/);
  assert.match(customers, /sheet\['!autofilter'\]/);
  assert.match(customers, /sheet\['!freeze'\]/);
  assert.match(customers, /cell\.z = 'dd\/mm\/yyyy'/);
  assert.match(customers, /cell\.z = '#,##0;\[Red\]-#,##0'/);
  assert.match(customers, /cell\.t = 's'; cell\.z = '@'/);
  assert.match(customers, /TỔNG CỘNG/);
  assert.match(customers, /ThongTinBoLoc/);
  assert.match(customers, /DanhSachKhachHang_\$\{stamp\}\.xlsx/);
});

test('RLS-scoped customer state is paged beyond the Supabase 1000-row default', () => {
  const service = read('js/services/supabase.js');
  const rls = read('migrations/0002_auth_profiles_and_rls.sql');
  assert.match(service, /const pageSize = 1000/);
  assert.match(service, /\.select\(columns, \{ count: 'exact' \}\)/);
  assert.match(service, /fetchFullTableData\(tableCustomersName, CUSTOMER_LIST_COLUMNS\)/);
  assert.doesNotMatch(service, /CUSTOMER_LIST_COLUMNS[\s\S]{0,1000}'debt_history'/);
  assert.match(service, /collectAllPages\(\(offset, end\) => supabaseClient/);
  assert.match(service, /\.range\(offset, end\), pageSize\)/);
  assert.match(service, /const customerData = await fetchFullTableData\(tableCustomersName, CUSTOMER_LIST_COLUMNS\)/);
  assert.doesNotMatch(service, /p_search: '', p_managed_by: null, p_limit: 10000, p_offset: 0/);
  assert.match(rls, /CREATE POLICY customers_select ON public\.customers FOR SELECT TO authenticated/);
  assert.match(rls, /customer\.managed_by = auth\.uid\(\)::text/);
  assert.doesNotMatch(customersOrEmpty(), /service_role/i);
});

function customersOrEmpty() {
  return read('js/components/customers.js');
}

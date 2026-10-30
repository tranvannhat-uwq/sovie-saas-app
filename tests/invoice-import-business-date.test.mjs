import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseInvoiceImportRows } from '../js/domain/invoice-excel-import.js';
import { orderDateToInputValue, parseOrderBusinessDateInput } from '../js/domain/order-business-date.js';

// Exercise the production mapper without initializing the browser/cloud client.
const source = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
const start = source.indexOf('function mapOrderRowForState(');
const end = source.indexOf('\nfunction getCurrentLocalWeekRange(', start);
assert.ok(start >= 0 && end > start);
const mapOrder = new Function('resolveWorkspaceCompanyId', `${source.slice(start, end)}; return mapOrderRowForState;`)(value => value);

test('Excel date survives draft reload, editor hydration and confirmation date parsing', () => {
  const parsed = parseInvoiceImportRows([
    ['MaHD', 'NgayHoaDon', 'MaHang', 'TenHangHoa', 'SoLuong', 'DonGia', 'ThanhTien', 'ThueSuat', 'TienThue'],
    ['66', '29/10/2026', 'SKU-1', 'Sơn', 1, 100, 100, 8, 8]
  ]);
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.groups[0].issues, []);
  const stored = {
    id: 'EXL-test', status: 'draft', items: [],
    created_at: parsed.groups[0].date,
    // draft_orders can inherit this default from orders INCLUDING DEFAULTS.
    order_date: '2026-10-30T04:00:00.000Z'
  };
  const loaded = mapOrder(stored, true);
  assert.equal(loaded.date, '2026-10-29T12:00:00.000Z');
  const input = orderDateToInputValue(loaded.date);
  assert.equal(input, '2026-10-29');
  const confirmed = parseOrderBusinessDateInput(input, new Date('2026-10-30T04:00:00Z'));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.dateKey, '2026-10-29');
});

test('drafts support schemas without order_date and fall back when created_at is absent', () => {
  assert.equal(mapOrder({ items: [], created_at: '2026-10-29T12:00:00Z' }, true).date, '2026-10-29T12:00:00Z');
  assert.equal(mapOrder({ items: [], order_date: '2026-10-28T12:00:00Z' }, true).date, '2026-10-28T12:00:00Z');
});

test('finalized orders keep their business date ahead of the audit creation timestamp', () => {
  assert.equal(mapOrder({
    items: [], status: 'settled',
    order_date: '2026-10-29T12:00:00Z', created_at: '2026-10-30T04:00:00Z'
  }, false).date, '2026-10-29T12:00:00Z');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvoiceImportFingerprint,
  buildInvoiceImportIdentity,
  findInvoiceImportProductMatches,
  parseInvoiceImportNumber,
  parseInvoiceImportRows,
  stableInvoiceImportUuid
} from '../js/domain/invoice-excel-import.js';

const headers = [
  'MaHD', 'NgayHoaDon', 'MaHang', 'TenHangHoa', 'DVT', 'SoLuong',
  'DonGia', 'ThanhTien', 'ThueSuat', 'TienThue', 'TenDonVi',
  'MaSoThue', 'DiaChiKhachHang', 'PhuongThucThanhToan', 'GhiChu'
];

function row({ invoice = 'HD-1', date = '13/10/2026', code = 'SKU-1', name = 'Vật tư', unit = 'kg', quantity = 1, price = 5, amount = price * quantity, rate = 10, tax = Math.round(amount * rate / 100, 0), ...extra } = {}) {
  return [invoice, date, code, name, unit, quantity, price, amount, rate, tax,
    extra.buyer || 'Công ty mẫu', extra.taxCode || '0100000000', 'Địa chỉ mẫu', 'Chuyển khoản', extra.notes || ''];
}

test('parses Vietnamese money separators and builds groups by invoice and date', () => {
  assert.equal(parseInvoiceImportNumber('1.522.554'), 1522554);
  assert.equal(parseInvoiceImportNumber('1,522,554'), 1522554);
  assert.equal(parseInvoiceImportNumber('1522554,50'), 1522554.5);

  const parsed = parseInvoiceImportRows([
    headers,
    row({ invoice: 'A', amount: 1200, price: 1200, rate: 8, tax: 96 }),
    row({ invoice: 'A', code: 'SKU-2', amount: 500, price: 500, rate: 8, tax: 40 }),
    row({ invoice: 'B', date: '14/10/2026', amount: 700, price: 700, rate: 8, tax: 56 }),
    [],
    [null, null, null]
  ]);

  assert.equal(parsed.error, '');
  assert.equal(parsed.dataRowCount, 3);
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.groups[0].netAmount, 1700);
  assert.equal(parsed.groups[0].taxAmount, 136);
  assert.equal(parsed.groups[0].date.slice(0, 10), '2026-10-13');
  assert.equal(parsed.groups[1].date.slice(0, 10), '2026-10-14');
});

test('preserves per-line VAT rounding instead of recomputing on the invoice total', () => {
  const parsed = parseInvoiceImportRows([
    headers,
    row({ invoice: 'ROUND', price: 5, amount: 5, rate: 10, tax: 1 }),
    row({ invoice: 'ROUND', code: 'SKU-2', price: 5, amount: 5, rate: 10, tax: 1 })
  ]);
  const [group] = parsed.groups;
  assert.equal(group.netAmount, 10);
  assert.equal(group.taxAmount, 2);
  assert.equal(Math.round(group.netAmount * group.rate / 100), 1);
  assert.deepEqual(group.lineTaxBases, [5, 5]);
  assert.deepEqual(group.lineTaxAmounts, [1, 1]);
  assert.equal(JSON.parse(buildInvoiceImportFingerprint(group)).lines.length, 2);
});

test('blocks mismatched totals, mismatched VAT, discounts, mixed rates, and inconsistent buyers', () => {
  const parsed = parseInvoiceImportRows([
    [...headers, 'GiamTruHoaDon'],
    [...row({ invoice: 'BAD', amount: 90, price: 100, tax: 8 }), 10],
    [...row({ invoice: 'BAD', code: 'SKU-2', amount: 100, price: 100, tax: 8, rate: 8, buyer: 'Khách khác' }), 0]
  ]);
  const [group] = parsed.groups;
  assert.ok(group.issues.some(issue => issue.includes('không khớp thành tiền')));
  assert.ok(group.issues.some(issue => issue.includes('không khớp cách làm tròn')));
  assert.ok(group.issues.some(issue => issue.includes('chiết khấu')));
  assert.ok(group.issues.some(issue => issue.includes('nhiều thuế suất')));
  assert.ok(group.issues.some(issue => issue.includes('Tên đơn vị mua không nhất quán')));
});

test('requires a unique active exact SKU match for automatic product mapping', () => {
  const products = [
    { id: 'one', code: 'SKU-1', isActive: true },
    { id: 'two', code: 'SKU-1', isActive: true },
    { id: 'inactive', code: 'SKU-1', isActive: false },
    { id: 'other', code: 'SKU-2', isActive: true }
  ];
  assert.equal(findInvoiceImportProductMatches({ code: 'SKU-2' }, products).length, 1);
  assert.equal(findInvoiceImportProductMatches({ code: 'sku-1' }, products).length, 2);
  assert.equal(findInvoiceImportProductMatches({ code: 'SKU-3' }, products).length, 0);
});

test('accepts alternate tax and discount columns while checking every populated discount field', () => {
  const sourceHeaders = [...headers, 'ThueSuatKhac', 'GiamTruTungDongHangHoa', 'TienGiamTru', 'TyLe%ChietKhau', 'TienChietKhau', 'TenNguoiGuiHang', 'MaSoThueNguoiGuiHang'];
  const parsed = parseInvoiceImportRows([
    sourceHeaders,
    [...row({ invoice: 'ALT', price: 100, amount: 100, rate: 8, tax: 8 }), null, 0, 0, 0, 0, 'Đơn vị bán mẫu', '0100000001']
  ]);
  assert.equal(parsed.error, '');
  assert.equal(parsed.groups[0].issues.length, 0);
  assert.equal(parsed.groups[0].issuerName, 'Đơn vị bán mẫu');
  assert.equal(parsed.groups[0].issuerTaxCode, '0100000001');

  const discounted = parseInvoiceImportRows([
    sourceHeaders,
    [...row({ invoice: 'ALT', price: 100, amount: 100, rate: 8, tax: 8 }), null, 0, 0, 0, 1, '', '']
  ]);
  assert.ok(discounted.groups[0].issues.some(issue => issue.includes('chiết khấu')));
});

test('builds a stable workspace-scoped import identity and a valid retry UUID', () => {
  const group = { issuerTaxCode: '010-100', invoiceNumber: '1325', date: '2026-10-13T12:00:00.000Z', buyerTaxCode: ' 010.20 ', buyerCompany: 'Công ty Mẫu' };
  const equivalent = { ...group, issuerTaxCode: '010100', buyerTaxCode: '01020', buyerCompany: 'CÔNG TY   MẪU' };
  assert.equal(buildInvoiceImportIdentity(group, 'workspace-a'), buildInvoiceImportIdentity(equivalent, 'workspace-a'));
  assert.notEqual(buildInvoiceImportIdentity(group, 'workspace-a'), buildInvoiceImportIdentity(group, 'workspace-b'));
  const uuid = stableInvoiceImportUuid('0123456789abcdef0123456789abcdef');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => stableInvoiceImportUuid('not-a-digest'));
});

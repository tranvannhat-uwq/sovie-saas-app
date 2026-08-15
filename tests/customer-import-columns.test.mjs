import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCustomerImportColumnMap,
  CUSTOMER_IMPORT_COLUMNS,
  normalizeExcelHeader,
  normalizeExcelSheetName
} from '../js/domain/customer-import-columns.js';

const realHeaders = [
  'Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'Địa chỉ', 'Nhãn sơn',
  'Bảng giá', 'Người quản lý', 'Tổng doanh số', 'Tổng giá trị trả hàng',
  'Doanh số sau trả', 'Công nợ hiện tại', 'Ngày giao dịch cuối', 'Ngày tạo',
  'Số ngày nợ', 'Ghi chú'
];

test('real customer workbook headers map all 15 columns by normalized name', () => {
  const result = buildCustomerImportColumnMap(realHeaders);
  assert.equal(CUSTOMER_IMPORT_COLUMNS.length, 15);
  assert.deepEqual(Object.values(result.columns), Array.from({ length: 15 }, (_, index) => index));
  assert.equal(result.details.createdAt.databaseField, 'customers.created_at');
  assert.equal(result.details.lastTransactionAt.databaseField, 'customers.last_order_at');
  assert.notEqual(result.columns.createdAt, result.columns.lastTransactionAt);
});

test('header normalization tolerates BOM, whitespace, line breaks, case and Vietnamese accents', () => {
  assert.equal(normalizeExcelHeader('\uFEFF  NGÀY\n   TẠO  '), 'ngay tao');
  assert.equal(normalizeExcelHeader('ngày tạo'), 'ngay tao');
  assert.equal(normalizeExcelSheetName(' Danh Sach Khach Hang '), 'danhsachkhachhang');
});

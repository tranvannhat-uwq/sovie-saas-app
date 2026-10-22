import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePurchaseSupplierDetails } from '../js/domain/purchase-supplier.js';

test('historical purchases keep supplier identity when supplier is inactive', () => {
  const supplierDirectory = [
    { id: 'supplier-1', code: 'QA-NCC-1', name: 'Nhà cung cấp QA đã ngừng dùng', isActive: false }
  ];
  assert.deepEqual(resolvePurchaseSupplierDetails({ supplierId: 'supplier-1' }, supplierDirectory), {
    supplierName: 'Nhà cung cấp QA đã ngừng dùng',
    supplierCode: 'QA-NCC-1'
  });
});

test('purchase display falls back to its stored supplier snapshot when directory row is absent', () => {
  assert.deepEqual(resolvePurchaseSupplierDetails({
    supplier_id: 'supplier-removed',
    supplier_name: 'Tên đã lưu trong phiếu',
    supplier_code: 'OLD-01'
  }, []), {
    supplierName: 'Tên đã lưu trong phiếu',
    supplierCode: 'OLD-01'
  });
});

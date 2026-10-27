import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { filterSuppliersForExport, parseSupplierRows, suggestNextSupplierCode } from '../js/domain/supplier-excel.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const component = await readFile(new URL('../js/components/suppliers.js', import.meta.url), 'utf8');

test('supplier Excel import maps normalized Vietnamese headers and preserves phone strings', () => {
  const parsed = parseSupplierRows([
    ['Mã nhà cung cấp', 'Tên nhà cung cấp', 'Điện thoại', 'Địa chỉ', 'Ghi chú'],
    ['ncc-001', 'Nhà cung cấp A', '0900123456', 'Hà Nội', 'Giao buổi sáng']
  ]);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.records, [{
    code: 'NCC-001', name: 'Nhà cung cấp A', phone: '0900123456', address: 'Hà Nội', notes: 'Giao buổi sáng'
  }]);
});

test('supplier import reports missing required columns, incomplete rows and duplicate codes before saving', () => {
  assert.match(parseSupplierRows([['Tên'], ['Nhà cung cấp A']]).errors[0], /Mã nhà cung cấp/);
  const parsed = parseSupplierRows([
    ['Ma NCC', 'Ten NCC'],
    ['NCC01', 'Nhà cung cấp A'],
    ['ncc01', 'Nhà cung cấp trùng'],
    ['', 'Thiếu mã']
  ]);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.errors, [
    'Dòng 3: mã NCC01 bị lặp trong tệp.',
    'Dòng 4: cần có mã và tên nhà cung cấp.'
  ]);
});

test('supplier export uses the filtered full list sorted by Vietnamese supplier name', () => {
  const suppliers = [
    { code: 'NCC02', name: 'Công ty B', phone: '0902' },
    { code: 'NCC01', name: 'Công ty A', phone: '0901' },
    { code: 'NCC03', name: 'Nhà cung cấp C', phone: '0903' }
  ];
  assert.deepEqual(filterSuppliersForExport(suppliers).map(item => item.code), ['NCC01', 'NCC02', 'NCC03']);
  assert.deepEqual(filterSuppliersForExport(suppliers, '0903').map(item => item.code), ['NCC03']);
});

test('new supplier code skips existing generated codes without relying on list length', () => {
  assert.equal(suggestNextSupplierCode([{ code: 'NCC001' }, { code: 'NCC003' }]), 'NCC002');
  assert.equal(suggestNextSupplierCode([{ code: 'custom-code' }]), 'NCC001');
});

test('supplier panel exposes template, export, import and manual-create actions', () => {
  assert.match(html, /id="btn-download-supplier-excel-template"/);
  assert.match(html, /id="btn-export-suppliers-excel"/);
  assert.match(html, /id="btn-open-supplier-excel-modal"/);
  assert.match(html, /id="btn-open-add-supplier-modal"/);
  assert.match(component, /export function downloadSupplierExcelTemplate/);
  assert.match(component, /export function exportSuppliersExcel/);
  assert.match(component, /function processSupplierExcelImport/);
  assert.match(component, /dbSaveSupplier\(supplierData\)/);
  assert.match(component, /id: existing\?\.id \|\| null/);
  assert.match(component, /openingDebt: existing \? Number\(existing\.openingDebt \|\| 0\) : 0/);
  const supplierImportModal = html.split('<!-- Supplier Excel Import Modal -->')[1].split('<!-- Modal Nhập Nguyên Liệu từ Excel -->')[0];
  assert.doesNotMatch(supplierImportModal, /value="overwrite"/);
});

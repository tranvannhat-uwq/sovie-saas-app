import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const html = read('index.html');
const invoice = read('js/components/invoice.js');
const users = read('js/components/users.js');

test('processing invoice is offered as a dedicated print type', () => {
  assert.match(html, /id="btn-print-type-processing"/);
  assert.match(html, /Hóa đơn bên gia công/);
  assert.match(invoice, /renderAndPrintOrder\(currentOrderToPrint, 'processing'\)/);
});

test('only Admin and Accounting may print the processing invoice', () => {
  assert.match(invoice, /function canPrintProcessingInvoice[\s\S]*\['admin', 'accounting'\]\.includes/);
  assert.match(invoice, /type === 'processing' && !canPrintProcessingInvoice\(\)/);
  assert.match(users, /#btn-print-type-processing, #btn-print-type-warehouse \{ display: none !important; \}/);
});

test('processing print is a company-free warehouse slip without product codes or prices', () => {
  assert.match(invoice, /type === 'warehouse' \|\| type === 'processing'[\s\S]*titleEl\.innerText = 'PHIẾU XUẤT KHO'/);
  assert.match(invoice, /if \(type === 'processing'\) companyLargeEl\.style\.display = 'none'/);
  assert.match(invoice, /else if \(type === 'processing'\) \{[\s\S]*Tên, nhãn hiệu, sản phẩm[\s\S]*Mã màu\/ % Màu[\s\S]*Tổng số lượng:/);
  assert.match(invoice, /invoiceIdRowEl\.style\.display = type === 'processing' \? 'none' : ''/);
  assert.match(invoice, /wordsContainer[\s\S]*type === 'warehouse' \|\| type === 'processing'/);
  assert.doesNotMatch(invoice.match(/else if \(type === 'processing'\) \{[\s\S]*?const processingSummary/)[0], /Mã SP|Giá nhập|TỔNG THANH TOÁN/);
  assert.match(invoice, /const orderDebtSnapshot = type === 'agent'/);
  assert.match(read('tests/processing-print-harness.html'), /processingPrintReady/);
});

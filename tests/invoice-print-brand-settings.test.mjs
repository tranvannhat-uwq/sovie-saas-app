import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const invoice = read('js/components/invoice.js');
const brands = read('js/components/brands.js');
const service = read('js/services/supabase.js');
const migration = read('migrations/0047_brand_invoice_print_settings.sql');

test('sales invoice keeps customer details but removes the sale-reason row', () => {
  for (const id of ['print-customer-name', 'print-customer-phone', 'print-customer-address']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /Lý do xuất bán|print-invoice-reason/);
  assert.doesNotMatch(invoice, /print-invoice-reason/);
});

test('warehouse text and salesperson phone are configurable for each brand', () => {
  for (const id of ['brand-invoice-warehouse-text', 'brand-sales-phone']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(brands, new RegExp(`getElementById\\('${id}'\\)`));
  }
  assert.match(service, /invoice_warehouse_text: brand\.invoiceWarehouseText/);
  assert.match(service, /sales_phone: brand\.salesPhone/);
  assert.match(service, /invoiceWarehouseText: row\.invoice_warehouse_text/);
  assert.match(service, /salesPhone: row\.sales_phone/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS invoice_warehouse_text text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS sales_phone text/);
});

test('printed seller stays the order closer while NVKD comes from the dealer manager', () => {
  assert.match(invoice, /order\.salespersonId \|\| order\.salesperson_id \|\| order\.createdBy/);
  assert.match(invoice, /state\.customers\.find\(c => String\(c\.id\) === String\(order\.customerId\)\)/);
  assert.match(invoice, /const managerId = orderCustomer\?\.managedBy[\s\S]*order\.customerManagerId/);
  assert.match(invoice, /salesPhoneEl\.innerText = config\.salesPhone \|\| config\.hotline/);
  assert.match(invoice, /warehouseTextEl\.innerText = config\.invoiceWarehouseText/);
  assert.match(invoice, /normalized\.includes\('truong phong'\)[\s\S]*return 'TPKD'/);
  assert.match(invoice, /return 'NVKD'/);
  assert.match(service, /salespersonId: order\.salesperson_id/);
});

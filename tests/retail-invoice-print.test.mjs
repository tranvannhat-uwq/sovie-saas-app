import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const invoice = read('js/components/invoice.js');
const html = read('index.html');

test('retail invoice uses the shorter title and hides company and warehouse rows only in retail mode', () => {
  const printFlow = invoice.slice(
    invoice.indexOf('export async function renderAndPrintOrder'),
    invoice.indexOf('export function setupPrintTypeModal')
  );

  assert.match(printFlow, /type === 'retail'[\s\S]{0,100}titleEl\.innerText = 'HÓA ĐƠN'/);
  assert.doesNotMatch(printFlow, /titleEl\.innerText = 'HÓA ĐƠN BÁN LẺ'/);
  assert.match(printFlow, /companyLargeEl\.style\.display = type === 'retail' \? 'none' : ''/);
  assert.match(printFlow, /warehouseRowEl\.style\.display = type === 'retail' \? 'none' : ''/);
  assert.match(printFlow, /salesPhoneGroupEl\.style\.display = type === 'warehouse' \? '' : 'none'/);
  assert.match(html, /id="print-warehouse-row"/);
  assert.match(html, /id="print-sales-phone-group"/);
});

test('sales invoice prints the managed business name instead of the paint brand label', () => {
  assert.match(html, /<span id="print-customer-manager"[^>]*>NVKD: N\/A<\/span>/);
  assert.doesNotMatch(html, /<strong>Hãng sơn:<\/strong>\s*<span id="print-order-brand"/);
  assert.match(invoice, /const managerId = orderCustomer\?\.managedBy[\s\S]*order\.customerManagerId/);
  assert.match(invoice, /formatSalesManagerPrintLabel\(managerId\)/);
  assert.match(invoice, /return `\$\{abbreviateSalesPosition\(manager\?\.position\)\}: \$\{managerName\}`/);
});

test('warehouse slip enlarges recipient name and places product name before item code', () => {
  const warehouseFlow = invoice.slice(
    invoice.indexOf("if (type === 'warehouse')", invoice.indexOf("const table = document.getElementById('print-invoice-table')")),
    invoice.indexOf('} else {', invoice.indexOf("if (type === 'warehouse')", invoice.indexOf("const table = document.getElementById('print-invoice-table')")))
  );
  assert.match(invoice, /customerNameEl\.style\.fontSize = type === 'warehouse' \? 'calc\(1em \+ 4px\)' : ''/);
  assert.match(warehouseFlow, /<th style="width: 30%;">Tên sản phẩm<\/th>[\s\S]*<th style="width: 14%;">Mã hàng<\/th>/);
  assert.match(warehouseFlow, /<td>\$\{item\.productName\}<\/td>[\s\S]*<td style="font-weight: bold; font-size: 14pt;">\$\{variantCode\}<\/td>/);
});

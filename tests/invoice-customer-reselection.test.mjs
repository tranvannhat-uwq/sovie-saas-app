import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const invoice = read('js/components/invoice.js');
const history = read('js/components/history.js');

test('order overview exposes named reset and customer reselection actions', () => {
  assert.match(html, /id="btn-reset-order"[\s\S]{0,300}Làm Mới Đơn/);
  assert.match(html, /id="btn-clear-invoice-customer"[\s\S]{0,350}Chọn khách khác/);
});

test('all editable roles can replace the selected customer without resetting order content', () => {
  const reselection = invoice.slice(
    invoice.indexOf('export function prepareInvoiceCustomerReselection'),
    invoice.indexOf('export function resetInvoiceBuilder')
  );
  assert.match(reselection, /state\.activeCustomerId = ''/);
  assert.match(reselection, /removeAttribute\('disabled'\)/);
  assert.match(reselection, /applyActivePriceListToInvoice\(\)/);
  assert.doesNotMatch(reselection, /invoice-notes|invoice-discount-value|invoiceItems\s*=\s*\[\]/);
  assert.match(invoice, /clearBtn\?\.addEventListener\('click', \(\) => prepareInvoiceCustomerReselection\(\)\)/);
  assert.match(invoice, /dataset\.selectedCustomerName = customer\.name/);
  assert.match(invoice, /prepareInvoiceCustomerReselection\(typedValue, false\)/);
});

test('sales customer scope remains enforced and read-only history remains locked', () => {
  assert.match(invoice, /state\.currentUser\.role === 'sale'[\s\S]{0,180}!isSameUser\(c\.managedBy, state\.currentUser\.username\)/);
  assert.match(history, /invoice-customer-search'\)\.disabled = isReadOnly/);
  assert.match(history, /clearCustomerButton\.style\.display = isReadOnly \? 'none' : 'inline-flex'/);
});

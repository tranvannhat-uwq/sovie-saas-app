import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer column picker offers the notes column and the table renders it', () => {
  const customers = read('js/components/customers.js');
  const html = read('index.html');
  const css = read('style.css');

  assert.match(customers, /\{ key: 'notes', label: 'Ghi chú', width: 220 \}/);
  assert.match(customers, /<td data-customer-column="notes" title="\$\{escapeCustomerHtml\(notes\)\}"><div class="customer-notes-cell">/);
  assert.match(html, /<col data-customer-column="notes"/);
  assert.match(html, /<th data-customer-column="notes">Ghi chú<\/th>/);
  assert.match(css, /\.customers-table col\[data-customer-column="notes"\]/);
  assert.match(css, /\.customers-table \.customer-notes-cell[\s\S]*?-webkit-line-clamp:\s*2/);
});

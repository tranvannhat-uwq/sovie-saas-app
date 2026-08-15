import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('cashbook create and edit forms use an explicit 24-hour picker', () => {
  const html = read('index.html');
  const cashbook = read('js/components/so_quy.js');
  const css = read('style.css');

  for (const id of ['receipt-time', 'payment-time', 'cashbook-edit-time']) {
    assert.match(html, new RegExp(`data-cashbook-datetime-target=["']${id}["']`));
    assert.match(html, new RegExp(`type=["']hidden["'] id=["']${id}["']`));
  }
  assert.doesNotMatch(html, /id="(?:receipt-time|payment-time|cashbook-edit-time)"[^>]*type="datetime-local"/);
  assert.match(cashbook, /Array\.from\(\{ length: 24 \}/);
  assert.match(cashbook, /Array\.from\(\{ length: 60 \}/);
  assert.match(cashbook, /`\$\{dateInput\.value\}T\$\{hourSelect\.value\}:\$\{minuteSelect\.value\}`/);
  assert.match(cashbook, /setCashbookDateTimeValue\('receipt-time'/);
  assert.match(cashbook, /setCashbookDateTimeValue\('payment-time'/);
  assert.match(cashbook, /setCashbookDateTimeValue\('cashbook-edit-time'/);
  assert.match(css, /grid-template-columns:\s*minmax\(128px, 1fr\) 80px 8px 80px/);
  assert.match(css, /\.cashbook-datetime-24h \.cashbook-hour-input,[\s\S]*?width:\s*80px/);
});

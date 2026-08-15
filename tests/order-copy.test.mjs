import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historySource = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');

test('history exposes order copy in both table and card views', () => {
  assert.equal((historySource.match(/class="[^"]*history-copy-btn/g) || []).length, 2);
  assert.match(historySource, /loadDraftOrderIntoInvoice\(order, false, true\)/);
});

test('copy mode cannot retain the source edit or amendment identity', () => {
  assert.match(historySource, /function loadDraftOrderIntoInvoice[\s\S]{0,500}resetInvoiceBuilder\(\)/);
  assert.match(historySource, /isCopy \? currentBusinessDateInputValue\(\)/);
  assert.match(historySource, /const isAmendment = isFinalizedAmendment && !isCopy/);

  const copySaveBranch = historySource.slice(
    historySource.indexOf('} else if (isCopy) {'),
    historySource.indexOf('} else if (isCopy) {') + 240
  );
  assert.doesNotMatch(copySaveBranch, /data-(?:edit|amend)-order-id/);
});

test('copy mode keeps the loaded order fields editable and offers new-order actions', () => {
  assert.match(historySource, /Thanh toán & Chốt đơn mới/);
  assert.match(historySource, /Lưu thành đơn nháp mới/);
  assert.match(historySource, /state\.isQuickCustomerMode = false/);
  assert.doesNotMatch(historySource, /if \(!isCopy\) \{\s*state\.isQuickCustomerMode = true/);
  assert.match(historySource, /detail: \{ order, isReadOnly, isCopy \}/);
});

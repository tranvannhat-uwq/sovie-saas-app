import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHistoryStatusGroup, matchesHistoryOrderStatuses } from '../js/domain/order-status.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const html = read('index.html');
const history = read('js/components/history.js');

test('history exposes independent multi-select status checkboxes', () => {
  for (const status of ['settled', 'draft']) {
    assert.match(html, new RegExp(`class="history-status-filter-check" value="${status}" checked`));
  }
  assert.match(html, /class="history-status-filter-check" value="cancelled"><span>Đã hủy<\/span>/);
  assert.doesNotMatch(html, /class="history-status-filter-check" value="cancelled" checked/);
  assert.match(history, /statusControls\.filter\(checkbox => checkbox\.checked\)/);
  assert.match(history, /statusControls\.length > 0 && !matchesHistoryOrderStatuses\(o\.status, selectedStatuses\)/);
  assert.match(history, /defaultStatuses = new Set\(\['settled', 'draft'\]\)/);
  assert.match(history, /statusFilter\.dataset\.defaultsInitialized !== 'true'[\s\S]*?checkbox\.checked = defaultStatuses\.has\(checkbox\.value\)/);
  assert.match(history, /statusFilter\.dataset\.defaultsInitialized = 'true'/);
});

test('checked history groups match finalized, draft and cancelled aliases', () => {
  assert.equal(getHistoryStatusGroup('partially_returned'), 'settled');
  assert.equal(getHistoryStatusGroup('returned'), 'settled');
  assert.equal(getHistoryStatusGroup('canceled'), 'cancelled');

  assert.equal(matchesHistoryOrderStatuses('settled', ['settled']), true);
  assert.equal(matchesHistoryOrderStatuses('draft', ['draft']), true);
  assert.equal(matchesHistoryOrderStatuses('cancelled', ['cancelled']), true);
  assert.equal(matchesHistoryOrderStatuses('draft', ['settled', 'cancelled']), false);
  assert.equal(matchesHistoryOrderStatuses('returned', ['settled', 'draft']), true);
  assert.equal(matchesHistoryOrderStatuses('settled', []), false);
});

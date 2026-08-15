import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');

test('business rendering and dashboard RPCs are blocked before profile authentication', () => {
  const renderAll = main.slice(main.indexOf('export function renderAll()'), main.indexOf('// Chuyển đổi giữa các phân hệ'));
  assert.match(renderAll, /if \(!state\.currentUser\)\s*\{[\s\S]*return;/);
  assert.ok(renderAll.indexOf('if (!state.currentUser)') < renderAll.indexOf('backfillMultiCompanyAndRevenueData()'));
  assert.ok(renderAll.indexOf('if (!state.currentUser)') < renderAll.indexOf('updateDashboardStats()'));
});

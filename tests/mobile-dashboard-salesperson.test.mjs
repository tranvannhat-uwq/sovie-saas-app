import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mobileRoot = new URL('../../mobile-app/', import.meta.url);
const service = readFileSync(new URL('src/services/dashboard.ts', mobileRoot), 'utf8');
const screen = readFileSync(new URL('src/screens/HomeScreen.tsx', mobileRoot), 'utf8');
const types = readFileSync(new URL('src/types/dashboard.ts', mobileRoot), 'utf8');

test('mobile dashboard maps salesperson revenue from the authenticated RPC', () => {
  assert.match(service, /raw\.by_salesperson/);
  assert.match(service, /from\('profiles'\)/);
  assert.match(service, /row\.auth_user_id/);
  assert.match(service, /bySalesperson: salespersonRows/);
  assert.match(types, /bySalesperson: DashboardBreakdown\[\]/);
});

test('mobile Admin dashboard renders the salesperson revenue chart', () => {
  assert.match(screen, /Doanh số theo nhân viên kinh doanh/);
  assert.match(screen, /HorizontalBars data=\{dashboard\.bySalesperson\}/);
});

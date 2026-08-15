import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canAdjustOrderBusinessDate,
  currentBusinessDateInputValue,
  orderDateToInputValue,
  parseOrderBusinessDateInput
} from '../js/domain/order-business-date.js';

test('only admin and accounting may adjust the order business date', () => {
  assert.equal(canAdjustOrderBusinessDate({ role: 'admin' }), true);
  assert.equal(canAdjustOrderBusinessDate({ role: 'accounting' }), true);
  assert.equal(canAdjustOrderBusinessDate({ role: 'sale' }), false);
  assert.equal(canAdjustOrderBusinessDate(null), false);
});

test('Vietnam business date remains stable across timestamp conversion', () => {
  const now = new Date('2026-08-03T02:00:00Z');
  assert.equal(currentBusinessDateInputValue(now), '2026-08-03');
  assert.deepEqual(parseOrderBusinessDateInput('2026-08-02', now), {
    ok: true,
    value: '2026-08-02T09:00:00+07:00',
    dateKey: '2026-08-02'
  });
  assert.equal(orderDateToInputValue('2026-08-02T00:00:00+07:00'), '2026-08-02');
});

test('order business date keeps the actual Vietnam finalization time', () => {
  const finalizedAt = new Date('2026-08-03T18:23:45Z');
  assert.deepEqual(parseOrderBusinessDateInput('2026-08-03', finalizedAt), {
    ok: true,
    value: '2026-08-03T01:23:45+07:00',
    dateKey: '2026-08-03'
  });
});

test('invalid and future order dates are rejected', () => {
  const now = new Date('2026-08-03T02:00:00Z');
  assert.equal(parseOrderBusinessDateInput('2026-02-30', now).ok, false);
  assert.equal(parseOrderBusinessDateInput('2026-08-04', now).ok, false);
  assert.equal(parseOrderBusinessDateInput('', now).ok, false);
});

test('database accepts historical dates only from privileged roles and preserves audit time', () => {
  const migration = fs.readFileSync(new URL('../migrations/0017_privileged_order_business_date.sql', import.meta.url), 'utf8');
  const service = fs.readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
  assert.match(migration, /actor\.role IN \(''admin'', ''accounting''\)/);
  assert.match(migration, /business_date, now\(\), now\(\), now\(\)/);
  assert.match(migration, /business_date\\\\2/);
  assert.match(migration, /last_order_at = GREATEST\(COALESCE\(last_order_at, business_date\), business_date\)/);
  assert.match(migration, /Order date cannot be in the future/);
  assert.match(service, /date: order\.date \|\| new Date\(\)\.toISOString\(\)/);
  assert.match(service, /date: order\.order_date \|\| order\.created_at/);
});

test('database compares the Vietnam business day and clamps same-day clock skew', () => {
  const migration = fs.readFileSync(new URL('../migrations/0042_order_business_date_clock_skew.sql', import.meta.url), 'utf8');
  const service = fs.readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
  assert.match(migration, /business_date AT TIME ZONE ''Asia\/Bangkok''/);
  assert.match(migration, /now\(\) AT TIME ZONE ''Asia\/Bangkok''/);
  assert.match(migration, /IF business_date > now\(\) THEN[\s\S]*business_date := now\(\)/);
  assert.match(migration, /Order date cannot be in the future/);
  assert.match(service, /Ngày lên đơn không được lớn hơn ngày hiện tại/);
});

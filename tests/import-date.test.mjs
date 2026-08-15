import assert from 'node:assert/strict';
import test from 'node:test';
import { businessDateKey, parseExcelDate } from '../js/domain/import-date.js';

test('customer import dates are normalized without Vietnam timezone drift', () => {
  assert.equal(parseExcelDate('30/07/2026'), '2026-07-30T12:00:00.000Z');
  assert.equal(parseExcelDate('2026-07-30'), '2026-07-30T12:00:00.000Z');
  assert.equal(parseExcelDate('8/3/2026'), '2026-03-08T12:00:00.000Z');
  assert.equal(parseExcelDate(new Date('2026-07-30T00:00:00.000Z')), '2026-07-30T12:00:00.000Z');

  const excelSerial = (Date.UTC(2026, 6, 30) - Date.UTC(1899, 11, 30)) / (24 * 60 * 60 * 1000);
  assert.equal(parseExcelDate(excelSerial), '2026-07-30T12:00:00.000Z');
});

test('invalid or ambiguous imported dates do not silently become another day', () => {
  assert.equal(parseExcelDate('31/02/2026'), null);
  assert.equal(parseExcelDate('not-a-date'), null);
  assert.equal(parseExcelDate(''), null);
  assert.equal(businessDateKey('2026-07-30T12:00:00.000Z'), '2026-07-30');
});

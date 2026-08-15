import assert from 'node:assert/strict';
import test from 'node:test';
import { customerDateKey, customerDaysSince, filterCustomerRows, normalizeCustomerPhone, normalizeCustomerSearch, queryCustomerRows, sortCustomerRows } from '../js/domain/customer-query.js';

const now = new Date(2026, 7, 3, 12);
const rows = [
  { id: '1', code: 'KH001', name: 'Nguyễn Thành', phone: '0912.000.001', address: 'Hà Nội', provinceName: 'Hà Nội', provinceCode: 'HN', brand: 'NANO10', pricelistId: 'p1', pricelistName: 'Bảng giá 01', managerId: 'hoan', managerName: 'Dương Hoàn', notes: 'Khách VIP', createdAt: '2026-07-30T12:00:00Z', lastTransactionAt: '2026-07-28T12:00:00Z', grossSales: 100000000, totalReturns: 10000000, netSales: 90000000, debt: 12000000, debtDays: 3, status: 'active' },
  { id: '2', code: 'KH002', name: 'Anh Bình', phone: '0988000002', address: '', provinceName: 'Đà Nẵng', provinceCode: 'DN', brand: 'FESTIVA', pricelistId: '', pricelistName: '', managerId: '', managerName: '', notes: '', createdAt: '2026-07-01T12:00:00Z', lastTransactionAt: '', grossSales: 0, totalReturns: 0, netSales: 0, debt: -2870, debtDays: 0, status: 'active' },
  { id: '3', code: 'KH003', name: 'Trần Lan', phone: '', address: 'Vĩnh Phúc', provinceName: 'Vĩnh Phúc', provinceCode: 'VP', brand: 'NANO10', pricelistId: 'p2', pricelistName: 'Bảng giá 02', managerId: 'thuy', managerName: 'Thanh Thụy', notes: 'Theo dõi', createdAt: '', lastTransactionAt: '2026-04-01T12:00:00Z', grossSales: 50000000, totalReturns: 5000000, netSales: 45000000, debt: 0, debtDays: 30, status: 'inactive' }
];

test('quick search is accent-insensitive and limited to customer code, name and phone', () => {
  assert.equal(normalizeCustomerSearch('  ĐƯỜNG   hoàn '), 'duong hoan');
  assert.equal(normalizeCustomerPhone('0912.000 001'), '0912000001');
  assert.equal(normalizeCustomerPhone('0912,000,001'), '0912000001');
  assert.deepEqual(filterCustomerRows(rows, { q: 'nguyen thanh' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { q: 'NGUYỄN THÀNH' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { q: '0912' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { q: '0912 000 001' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { q: '0912000001' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { q: '0988.000.002' }, now).map(row => row.id), ['2']);
  assert.deepEqual(filterCustomerRows(rows, { q: 'kh003' }, now).map(row => row.id), ['3']);
  for (const excludedValue of ['duong hoan', 'ha noi', 'nano10', 'bang gia 01', 'khach vip']) {
    assert.deepEqual(filterCustomerRows(rows, { q: excludedValue }, now), []);
  }
});

test('date keys do not swap day/month or drift through UTC', () => {
  assert.equal(customerDateKey('2026-07-30T12:00:00.000Z'), '2026-07-30');
  assert.equal(customerDaysSince('2026-07-28T12:00:00Z', now), 6);
  assert.deepEqual(filterCustomerRows(rows, { createdPreset: 'last7' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { lastPreset: 'never' }, now).map(row => row.id), ['2']);
  assert.deepEqual(filterCustomerRows(rows, { lastPreset: 'inactive30' }, now).map(row => row.id), ['3']);
});

test('sales, returns, zero and signed debt filters preserve numeric meaning', () => {
  assert.deepEqual(filterCustomerRows(rows, { salesMetric: 'netSales', salesPreset: 'gt50000000' }, now).map(row => row.id), ['1']);
  assert.deepEqual(filterCustomerRows(rows, { salesMetric: 'totalReturns', salesMin: 5000000 }, now).map(row => row.id), ['1', '3']);
  assert.deepEqual(filterCustomerRows(rows, { salesPreset: 'zero' }, now).map(row => row.id), ['2']);
  assert.deepEqual(filterCustomerRows(rows, { debtPreset: 'negative' }, now).map(row => row.id), ['2']);
  assert.deepEqual(filterCustomerRows(rows, { debtPreset: 'overdue' }, now).map(row => row.id), ['1']);
});

test('classification and completeness filters combine with search', () => {
  const result = filterCustomerRows(rows, {
    q: 'tran lan', brands: ['NANO10'], managers: ['thuy'], provinces: ['VP'], phoneState: 'missing'
  }, now);
  assert.deepEqual(result.map(row => row.id), ['3']);
  assert.deepEqual(filterCustomerRows(rows, { pricelistState: 'missing', addressState: 'missing' }, now).map(row => row.id), ['2']);
});

test('stable sorting handles nulls, Vietnamese names, zero and negative numbers', () => {
  assert.deepEqual(sortCustomerRows(rows, { sortKey: 'netSales', sortDirection: 'desc' }, now).map(row => row.id), ['1', '3', '2']);
  assert.deepEqual(sortCustomerRows(rows, { sortKey: 'debt', sortDirection: 'asc' }, now).map(row => row.id), ['2', '3', '1']);
  assert.deepEqual(sortCustomerRows(rows, { sortKey: 'createdAt', sortDirection: 'desc' }, now).map(row => row.id), ['1', '2', '3']);
  assert.deepEqual(sortCustomerRows(rows, { sortKey: 'lastTransactionAt', sortDirection: 'desc', nulls: 'first' }, now).map(row => row.id), ['2', '1', '3']);
  assert.deepEqual(queryCustomerRows(rows, { q: 'kh00', sortKey: 'name', sortDirection: 'asc' }, now).map(row => row.id), ['2', '1', '3']);
});

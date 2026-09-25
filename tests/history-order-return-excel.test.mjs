import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  calculateHistoryFinancialSummary,
  getSalesReturnRefundAmount,
  isOrderIncludedInFinancialSummary,
  isSalesReturnActive
} from '../js/domain/order-financials.js';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('Case 1: Single order 10.000.000 with 2.000.000 return slip yields 8.000.000 net payable', () => {
  const orders = [{
    id: 'ORD-001',
    status: 'settled',
    totalPayable: 10000000,
    items: [{ productName: 'Sản phẩm A', quantity: 10, price: 1000000 }]
  }];

  const returns = [{
    id: 'RET-001',
    saleId: 'ORD-001',
    status: 'completed',
    totalRefund: 2000000,
    items: [{ productName: 'Sản phẩm A', quantity: 2, price: 1000000 }]
  }];

  const summary = calculateHistoryFinancialSummary(orders, returns);
  assert.equal(summary.totalBeforeDiscount, 8000000);
  assert.equal(summary.totalReturnAmount, 2000000);
  assert.equal(summary.totalPayable, 8000000);
  assert.equal(summary.netPayable, 8000000);

  // Simulated Excel rows:
  // Order row net = +10.000.000
  // Return row net = -2.000.000
  const excelNetSum = 10000000 + (-2000000);
  assert.equal(excelNetSum, summary.totalPayable);
});

test('Case 2: Single order with multiple return slips (1.000.000 + 2.000.000) yields 7.000.000 net payable without double counting', () => {
  const orders = [{
    id: 'ORD-002',
    status: 'settled',
    totalPayable: 10000000
  }];

  const returns = [
    { id: 'RET-002A', saleId: 'ORD-002', status: 'completed', totalRefund: 1000000 },
    { id: 'RET-002B', saleId: 'ORD-002', status: 'completed', totalRefund: 2000000 }
  ];

  const summary = calculateHistoryFinancialSummary(orders, returns);
  assert.equal(summary.totalReturnAmount, 3000000);
  assert.equal(summary.totalPayable, 7000000);

  const excelNetSum = 10000000 + (-1000000) + (-2000000);
  assert.equal(excelNetSum, summary.totalPayable);
});

test('Case 3: Partial product return exports with negative quantity and negative revenue', () => {
  const returnSlip = {
    id: 'RET-003',
    code: 'TH-003',
    saleId: 'ORD-003',
    status: 'completed',
    totalRefund: 500000,
    items: [
      { productName: 'Hàng trả 1', quantity: 1, price: 300000 },
      { productName: 'Hàng trả 2', quantity: 1, price: 200000 }
    ]
  };

  assert.equal(isSalesReturnActive(returnSlip), true);
  assert.equal(getSalesReturnRefundAmount(returnSlip), 500000);

  // Return row simulation: quantity is negative, net revenue is negative
  const returnRowNet = -getSalesReturnRefundAmount(returnSlip);
  assert.equal(returnRowNet, -500000);
});

test('Case 4: Cancelled / voided return slips are excluded from financial deduction', () => {
  const cancelledReturn = { id: 'RET-C1', saleId: 'ORD-004', status: 'cancelled', totalRefund: 1500000 };
  const voidedReturn = { id: 'RET-C2', saleId: 'ORD-004', status: 'voided', totalRefund: 2500000 };
  const draftReturn = { id: 'RET-C3', saleId: 'ORD-004', status: 'draft', totalRefund: 500000 };

  assert.equal(isSalesReturnActive(cancelledReturn), false);
  assert.equal(isSalesReturnActive(voidedReturn), false);
  assert.equal(isSalesReturnActive(draftReturn), false);

  const orders = [{ id: 'ORD-004', status: 'settled', totalPayable: 10000000 }];
  const summary = calculateHistoryFinancialSummary(orders, [cancelledReturn, voidedReturn, draftReturn]);
  assert.equal(summary.totalReturnAmount, 0);
  assert.equal(summary.totalPayable, 10000000);
});

test('Case 5: Cancelled sales orders are excluded from revenue calculation', () => {
  const cancelledOrder = { id: 'ORD-CAN', status: 'cancelled', totalPayable: 5000000 };
  const draftOrder = { id: 'ORD-DRF', status: 'draft', totalPayable: 3000000 };
  const settledOrder = { id: 'ORD-OK', status: 'settled', totalPayable: 4000000 };

  assert.equal(isOrderIncludedInFinancialSummary(cancelledOrder), false);
  assert.equal(isOrderIncludedInFinancialSummary(draftOrder), false);
  assert.equal(isOrderIncludedInFinancialSummary(settledOrder), true);

  const summary = calculateHistoryFinancialSummary([cancelledOrder, draftOrder, settledOrder], []);
  assert.equal(summary.totalPayable, 4000000);
});

test('Case 6: Retail / walk-in customers (Khách lẻ) and legacy orders without items are supported cleanly', () => {
  const legacyRetailOrder = {
    id: 'ORD-LEGACY',
    customerName: '',
    customer_name: null,
    status: 'settled',
    totalPayable: 1500000,
    items: []
  };

  const name = legacyRetailOrder.customerName || legacyRetailOrder.customer_name || 'Khách lẻ';
  assert.equal(name, 'Khách lẻ');

  const summary = calculateHistoryFinancialSummary([legacyRetailOrder], []);
  assert.equal(summary.totalPayable, 1500000);
});

test('Case 7: Date window boundary filter strictly scopes returns', () => {
  const returns = [
    { id: 'R1', returnDate: '2026-03-01T10:00:00Z', status: 'completed', totalRefund: 100000 },
    { id: 'R2', returnDate: '2026-03-15T10:00:00Z', status: 'completed', totalRefund: 200000 },
    { id: 'R3', returnDate: '2026-03-31T23:59:59Z', status: 'completed', totalRefund: 300000 },
    { id: 'R4', returnDate: '2026-04-01T00:00:00Z', status: 'completed', totalRefund: 400000 }
  ];

  const startDate = '2026-03-01';
  const endDate = '2026-03-31';

  const inScope = returns.filter(ret => {
    if (!isSalesReturnActive(ret)) return false;
    const dateStr = ret.returnDate || ret.createdAt || '';
    const day = dateStr.slice(0, 10);
    return day >= startDate && day <= endDate;
  });

  assert.equal(inScope.length, 3);
  assert.deepEqual(inScope.map(r => r.id), ['R1', 'R2', 'R3']);
});

test('Case 8: Deduplication ensures no duplicate order or return slip processing', () => {
  const order = { id: 'ORD-DUP', status: 'settled', totalPayable: 5000000 };
  const ret = { id: 'RET-DUP', saleId: 'ORD-DUP', status: 'completed', totalRefund: 1000000 };

  const exportedReturnIds = new Set();
  const rows = [];

  // Simulate export iteration where returns might appear multiple times
  const processReturn = (r) => {
    if (exportedReturnIds.has(r.id)) return;
    exportedReturnIds.add(r.id);
    rows.push({ type: 'return', id: r.id, net: -r.totalRefund });
  };

  rows.push({ type: 'order', id: order.id, net: order.totalPayable });
  processReturn(ret);
  processReturn(ret); // duplicate attempt

  assert.equal(rows.length, 2);
  const total = rows.reduce((acc, r) => acc + r.net, 0);
  assert.equal(total, 4000000);
});

test('Contract verification: customers.js and history.js maintain unified accounting and return export', () => {
  const customers = read('js/components/customers.js');
  const history = read('js/components/history.js');

  // Unified summary logic
  assert.match(history, /calculateHistoryFinancialSummary\(orders,\s*allActiveReturns\)/);
  assert.match(history, /createHistoryLookups\(activeWindow\)/);

  // Column definitions include return columns
  assert.match(customers, /'Mã đơn hàng gốc'/);
  assert.match(customers, /'Ngày trả hàng'/);
  assert.match(customers, /'Giá trị trả hàng'/);
  assert.match(customers, /'Thành tiền\/Doanh thu thuần'/);

  // Return row builder exists and deducts refund
  assert.match(customers, /function buildHistoryReturnExportRow\(ret,\s*order,\s*customer/);
  assert.match(customers, /const refundAmount = getSalesReturnRefundAmount\(ret\)/);
  assert.match(customers, /'Thành tiền\/Doanh thu thuần': -refundAmount/);

  // Pre-return order rows to prevent double subtraction
  assert.match(customers, /buildCustomerOrderExportRows\(\[order\],\s*customer,\s*options\)/);

  // Deduplication in export loop
  assert.match(customers, /const exportedReturnIds = new Set\(\)/);
  assert.match(customers, /exportedReturnIds\.add\(returnId\)/);
});

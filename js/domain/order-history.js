const SETTLED_STATUSES = new Set(['settled', 'completed', 'complete', 'confirmed']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

function normalizeStatus(status, fallback = '') {
  return String(status || fallback).trim().toLowerCase();
}

export function matchesOrderHistoryStatus(order, requestedStatus = 'all') {
  const filter = normalizeStatus(requestedStatus, 'all');
  if (filter === 'all') return true;

  const orderStatus = normalizeStatus(order?.status, 'settled');
  if (filter === 'settled') return SETTLED_STATUSES.has(orderStatus);
  if (filter === 'cancelled') return CANCELLED_STATUSES.has(orderStatus);
  return orderStatus === filter;
}

export function isEffectiveOrderHistoryRow(order, requestedStatus = 'all') {
  if (normalizeStatus(requestedStatus, 'all') !== 'all') return true;
  if (order?.deletedAt || order?.deleted_at || order?.isDeleted) return false;

  const status = normalizeStatus(order?.status, 'settled');
  return status !== 'draft' && !CANCELLED_STATUSES.has(status);
}

export function isOrderInHistoryWindow(order, startIso, endExclusiveIso) {
  const orderTime = new Date(order?.date || order?.createdAt || order?.created_at).getTime();
  const startTime = new Date(startIso).getTime();
  const endTime = new Date(endExclusiveIso).getTime();
  return Number.isFinite(orderTime)
    && Number.isFinite(startTime)
    && Number.isFinite(endTime)
    && orderTime >= startTime
    && orderTime < endTime;
}

export function mapOrderHistoryRow(order = {}) {
  const totalPayable = parseFloat(order.total_payable ?? order.totalPayable ?? 0);
  const paidAmount = parseFloat(
    order.paid_amount ?? order.paidAmount ?? order.other_fee_amount ?? order.otherFeeAmount ?? 0
  );
  const shippingFeeAmount = parseFloat(order.shipping_fee_amount ?? order.shippingFeeAmount ?? 0);

  return {
    id: order.id,
    customerId: order.customer_id || order.customerId || null,
    customerName: order.customer_name || order.customerName || '',
    customerPhone: order.customer_phone || order.customerPhone || '',
    customerAddress: order.customer_address || order.customerAddress || '',
    notes: order.notes || '',
    items: typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []),
    date: order.order_date || order.created_at || order.date || order.createdAt,
    pricingVersion: order.pricing_version || order.pricingVersion || '',
    createdAt: order.created_at || order.createdAt || order.date,
    updatedAt: order.updated_at || order.updatedAt || order.created_at || order.date,
    totalMarket: parseFloat(order.total_market ?? order.totalMarket ?? 0),
    totalDiscount: parseFloat(order.total_discount ?? order.totalDiscount ?? 0),
    subtotal: parseFloat(order.subtotal ?? order.total_payable ?? order.totalPayable ?? 0),
    discountValue: parseFloat(order.discount_value ?? order.discountValue ?? 0),
    discountType: order.discount_type || order.discountType || 'amount',
    discountAmount: parseFloat(order.discount_amount ?? order.discountAmount ?? 0),
    otherFeeAmount: parseFloat(order.other_fee_amount ?? order.otherFeeAmount ?? 0),
    shippingFeeValue: parseFloat(order.shipping_fee_value ?? order.shippingFeeValue ?? 0),
    shippingFeeAmount,
    totalPayable,
    paidAmount,
    amountDue: parseFloat(order.debt_amount ?? order.amountDue ?? Math.max(
      0,
      totalPayable - paidAmount + shippingFeeAmount
    )),
    pricelistId: order.pricelist_id || order.pricelistId || 'retail',
    createdBy: order.created_by || order.createdBy || '',
    salespersonId: order.salesperson_id || order.salespersonId || order.created_by || order.createdBy || '',
    customerManagerId: order.customer_manager_id || order.customerManagerId || '',
    status: order.status || 'settled',
    companyId: order.company_id || order.companyId || 'ABS_NORTH'
  };
}

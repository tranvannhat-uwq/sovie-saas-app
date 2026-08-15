const SETTLED_ORDER_STATUSES = new Set([
  'settled', 'completed', 'complete', 'confirmed', 'partially_returned', 'returned'
]);
const CANCELLED_ORDER_STATUSES = new Set(['cancelled', 'canceled']);

export function normalizeOrderStatus(status) {
  return String(status || 'settled').trim().toLowerCase();
}

export function getHistoryStatusGroup(status) {
  const normalized = normalizeOrderStatus(status);
  if (normalized === 'draft') return 'draft';
  if (CANCELLED_ORDER_STATUSES.has(normalized)) return 'cancelled';
  if (SETTLED_ORDER_STATUSES.has(normalized)) return 'settled';
  return normalized;
}

export function matchesHistoryOrderStatuses(orderStatus, selectedStatuses) {
  const selected = new Set((selectedStatuses || []).map(normalizeOrderStatus));
  return selected.has(getHistoryStatusGroup(orderStatus));
}

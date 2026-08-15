function normalizeCashbookText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}

/** Customer debt receipts require the atomic debt-reversal RPC. */
export function isCustomerDebtReceipt(transaction = {}) {
  const transactionType = normalizeCashbookText(
    transaction.transactionType ?? transaction.transaction_type
  );

  if (transactionType === 'customer_payment') return true;
  if (transactionType) return false;

  const direction = normalizeCashbookText(transaction.type ?? transaction.direction);
  const isReceipt = direction === 'thu' || direction === 'in';
  if (!isReceipt) return false;
  if (transaction.debtImpact === true || transaction.debt_impact === true) return true;

  // Compatibility for rows cached before transactionType was retained.
  return normalizeCashbookText(transaction.category) === 'thu no khach hang';
}

export function getCanonicalCashbookId(transaction = {}) {
  return transaction.cloudId || transaction.cloud_id || transaction.id || '';
}

/**
 * The operational cashbook shows only vouchers that still have financial
 * effect. Cancelled sources and their append-only reversal rows remain in the
 * database audit trail but are not separate business vouchers in the UI.
 */
export function isEffectiveCashbookTransaction(transaction = {}) {
  const status = normalizeCashbookText(transaction.status);
  const transactionType = normalizeCashbookText(
    transaction.transactionType ?? transaction.transaction_type
  );
  const id = normalizeCashbookText(transaction.id);
  const isCancelled = status === 'cancelled'
    || status === 'canceled'
    || status.includes('huy')
    || status.includes('cancel');
  const isReversal = Boolean(transaction.reversalOfId || transaction.reversal_of_id)
    || transactionType.includes('reversal')
    || id.startsWith('void-');
  return !isCancelled && !isReversal;
}

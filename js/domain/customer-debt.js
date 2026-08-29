/**
 * Customer debt convention used everywhere in the application:
 *   > 0: customer still owes the company
 *   = 0: settled
 *   < 0: customer has a credit / paid in advance
 *
 * Amounts are rounded to VND so the UI and database ledger cannot drift on
 * fractional arithmetic.
 */
export function toDebtAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
}

/**
 * Balance snapshots are created in database posting order. A document may
 * carry an older business date, so sorting by that date can make consecutive
 * balanceBefore/balanceAfter values appear contradictory.
 */
export function getCustomerDebtPostingDate(entry = {}) {
  return entry.postedAt
    ?? entry.posted_at
    ?? entry.createdAt
    ?? entry.created_at
    ?? entry.date
    ?? entry.transactionDate
    ?? entry.transaction_date
    ?? '';
}

export function getOrderOutstandingAmount(order = {}) {
  const explicitAmountDue = Number(order.amountDue ?? order.debtAmount ?? order.debt_amount);
  if (Number.isFinite(explicitAmountDue)) return Math.max(0, Math.round(explicitAmountDue));

  const totalPayable = toDebtAmount(order.totalPayable ?? order.total_payable ?? order.totalAmount ?? order.total_amount);
  const shippingFee = Math.max(0, toDebtAmount(order.shippingFeeAmount ?? order.shipping_fee_amount ?? order.shippingFeeValue ?? order.shipping_fee_value));
  const paidAmount = Math.max(0, toDebtAmount(order.paidAmount ?? order.paid_amount));
  return Math.max(0, totalPayable + shippingFee - paidAmount);
}

export function chargeCustomerDebt(balanceBefore, amount) {
  return toDebtAmount(balanceBefore) + Math.max(0, toDebtAmount(amount));
}

export function collectCustomerDebt(balanceBefore, amount) {
  return toDebtAmount(balanceBefore) - Math.max(0, toDebtAmount(amount));
}

export function reduceCustomerDebtForReturn(balanceBefore, amount) {
  return collectCustomerDebt(balanceBefore, amount);
}

export function restoreCustomerDebtForCancelledReturn(balanceBefore, amount) {
  return chargeCustomerDebt(balanceBefore, amount);
}

/**
 * Resolve the immutable balance snapshot created when an order was posted.
 * Ledger row ids are not order ids (for example `dtx-ord-...`), so callers
 * must match the dedicated orderId field. The id fallback only supports old
 * browser-cached history entries created before the ledger was authoritative.
 */
export function getOrderDebtSnapshot(order = {}, customer = {}, ledgerSnapshot = null) {
  const orderId = String(order.id || '');
  const history = Array.isArray(customer?.debtHistory) ? customer.debtHistory : [];
  const historyEntry = history.find(entry =>
    String(entry?.orderId || '') === orderId
    && (entry?.transactionType === 'order' || entry?.type === 'charge')
  ) || history.find(entry =>
    String(entry?.id || '') === orderId
    && (entry?.transactionType === 'order' || entry?.type === 'charge')
  );
  const source = ledgerSnapshot || historyEntry;
  if (!source) return null;

  const debtBefore = Number(source.debtBefore ?? source.balance_before);
  const debtAfter = Number(source.debtAfter ?? source.balance_after);
  if (!Number.isFinite(debtBefore) || !Number.isFinite(debtAfter)) return null;
  return { debtBefore: toDebtAmount(debtBefore), debtAfter: toDebtAmount(debtAfter) };
}

/**
 * Return the ids of order-charge rows and their exact cancellation/amendment
 * reversals. They remain in the ledger for audit, but the customer history UI
 * may hide these zero-net pairs by default.
 */
export function getNeutralizedOrderDebtEntryIds(history = []) {
  const entries = Array.isArray(history) ? history : [];
  const byId = new Map(entries
    .filter(entry => entry?.id)
    .map(entry => [String(entry.id), entry]));
  const hiddenIds = new Set();

  for (const reversal of entries) {
    const isOrderReversal = reversal?.transactionType === 'order_cancel' || reversal?.type === 'order_cancel';
    const originalId = reversal?.reversalOfId ?? reversal?.reversal_of_id;
    if (!isOrderReversal || !originalId) continue;

    const original = byId.get(String(originalId));
    const isOrderCharge = original?.transactionType === 'order' || original?.type === 'charge';
    if (!isOrderCharge) continue;

    const originalOrderId = original?.orderId ?? original?.order_id;
    const reversalOrderId = reversal?.orderId ?? reversal?.order_id;
    if (originalOrderId && reversalOrderId && String(originalOrderId) !== String(reversalOrderId)) continue;

    const originalChange = Number(original?.debtChange ?? original?.debt_change);
    const reversalChange = Number(reversal?.debtChange ?? reversal?.debt_change);
    if (!Number.isFinite(originalChange) || !Number.isFinite(reversalChange)) continue;
    if (toDebtAmount(originalChange + reversalChange) !== 0) continue;

    hiddenIds.add(String(original.id));
    hiddenIds.add(String(reversal.id));
  }
  return hiddenIds;
}

const DEBT_CANCELLATION_TYPES = new Set(['payment_cancel', 'order_cancel', 'return_cancel']);
const DEBT_AMENDMENT_TYPES = new Set(['payment_amend', 'payment_relink', 'sale_payment_amend', 'return_amend']);

function debtTransactionType(entry = {}) {
  return String(entry.transactionType ?? entry.transaction_type ?? entry.type ?? '').toLowerCase();
}

function debtRelationValue(entry = {}, camelKey, snakeKey) {
  const value = entry?.[camelKey] ?? entry?.[snakeKey];
  return value == null || value === '' ? '' : String(value);
}

/**
 * Build the effective business history shown to users.
 *
 * The database ledger remains append-only for audit. Cancellation rows remove
 * their whole source document from this projection, while amendment rows are
 * folded into the original transaction so the UI shows one current voucher.
 */
export function projectEffectiveCustomerDebtHistory(history = []) {
  const entries = (Array.isArray(history) ? history : []).filter(Boolean);
  const byId = new Map(entries
    .filter(entry => entry.id)
    .map(entry => [String(entry.id), entry]));
  const hiddenIds = new Set();

  for (const cancellation of entries) {
    const type = debtTransactionType(cancellation);
    if (!DEBT_CANCELLATION_TYPES.has(type)) continue;
    if (cancellation.id) hiddenIds.add(String(cancellation.id));

    const originalId = debtRelationValue(cancellation, 'reversalOfId', 'reversal_of_id');
    if (originalId) hiddenIds.add(originalId);

    const cashbookId = debtRelationValue(cancellation, 'cashbookTransactionId', 'cashbook_transaction_id');
    const orderId = debtRelationValue(cancellation, 'orderId', 'order_id');
    const returnId = debtRelationValue(cancellation, 'salesReturnId', 'sales_return_id');
    for (const candidate of entries) {
      const sameDocument = (type === 'payment_cancel' && cashbookId
          && debtRelationValue(candidate, 'cashbookTransactionId', 'cashbook_transaction_id') === cashbookId)
        || (type === 'order_cancel' && orderId
          && debtRelationValue(candidate, 'orderId', 'order_id') === orderId)
        || (type === 'return_cancel' && returnId
          && debtRelationValue(candidate, 'salesReturnId', 'sales_return_id') === returnId);
      if (sameDocument && candidate.id) hiddenIds.add(String(candidate.id));
    }
  }

  const projected = new Map(entries
    .filter(entry => entry.id && !DEBT_AMENDMENT_TYPES.has(debtTransactionType(entry)))
    .map(entry => [String(entry.id), { ...entry }]));
  const amendments = entries
    .filter(entry => DEBT_AMENDMENT_TYPES.has(debtTransactionType(entry)))
    .sort((left, right) => new Date(getCustomerDebtPostingDate(left) || 0) - new Date(getCustomerDebtPostingDate(right) || 0));

  for (const amendment of amendments) {
    const amendmentId = amendment.id ? String(amendment.id) : '';
    const amendmentWasCancelled = amendmentId && hiddenIds.has(amendmentId);
    if (amendmentId) hiddenIds.add(amendmentId);
    if (amendmentWasCancelled) continue;

    const type = debtTransactionType(amendment);
    let targetId = debtRelationValue(amendment, 'amendsLedgerId', 'amends_ledger_id')
      || debtRelationValue(amendment, 'reversalOfId', 'reversal_of_id');
    if (type === 'sale_payment_amend') {
      const orderId = debtRelationValue(amendment, 'orderId', 'order_id');
      const orderEntry = entries.find(entry =>
        debtTransactionType(entry) === 'order'
        && debtRelationValue(entry, 'orderId', 'order_id') === orderId);
      if (orderEntry?.id) targetId = String(orderEntry.id);
    }

    if (targetId && hiddenIds.has(targetId)) continue;
    const target = targetId ? projected.get(targetId) : null;
    const amendmentChange = toDebtAmount(amendment.debtChange ?? amendment.debt_change);
    if (target) {
      const effectiveChange = toDebtAmount(target.debtChange ?? target.debt_change) + amendmentChange;
      target.debtChange = effectiveChange;
      target.amount = Math.abs(effectiveChange);
      target.debtAfter = toDebtAmount(amendment.debtAfter ?? amendment.balance_after);
      target.date = amendment.date || target.date;
      target.postedAt = getCustomerDebtPostingDate(amendment) || getCustomerDebtPostingDate(target);
      if (effectiveChange === 0) hiddenIds.add(targetId);
      continue;
    }

    // A relink into another customer references a ledger row owned by the old
    // customer, so that original is intentionally absent from this history.
    // Present the new customer's effective receipt/return, not an adjustment.
    if (amendmentChange !== 0 && amendmentId) {
      const effectiveType = type === 'return_amend' ? 'return' : (amendmentChange < 0 ? 'payment' : 'charge');
      projected.set(amendmentId, {
        ...amendment,
        type: effectiveType,
        transactionType: effectiveType === 'charge' ? 'order' : effectiveType,
        amount: Math.abs(amendmentChange),
        debtChange: amendmentChange
      });
      hiddenIds.delete(amendmentId);
    }
  }

  return entries
    .map(entry => entry.id ? projected.get(String(entry.id)) : entry)
    .filter((entry, index, result) => entry
      && !hiddenIds.has(String(entry.id || ''))
      && result.indexOf(entry) === index);
}

function getCustomerDebtEntryChange(entry = {}) {
  const rawExplicit = entry.debtChange ?? entry.debt_change;
  const explicit = Number(rawExplicit);
  if (rawExplicit != null && rawExplicit !== '' && Number.isFinite(explicit)) return toDebtAmount(explicit);
  const amount = Math.abs(toDebtAmount(entry.amount));
  const type = debtTransactionType(entry);
  if (type === 'payment' || type === 'return') return -amount;
  if (type === 'order' || type === 'charge') return amount;
  return toDebtAmount(entry.amount);
}

/**
 * Create the effective user-facing ledger. Technical cancellations are
 * removed and amendments are folded, so their stored snapshots cannot be
 * displayed verbatim. Rebuild the visible before/after chain backwards from
 * the authoritative customer balance to keep every adjacent row continuous.
 */
export function buildCustomerDebtDisplayHistory(history = [], currentDebt = 0) {
  const chronological = projectEffectiveCustomerDebtHistory(history)
    .map((entry, index) => ({ ...entry, __displayOrder: index }))
    .sort((left, right) => {
      const timeDelta = new Date(getCustomerDebtPostingDate(left) || 0)
        - new Date(getCustomerDebtPostingDate(right) || 0);
      return timeDelta || left.__displayOrder - right.__displayOrder;
    });

  let balanceAfter = toDebtAmount(currentDebt);
  for (let index = chronological.length - 1; index >= 0; index -= 1) {
    const entry = chronological[index];
    const debtChange = getCustomerDebtEntryChange(entry);
    entry.debtChange = debtChange;
    entry.debtAfter = balanceAfter;
    entry.debtBefore = balanceAfter - debtChange;
    balanceAfter = entry.debtBefore;
    delete entry.__displayOrder;
  }
  return chronological;
}

/**
 * The database ledger is authoritative. Older browser builds also cached an
 * optimistic order entry whose id was the order id itself. Once the real
 * ledger row arrives, discard that cached twin instead of showing both rows.
 */
export function mergeCustomerDebtHistory(existingHistory = [], ledgerHistory = []) {
  const merged = new Map();

  for (const item of Array.isArray(existingHistory) ? existingHistory : []) {
    const key = String(item?.id || `legacy:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
    merged.set(key, item);
  }

  for (const item of Array.isArray(ledgerHistory) ? ledgerHistory : []) {
    const orderId = item?.orderId;
    const isOrderCharge = item?.transactionType === 'order' || item?.type === 'charge';
    if (orderId && isOrderCharge) merged.delete(String(orderId));
    const key = String(item?.id || `ledger:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
    merged.set(key, item);
  }

  return [...merged.values()];
}

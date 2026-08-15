import { normalizePriceListType, PRICE_LIST_TYPES } from './pricing.js';

function normalizePriceListLabel(value) {
  return String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function requiresOrderSaveApproval(priceList) {
  if (!priceList) return false;
  const label = normalizePriceListLabel(`${priceList.name || ''} ${priceList.code || ''}`);
  const compactLabel = label.replace(/\s+/g, '');
  return label.includes('thi truong')
    || label.includes('market')
    || compactLabel.includes('tt20072026');
}

export function isPrintOnlyPriceList(priceList) {
  if (!priceList) return false;
  if (priceList.isPrintOnly === true || priceList.is_print_only === true) return true;
  if (priceList.isPrintOnly === false || priceList.is_print_only === false) return false;
  return requiresOrderSaveApproval(priceList);
}

export function supportsInvoiceLineDiscount(priceList) {
  if (!priceList) return false;
  const normalizedName = normalizePriceListLabel(priceList.name);
  const compactName = normalizedName.replace(/\s+/g, '');
  return normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.GENERAL
    || normalizedName.includes('thi truong')
    || compactName.includes('tt20072026');
}

import { state } from '../state.js';
import { updateDbStatusUI } from '../utils.js';
import {
  applyBrandRealtimePayload,
  applyCashbookRealtimePayload,
  applyCustomerRealtimePayload,
  applyCustomerDebtRealtimePayload,
  applyOrderRealtimePayload,
  applyPricingRealtimePayload,
  applyProductRealtimePayload,
  applyStartingBalanceRealtimePayload,
  dbFetchCustomerById,
  dbRefreshOrderById,
  dbRefreshSalesReturnById,
  fetchCloudData,
  isCloudActive,
  supabaseClient,
  tableBrandsName,
  tableCashbookTransactionsName,
  tableCustomerDebtTransactionsName,
  tableCustomersName,
  tableDraftOrdersName,
  tableOrdersName,
  tablePriceListItemsName,
  tablePricelistsName,
  tableProductsName,
  tableSalesReturnItemsName,
  tableSalesReturnsName,
  tableStartingBalancesName
} from './supabase.js?v=20260814-invoice-discount-label-v19';

const REALTIME_DEBOUNCE_MS = 250;
let realtimeChannel = null;
let realtimeClient = null;
let realtimeRender = null;
let realtimeTimer = null;
let realtimeGeneration = 0;
let realtimeStatus = 'CLOSED';
let pendingEvents = [];
let flushInProgress = false;
let onlineHandler = null;

function eventRecordId(payload) {
  return payload?.new?.id || payload?.old?.id || '';
}

function queueRealtimeEvent(event) {
  if (!state.currentUser) return;
  pendingEvents.push(event);
  if (realtimeTimer) clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(() => {
    realtimeTimer = null;
    void flushRealtimeEvents();
  }, REALTIME_DEBOUNCE_MS);
}

async function flushRealtimeEvents() {
  if (flushInProgress || !state.currentUser || pendingEvents.length === 0) return;
  flushInProgress = true;
  const batch = pendingEvents;
  pendingEvents = [];

  try {
    const orderChanges = new Map();
    const customerChanges = new Map();
    const salesReturnChanges = new Map();

    batch.forEach(event => {
      if (event.kind === 'order') {
        const id = eventRecordId(event.payload);
        if (id) orderChanges.set(`${event.isDraft ? 'draft' : 'order'}:${id}`, {
          id,
          isDraft: event.isDraft,
          deleted: event.payload.eventType === 'DELETE',
          payload: event.payload
        });
      } else if (event.kind === 'customer') {
        const id = eventRecordId(event.payload);
        if (id) customerChanges.set(String(id), event.payload);
      } else if (event.kind === 'customerFinancial') {
        applyCustomerDebtRealtimePayload(event.payload);
      } else if (event.kind === 'cashbook') {
        applyCashbookRealtimePayload(event.payload);
      } else if (event.kind === 'startingBalances') {
        applyStartingBalanceRealtimePayload(event.payload);
      } else if (event.kind === 'product') {
        applyProductRealtimePayload(event.payload);
      } else if (event.kind === 'priceList') {
        applyPricingRealtimePayload('priceList', event.payload);
      } else if (event.kind === 'priceListItem') {
        applyPricingRealtimePayload('priceListItem', event.payload);
      } else if (event.kind === 'brand') {
        applyBrandRealtimePayload(event.payload);
      } else if (event.kind === 'salesReturn') {
        const id = eventRecordId(event.payload);
        if (id) salesReturnChanges.set(String(id), event.payload.eventType === 'DELETE');
      } else if (event.kind === 'salesReturnItem') {
        const row = event.payload?.new || event.payload?.old || {};
        const existingReturn = !row.return_id && row.id
          ? (state.salesReturns || []).find(item =>
              (item.items || []).some(returnItem => String(returnItem.id) === String(row.id)))
          : null;
        const returnId = row.return_id || existingReturn?.id;
        if (returnId) salesReturnChanges.set(String(returnId), false);
      }
    });

    await Promise.all([...orderChanges.values()].map(change =>
      applyOrderRealtimePayload(change.payload, { isDraft: change.isDraft })
        ? Promise.resolve(true)
        : dbRefreshOrderById(change.id, change)
    ));

    for (const [customerId, payload] of customerChanges) {
      if (!applyCustomerRealtimePayload(payload)) {
        await dbFetchCustomerById(customerId);
      }
    }
    for (const [returnId, deleted] of salesReturnChanges) {
      await dbRefreshSalesReturnById(returnId, { deleted });
    }

    if (typeof realtimeRender === 'function' && state.currentUser) realtimeRender();
  } catch (error) {
    console.warn('Realtime scoped refresh failed; data remains unchanged locally:', error);
  } finally {
    flushInProgress = false;
    if (pendingEvents.length > 0 && !realtimeTimer) {
      realtimeTimer = setTimeout(() => {
        realtimeTimer = null;
        void flushRealtimeEvents();
      }, REALTIME_DEBOUNCE_MS);
    }
  }
}

function queueVisiblePanelCatchup() {
  if (!state.currentUser || document.visibilityState === 'hidden') return;
  const domainsByPanel = {
    'products-panel': ['products'],
    'pricelists-panel': ['pricelists'],
    'invoice-panel': ['products', 'customers', 'pricelists'],
    'history-panel': ['orders', 'salesReturns'],
    'customers-panel': ['customers'],
    'so-quy-panel': ['cashbook', 'startingBalances'],
    'reports-panel': ['orders', 'customers', 'salesReturns'],
    'dashboard-panel': ['orders', 'customers', 'salesReturns']
  };
  const domains = domainsByPanel[state.currentTab] || [];
  if (domains.length === 0) return;
  void fetchCloudData({ onlyDomains: domains, hydrateCustomerHistory: false })
    .then(() => {
      if (typeof realtimeRender === 'function' && state.currentUser) realtimeRender();
    });
}

function subscribeTable(channel, table, handler) {
  return channel.on('postgres_changes', { event: '*', schema: 'public', table }, handler);
}

export async function stopRealtimeSync() {
  realtimeGeneration += 1;
  if (realtimeTimer) clearTimeout(realtimeTimer);
  realtimeTimer = null;
  pendingEvents = [];
  if (onlineHandler) window.removeEventListener('online', onlineHandler);
  onlineHandler = null;

  const channel = realtimeChannel;
  const client = realtimeClient;
  realtimeChannel = null;
  realtimeClient = null;
  realtimeRender = null;
  realtimeStatus = 'CLOSED';
  if (channel && client) {
    try {
      await client.removeChannel(channel);
    } catch (error) {
      console.warn('Could not close realtime channel cleanly:', error);
    }
  }
}

export async function startRealtimeSync(renderCallback) {
  if (!isCloudActive || !supabaseClient || !state.currentUser) return false;
  await stopRealtimeSync();

  const generation = realtimeGeneration;
  realtimeClient = supabaseClient;
  realtimeRender = renderCallback;
  let channel = realtimeClient.channel(`billing-live-${state.currentUser.authUserId || state.currentUser.id}`);

  channel = subscribeTable(channel, tableOrdersName,
    payload => queueRealtimeEvent({ kind: 'order', isDraft: false, payload }));
  channel = subscribeTable(channel, tableDraftOrdersName,
    payload => queueRealtimeEvent({ kind: 'order', isDraft: true, payload }));
  channel = subscribeTable(channel, tableCustomersName,
    payload => queueRealtimeEvent({ kind: 'customer', payload }));
  channel = subscribeTable(channel, tableCustomerDebtTransactionsName,
    payload => queueRealtimeEvent({ kind: 'customerFinancial', payload }));
  channel = subscribeTable(channel, tableCashbookTransactionsName,
    payload => queueRealtimeEvent({ kind: 'cashbook', payload }));
  channel = subscribeTable(channel, tableStartingBalancesName,
    payload => queueRealtimeEvent({ kind: 'startingBalances', payload }));
  channel = subscribeTable(channel, tableSalesReturnsName,
    payload => queueRealtimeEvent({ kind: 'salesReturn', payload }));
  channel = subscribeTable(channel, tableSalesReturnItemsName,
    payload => queueRealtimeEvent({ kind: 'salesReturnItem', payload }));
  channel = subscribeTable(channel, tableProductsName,
    payload => queueRealtimeEvent({ kind: 'product', payload }));
  channel = subscribeTable(channel, tablePricelistsName,
    payload => queueRealtimeEvent({ kind: 'priceList', payload }));
  channel = subscribeTable(channel, tablePriceListItemsName,
    payload => queueRealtimeEvent({ kind: 'priceListItem', payload }));
  channel = subscribeTable(channel, tableBrandsName,
    payload => queueRealtimeEvent({ kind: 'brand', payload }));

  realtimeChannel = channel;
  channel.subscribe(status => {
    if (generation !== realtimeGeneration || channel !== realtimeChannel) return;
    realtimeStatus = status;
    if (status === 'SUBSCRIBED') {
      updateDbStatusUI('cloud', 'Đám mây • Trực tiếp');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      updateDbStatusUI('connecting', 'Đang nối lại dữ liệu trực tiếp...');
    }
  });

  onlineHandler = queueVisiblePanelCatchup;
  window.addEventListener('online', onlineHandler);
  return true;
}

export function getRealtimeSyncStatus() {
  return realtimeStatus;
}

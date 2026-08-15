const DATABASE_NAME = 'weblendon_authorized_pricing_cache';
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = 'snapshots';
const SNAPSHOT_VERSION = 1;

function normalizeActor(user) {
  const actorId = String(user?.authUserId || user?.auth_user_id || user?.id || '').trim();
  const role = String(user?.role || '').trim().toLowerCase();
  return actorId && role ? { actorId, role, key: `${actorId}::${role}` } : null;
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Không thể mở bộ nhớ bảng giá.'));
  });
}

function runTransaction(database, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, mode);
    const store = transaction.objectStore(SNAPSHOT_STORE);
    let result;
    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error || result?.error || new Error('Lỗi bộ nhớ bảng giá.'));
    transaction.onabort = () => reject(transaction.error || new Error('Giao dịch bộ nhớ bảng giá bị hủy.'));
  });
}

export function getPricingCacheKey(user) {
  return normalizeActor(user)?.key || '';
}

export async function loadAuthorizedPricingCache(user) {
  const actor = normalizeActor(user);
  if (!actor) return null;
  let database = null;
  try {
    database = await openDatabase();
    if (!database) return null;
    const snapshot = await runTransaction(database, 'readonly', store => store.get(actor.key));
    if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) return null;
    if (snapshot.actorId !== actor.actorId || snapshot.role !== actor.role) return null;
    if (!Array.isArray(snapshot.priceLists) || !Array.isArray(snapshot.priceListItems)) return null;
    return {
      actorId: snapshot.actorId,
      role: snapshot.role,
      cachedAt: snapshot.cachedAt || '',
      priceLists: snapshot.priceLists,
      priceListItems: snapshot.priceListItems
    };
  } catch (error) {
    console.warn('Không thể đọc bộ nhớ bảng giá của trình duyệt:', error.message);
    return null;
  } finally {
    database?.close();
  }
}

export async function saveAuthorizedPricingCache(user, priceLists, priceListItems) {
  const actor = normalizeActor(user);
  if (!actor || !Array.isArray(priceLists) || !Array.isArray(priceListItems)) return false;
  let database = null;
  try {
    database = await openDatabase();
    if (!database) return false;
    await runTransaction(database, 'readwrite', store => store.put({
      key: actor.key,
      version: SNAPSHOT_VERSION,
      actorId: actor.actorId,
      role: actor.role,
      cachedAt: new Date().toISOString(),
      priceLists,
      priceListItems
    }));
    return true;
  } catch (error) {
    // Cache is an acceleration layer only. Quota/private-mode failures must not
    // affect Cloud reads, pricing permissions, or order creation.
    console.warn('Không thể lưu bộ nhớ bảng giá của trình duyệt:', error.message);
    return false;
  } finally {
    database?.close();
  }
}

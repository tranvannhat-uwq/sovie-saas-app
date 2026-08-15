function normalizeIdentity(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getLoginUserForRevenueKey(revenueKey, users = []) {
  const key = normalizeIdentity(revenueKey);
  if (!key || key === 'unassigned') return null;

  return (users || []).find(user => {
    if (!user || user.isExternal === true || user.is_external === true) return false;
    if (user.isActive === false || user.is_active === false) return false;

    const authUserId = user.authUserId || user.auth_user_id;
    if (!authUserId) return false;

    return [user.id, authUserId, user.username, user.email]
      .some(identity => normalizeIdentity(identity) === key);
  }) || null;
}

export function filterLoginEmployeeRevenueRows(rows = [], users = []) {
  const totals = new Map();

  for (const row of rows || []) {
    const user = getLoginUserForRevenueKey(row?.key, users);
    if (!user) continue;

    const canonicalKey = user.username || user.authUserId || user.auth_user_id || user.id;
    const amount = Number(row?.amount || 0);
    totals.set(canonicalKey, (totals.get(canonicalKey) || 0) + (Number.isFinite(amount) ? amount : 0));
  }

  return [...totals.entries()].map(([key, amount]) => ({ key, amount }));
}

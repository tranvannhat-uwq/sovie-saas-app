function vietnamDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}${get('month')}${get('day')}`;
}

export function getOrderDisplayCode(order) {
  const explicitCode = order?.displayCode || order?.orderCode || order?.code;
  if (explicitCode) return String(explicitCode).trim();

  const technicalId = String(order?.id || '').trim();
  if (!technicalId) return 'Chưa có mã';
  if (!/^DRAFT-/i.test(technicalId)) return technicalId;

  const shortId = technicalId.replace(/^DRAFT-/i, '').replace(/[^a-z0-9]/gi, '')
    .slice(0, 6).toUpperCase() || '000000';
  const dateKey = vietnamDateKey(order?.date || order?.createdAt || order?.created_at);
  return `NH-${dateKey ? `${dateKey}-` : ''}${shortId}`;
}

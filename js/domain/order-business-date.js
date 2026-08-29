export const ORDER_DATE_TIME_ZONE = 'Asia/Bangkok';

export function canAdjustOrderBusinessDate(user) {
  return user?.role === 'admin' || user?.role === 'accounting';
}

function datePartsInTimeZone(value, timeZone = ORDER_DATE_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function timePartsInTimeZone(value, timeZone = ORDER_DATE_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

export function currentBusinessDateInputValue(now = new Date()) {
  return datePartsInTimeZone(now);
}

export function orderDateToInputValue(value, fallback = '') {
  return value ? (datePartsInTimeZone(value) || fallback) : fallback;
}

export function parseOrderBusinessDateInput(value, now = new Date()) {
  const input = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return { ok: false, message: 'Ngày lên đơn không hợp lệ.' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (calendarCheck.getUTCFullYear() !== year
      || calendarCheck.getUTCMonth() !== month - 1
      || calendarCheck.getUTCDate() !== day) {
    return { ok: false, message: 'Ngày lên đơn không tồn tại.' };
  }

  const today = currentBusinessDateInputValue(now);
  if (input > today) {
    return { ok: false, message: 'Ngày lên đơn không được lớn hơn ngày hiện tại.' };
  }

  // Keep the selected Vietnamese business day, but use the actual clock time
  // of finalization instead of making every order appear at 00:00.
  const businessTime = timePartsInTimeZone(now);
  return { ok: true, value: `${input}T${businessTime}+07:00`, dateKey: input };
}

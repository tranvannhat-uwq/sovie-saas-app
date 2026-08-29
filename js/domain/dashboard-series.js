const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function dateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function addDays(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function enumerateDays(start, end) {
  const keys = [];
  for (let key = start; key && key <= end; key = addDays(key, 1)) keys.push(key);
  return keys;
}

function dailyAmounts(series) {
  const amounts = new Map();
  (series || []).forEach(point => {
    const key = dateKey(point?.date);
    const amount = Number(point?.amount || 0);
    if (key && Number.isFinite(amount)) amounts.set(key, (amounts.get(key) || 0) + amount);
  });
  return amounts;
}

export function buildDashboardChartSeries(series, view, period = {}) {
  const amounts = dailyAmounts(series);
  const available = [...amounts.keys()].sort();
  const start = dateKey(period?.start) || available[0] || '';
  const inclusiveEnd = period?.end ? addDays(dateKey(period.end), -1) : (available.at(-1) || start);

  if (view === 'year') {
    const year = (start || available[0] || '').slice(0, 4);
    const keys = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);
    const monthly = new Map();
    amounts.forEach((amount, key) => {
      const monthKey = key.slice(0, 7);
      monthly.set(monthKey, (monthly.get(monthKey) || 0) + amount);
    });
    return { labels: keys.map((_, index) => `Th ${index + 1}`), dataPoints: keys.map(key => monthly.get(key) || 0) };
  }

  const keys = start && inclusiveEnd && start <= inclusiveEnd
    ? enumerateDays(start, inclusiveEnd)
    : available;
  const labels = keys.map(key => {
    const [, month, day] = key.split('-');
    if (view === 'month') return String(Number(day));
    if (view === 'week') {
      const [yearValue, monthValue, dayValue] = key.split('-').map(Number);
      const weekday = WEEKDAY_LABELS[new Date(Date.UTC(yearValue, monthValue - 1, dayValue)).getUTCDay()];
      return `${weekday} ${day}/${month}`;
    }
    return `${day}/${month}`;
  });
  return { labels, dataPoints: keys.map(key => amounts.get(key) || 0) };
}

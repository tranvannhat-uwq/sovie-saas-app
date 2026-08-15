const DAY_MS = 24 * 60 * 60 * 1000;

function toBusinessDateIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const parsed = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (
    !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)
    || parsed.getUTCFullYear() !== y
    || parsed.getUTCMonth() !== m - 1
    || parsed.getUTCDate() !== d
  ) return null;
  return parsed.toISOString();
}

export function parseExcelDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return toBusinessDateIso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const wholeDays = Math.floor(value);
    const excelDate = new Date(Date.UTC(1899, 11, 30) + wholeDays * DAY_MS);
    return toBusinessDateIso(excelDate.getUTCFullYear(), excelDate.getUTCMonth() + 1, excelDate.getUTCDate());
  }

  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (isoDate) return toBusinessDateIso(isoDate[1], isoDate[2], isoDate[3]);

  const dayFirst = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:\s+.*)?$/);
  if (dayFirst) return toBusinessDateIso(dayFirst[3], dayFirst[2], dayFirst[1]);

  return null;
}

export const parseImportedBusinessDate = parseExcelDate;

export function businessDateKey(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  return parseExcelDate(value)?.slice(0, 10) || '';
}

export const CANONICAL_APP_ORIGIN = 'https://sovie.vn';

export function canonicalAppUrl(path = '/', query = {}) {
  const url = new URL(path, CANONICAL_APP_ORIGIN);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

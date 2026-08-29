// SaaS development is pinned to the unused mobile staging clone. The
// publishable key is safe in the browser; RLS remains the security boundary.
// Never point this branch at the production project.
export const SAAS_STAGING_PROJECT_REF = 'mqxqswwssmemkimnolfu';
export const COMPANY_SUPABASE_URL = `https://${SAAS_STAGING_PROJECT_REF}.supabase.co`;
export const COMPANY_SUPABASE_KEY = "sb_publishable_u_LH0QHi0698kALk1MFEwQ_4t9_BLCa";

export function isSaasStagingSupabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === `${SAAS_STAGING_PROJECT_REF}.supabase.co`
      && url.port === '';
  } catch (_) {
    return false;
  }
}

export function assertSaasStagingConnection(url, key) {
  if (!isSaasStagingSupabaseUrl(url) || key !== COMPANY_SUPABASE_KEY) {
    throw new Error('Bản SaaS chỉ được phép kết nối với Supabase test đã chỉ định.');
  }
  return { url: COMPANY_SUPABASE_URL, key: COMPANY_SUPABASE_KEY };
}

// Danh sách sản phẩm mặc định (dùng khi chạy Offline cục bộ)
export const defaultProducts = [];

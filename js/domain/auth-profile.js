export const PROFILE_ROLES = Object.freeze(['admin', 'accounting', 'sale']);

export const LOGIN_ERROR = Object.freeze({
  AUTH_FAILED: 'AUTH_FAILED',
  DATABASE_NOT_MIGRATED: 'DATABASE_NOT_MIGRATED',
  PROFILE_NOT_LINKED: 'PROFILE_NOT_LINKED',
  PROFILE_LOCKED: 'PROFILE_LOCKED',
  ROLE_INVALID: 'ROLE_INVALID',
  PROFILE_ACCESS_DENIED: 'PROFILE_ACCESS_DENIED',
  PROFILE_DUPLICATE: 'PROFILE_DUPLICATE',
  MAINTENANCE: 'MAINTENANCE',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN'
});

const USER_MESSAGES = Object.freeze({
  [LOGIN_ERROR.AUTH_FAILED]: 'Email hoặc mật khẩu Supabase Auth không chính xác.',
  [LOGIN_ERROR.DATABASE_NOT_MIGRATED]: 'Cơ sở dữ liệu chưa được cập nhật đồng bộ với phiên bản ứng dụng.',
  [LOGIN_ERROR.PROFILE_NOT_LINKED]: 'Tài khoản đã xác thực nhưng chưa được liên kết với hồ sơ hệ thống.',
  [LOGIN_ERROR.PROFILE_LOCKED]: 'Tài khoản đã bị khóa.',
  [LOGIN_ERROR.ROLE_INVALID]: 'Hồ sơ người dùng có vai trò không hợp lệ. Liên hệ quản trị viên.',
  [LOGIN_ERROR.PROFILE_ACCESS_DENIED]: 'Không đủ quyền truy cập hồ sơ người dùng.',
  [LOGIN_ERROR.PROFILE_DUPLICATE]: 'Dữ liệu hồ sơ người dùng không nhất quán. Liên hệ quản trị viên.',
  [LOGIN_ERROR.MAINTENANCE]: 'Hệ thống đang bảo trì. Chỉ quản trị viên có thể truy cập lúc này.',
  [LOGIN_ERROR.NETWORK]: 'Không thể kết nối Supabase. Vui lòng kiểm tra mạng và thử lại.',
  [LOGIN_ERROR.UNKNOWN]: 'Không thể tải hồ sơ người dùng. Vui lòng thử lại.'
});

export function loginErrorMessage(code) {
  return USER_MESSAGES[code] || USER_MESSAGES[LOGIN_ERROR.UNKNOWN];
}

export function classifySupabaseError(error) {
  if (!error) return LOGIN_ERROR.UNKNOWN;
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || 0);

  if (
    error?.name === 'TypeError'
    || (Object.hasOwn(error, 'status') && status === 0)
    || message.includes('failed to fetch')
    || message.includes('network')
    || message.includes('load failed')
  ) return LOGIN_ERROR.NETWORK;

  if (
    code === '42P01'
    || code === 'PGRST202'
    || code === 'PGRST205'
    || message.includes('public.profiles') && (
      message.includes('does not exist')
      || message.includes('schema cache')
      || message.includes('could not find')
    )
  ) return LOGIN_ERROR.DATABASE_NOT_MIGRATED;

  if (code === '42501' || status === 401 || status === 403) {
    return LOGIN_ERROR.PROFILE_ACCESS_DENIED;
  }

  return LOGIN_ERROR.UNKNOWN;
}

export function validateProfileRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, code: LOGIN_ERROR.PROFILE_NOT_LINKED };
  }
  if (rows.length !== 1) {
    return { ok: false, code: LOGIN_ERROR.PROFILE_DUPLICATE };
  }
  const profile = rows[0];
  if (profile?.is_active !== true) {
    return { ok: false, code: LOGIN_ERROR.PROFILE_LOCKED };
  }
  if (!PROFILE_ROLES.includes(profile?.role)) {
    return { ok: false, code: LOGIN_ERROR.ROLE_INVALID };
  }
  return { ok: true, profile };
}

const BUSINESS_TYPES = new Set([
  'general_trade', 'retail', 'wholesale', 'distribution', 'services', 'manufacturing'
]);

const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'auth', 'dashboard', 'billing', 'support', 'status',
  'mail', 'cdn', 'static', 'assets', 'docs', 'help', 'system', 'platform', 'sovie'
]);

const INDUSTRY_ALIASES = Object.freeze({
  'da-nganh': 'general',
  'tong-hop': 'general',
  'thuong-mai-tong-hop': 'general',
  'ban-le': 'retail',
  'thuc-pham-do-uong': 'food_beverage',
  'thoi-trang': 'fashion',
  'xay-dung-vat-lieu': 'construction',
  'tu-van-dich-vu': 'consulting',
  'san-xuat': 'manufacturing',
  'son-phan-phoi': 'paint_distribution'
});

function asciiKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
}

export function normalizeIndustryKey(value = 'general') {
  const normalized = asciiKey(value || 'general');
  return INDUSTRY_ALIASES[normalized] || normalized || 'general';
}

export function normalizePlatformCustomerPayload(payload = {}) {
  const normalized = {
    name: String(payload.name || '').trim(),
    slug: String(payload.slug || '').trim().toLowerCase(),
    ownerEmail: String(payload.ownerEmail || '').trim().toLowerCase(),
    ownerName: String(payload.ownerName || '').trim(),
    planId: String(payload.planId || 'starter').trim().toLowerCase(),
    trialDays: Number(payload.trialDays ?? 14),
    businessType: String(payload.businessType || 'general_trade').trim().toLowerCase(),
    industryKey: normalizeIndustryKey(payload.industryKey)
  };

  if (normalized.name.length < 2 || normalized.name.length > 120) {
    throw new Error('Tên doanh nghiệp phải có từ 2 đến 120 ký tự.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized.slug) || RESERVED_SLUGS.has(normalized.slug)) {
    throw new Error('Tên miền con không hợp lệ hoặc đã được hệ thống giữ lại.');
  }
  if (!/^\S+@\S+\.\S+$/.test(normalized.ownerEmail)) {
    throw new Error('Email Owner không hợp lệ.');
  }
  if (normalized.ownerName.length < 2 || normalized.ownerName.length > 120) {
    throw new Error('Tên Owner phải có từ 2 đến 120 ký tự.');
  }
  if (!BUSINESS_TYPES.has(normalized.businessType)) {
    throw new Error('Mô hình kinh doanh không hợp lệ.');
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(normalized.industryKey)) {
    throw new Error('Ngành nghề không hợp lệ. Vui lòng chọn một ngành trong danh sách.');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized.planId)) {
    throw new Error('Gói dịch vụ không hợp lệ.');
  }
  if (!Number.isInteger(normalized.trialDays) || normalized.trialDays < 1 || normalized.trialDays > 60) {
    throw new Error('Thời gian dùng thử phải từ 1 đến 60 ngày.');
  }
  return normalized;
}

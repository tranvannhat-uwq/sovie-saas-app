// Hàm chuyển đổi chuỗi tiếng Việt sang dạng không dấu
export function removeVietnameseTones(str) {
  if (!str) return '';
  let result = String(str);
  result = result.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  result = result.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  result = result.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  result = result.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  result = result.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  result = result.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  result = result.replace(/đ/g, "d");
  result = result.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  result = result.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  result = result.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  result = result.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  result = result.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  result = result.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  result = result.replace(/Đ/g, "D");
  return result;
}

// Hàm hiển thị icon Lucide an toàn
export function safeCreateIcons() {
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    try {
      lucide.createIcons();
    } catch (e) {
      console.error("Lucide icon generation failed:", e);
    }
  }
}

// Định dạng tiền tệ VND
export function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND'
  }).format(amount);
}

// Định dạng số thông thường
export function formatNumber(amount) {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(amount));
}

// Lấy phần trăm phụ thu màu sơn từ ký tự cuối mã màu
export function getColorPercentFromCode(colorCode) {
  if (!colorCode) return 0;
  const lastChar = colorCode.trim().slice(-1).toUpperCase();
  if (lastChar === '.') return 5;
  if (lastChar === 'P') return 0;
  if (lastChar === 'T') return 15;
  if (lastChar === 'D') return 20;
  if (lastChar === 'A') return 25;
  return 0; // Mặc định 0%
}

// Tính đơn giá sau phụ thu màu từ giá gốc, không cộng dồn khi tính lại.
export function calculateColorMarkedUpPrice(basePrice, colorPercent) {
  const normalizedBasePrice = Number(basePrice);
  const normalizedColorPercent = Number(colorPercent);
  const safeBasePrice = Number.isFinite(normalizedBasePrice) ? Math.max(0, normalizedBasePrice) : 0;
  const safeColorPercent = Number.isFinite(normalizedColorPercent) ? Math.max(0, normalizedColorPercent) : 0;
  return Math.round(safeBasePrice * (1 + safeColorPercent / 100));
}

// Định dạng ngày giờ đầy đủ
export function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Trả về nhãn sơn gốc (giữ nguyên tên nhãn sơn sẵn có trong hệ thống)
export function getNormalizedBrandName(brandStr) {
  if (!brandStr || brandStr === 'Tất cả') return '';
  return String(brandStr).trim();
}

// Kiểm tra xem nhãn sơn có phải là FESTIVAL (nhãn dùng chung) hay không
export function isFestivalBrand(brandName) {
  if (!brandName) return false;
  const b = String(brandName).trim().toLowerCase();
  return b.includes('festiv');
}

// Kiểm tra xem nhãn sơn có phải là nhãn dùng chung (không chọn công ty quản lý riêng) hay không
export function isSharedBrand(brandName, brandsList = []) {
  if (!brandName) return false;
  if (isFestivalBrand(brandName)) return true;
  if (Array.isArray(brandsList) && brandsList.length > 0) {
    const found = brandsList.find(b => b.name && b.name.toLowerCase() === String(brandName).trim().toLowerCase());
    if (found && (!found.companyId || found.companyId === '' || found.companyName === 'Dùng chung')) {
      return true;
    }
  }
  return false;
}

// --- BỘ GIẢI ÁNH XẠ CHÍNH (FOREIGN KEY LOOKUP RESOLVERS) ---
import { state } from './state.js';

export function getBrandId(brandInput, brandsList = state.brands) {
  if (!brandInput || brandInput === 'Tất cả') return 'all';
  const str = String(brandInput).trim();
  const found = (brandsList || []).find(b => (b.id && b.id === str) || (b.name && b.name.toLowerCase() === str.toLowerCase()));
  if (found) return found.id || found.name;
  return str;
}

export function getBrandById(brandId, brandsList = state.brands) {
  if (!brandId || brandId === 'all' || brandId === 'Tất cả') return null;
  const str = String(brandId).trim();
  const list = brandsList || [];
  const normalizeBrandKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  
  let found = list.find(b => (b.id && b.id === str) || (b.name && b.name.toLowerCase() === str.toLowerCase()));
  if (found) return found;

  const normalizedInput = normalizeBrandKey(str).replace(/^brand/, '');
  found = list.find(b => {
    const normalizedId = normalizeBrandKey(b?.id).replace(/^brand/, '');
    const normalizedName = normalizeBrandKey(b?.name);
    return normalizedInput && (normalizedId === normalizedInput || normalizedName === normalizedInput);
  });
  if (found) return found;

  // Old imports used several variants for the same stable brand key. The brand
  // name may later change, but its ID still lets those products follow the rename.
  const legacyKeys = ['tdkaw', 'cova', 'festiva', 'hatacco', 'mutsutec', 'nano10'];
  const legacyKey = legacyKeys.find(key => normalizedInput.includes(key));
  if (legacyKey) {
    found = list.find(b => normalizeBrandKey(b?.id).includes(legacyKey));
    if (found) return found;
  }

  const aliasMap = {
    'cova': 'COVA NANO',
    'covanano': 'COVA NANO',
    'cova nano': 'COVA NANO',
    'festivanano': 'FESTIVA NANO',
    'festiva nano': 'FESTIVA NANO',
    'festiva': 'FESTIVA NANO',
    'hatacco': 'Hatacco nano',
    'hatacconano': 'Hatacco nano',
    'hatacco nano': 'Hatacco nano',
    'nano10': 'Nano10*',
    'nano10*': 'Nano10*',
    'mutsutec': 'mutsutec',
    'tdkaw': 'tdkaw'
  };

  const norm = str.toLowerCase();
  if (aliasMap[norm]) {
    const canonicalName = aliasMap[norm];
    found = list.find(b => b.name && b.name.toLowerCase() === canonicalName.toLowerCase());
  }

  return found || null;
}

export function getBrandName(brandId, fallback = '', brandsList = state.brands) {
  if (!brandId || brandId === 'all' || brandId === 'Tất cả') return fallback || 'Tất cả';
  const brand = getBrandById(brandId, brandsList);
  return brand ? brand.name : (fallback || brandId);
}

export function normalizeCompanyId(companyIdOrName, brandName = '') {
  if (!companyIdOrName && !brandName) return 'ABS_NORTH';

  const str = String(companyIdOrName || '').trim().toLowerCase();

  if (str === 'abs_north' || str.includes('miền bắc') || str.includes('north') || str.includes('bắc')) {
    return 'ABS_NORTH';
  }
  if (str === 'abs_south' || str.includes('miền nam') || str.includes('south') || str.includes('nam')) {
    return 'ABS_SOUTH';
  }
  if (str === 'emp_usa' || str.includes('emp')) {
    return 'EMP_USA';
  }

  if (brandName) {
    return getCompanyIdByBrand(brandName);
  }

  if (str.includes('abs') || str.includes('ctyabs') || str.includes('cova')) {
    return 'ABS_NORTH';
  }

  return 'ABS_NORTH';
}

export function getCompanyById(companyId, companiesList = state.companies) {
  if (!companyId || companyId === 'all') return null;
  const normId = normalizeCompanyId(companyId);
  return (companiesList || []).find(c => {
    if (!c) return false;
    const cId = (c.id || '').toLowerCase();
    const cCode = (c.code || '').toLowerCase();
    const cName = (c.name || '').toLowerCase();
    return cId === normId || cCode === normId || cName === normId;
  }) || null;
}

export function getCompanyName(companyId, companiesList = state.companies) {
  if (!companyId || companyId === 'all') return 'Tất cả công ty';
  const normId = normalizeCompanyId(companyId);
  const comp = (companiesList || []).find(c => c && c.id === normId);
  if (comp) return comp.name;

  if (normId === 'ABS_NORTH') return 'Công ty Cổ phần ABS JAPAN (Miền Bắc)';
  if (normId === 'ABS_SOUTH') return 'Công ty Cổ phần ABS JAPAN - Chi nhánh Miền Nam';
  if (normId === 'EMP_USA') return 'Công ty Cổ phần EMP Hoa Kỳ';
  return companyId;
}

export function getCanonicalBrandName(brandStr, brandsList = state.brands) {
  if (!brandStr) return 'COVA NANO';
  const rawStr = brandStr.toString().trim();
  const cleanName = rawStr.toLowerCase().replace(/[^a-z0-9]/g, '');
  const linkedBrand = getBrandById(rawStr, brandsList);
  if (linkedBrand) return linkedBrand.name;

  const foundB = (brandsList || []).find(b => {
    if (!b || !b.name) return false;
    const bRaw = b.name.toString().trim();
    const bClean = bRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
    return bRaw === rawStr || bClean === cleanName;
  });
  if (foundB) return foundB.name;

  if (cleanName.includes('nano10mn') || cleanName.includes('10mn')) return 'NANO10 MN';
  if (cleanName.includes('nano10mb') || cleanName.includes('10mb') || cleanName.includes('nano10')) return 'NANO10 MB';
  if (cleanName.includes('cova')) return 'COVA NANO';
  if (cleanName.includes('mutsutec')) return 'MUTSUTEC NANO';
  if (cleanName.includes('tdkaw')) return 'TDKAW NANO';
  if (cleanName.includes('festiva') || cleanName.includes('festival')) return 'FESTIVA NANO';
  if (cleanName.includes('hatacco')) return 'HATACCO NANO';

  return rawStr;
}

export function getCompanyIdByBrand(brandName, brandsList = state.brands) {
  if (!brandName) return 'ABS_NORTH';
  const rawStr = brandName.toString().trim().toLowerCase();
  const cleanName = rawStr.replace(/[^a-z0-9]/g, '');

  // 1. Direct search in state.brands
  const foundB = (brandsList || []).find(b => {
    if (!b || !b.name) return false;
    const bRaw = b.name.toString().trim().toLowerCase();
    const bClean = bRaw.replace(/[^a-z0-9]/g, '');
    return bRaw === rawStr || bClean === cleanName || cleanName.includes(bClean) || bClean.includes(cleanName);
  });

  if (foundB) {
    if (foundB.companyId && foundB.companyId !== 'shared' && foundB.companyId !== 'all') {
      return foundB.companyId;
    }
    if (foundB.companyName) {
      const cName = foundB.companyName.toLowerCase();
      if (cName.includes('miền nam') || cName.includes('mn') || cName.includes('south')) return 'ABS_SOUTH';
      if (cName.includes('emp')) return 'EMP_USA';
      if (cName.includes('abs')) return 'ABS_NORTH';
    }
  }

  // 2. Precise rule-based mapping matching database schema
  if (cleanName.includes('nano10mn') || cleanName.includes('10mn')) return 'ABS_SOUTH';
  if (cleanName.includes('nano10mb') || cleanName.includes('10mb') || cleanName.includes('nano10')) return 'ABS_NORTH';
  if (cleanName.includes('cova')) return 'ABS_NORTH';
  if (cleanName.includes('mutsutec')) return 'ABS_NORTH';
  if (cleanName.includes('tdkaw')) return 'ABS_NORTH';
  if (cleanName.includes('festiva') || cleanName.includes('festival')) return 'EMP_USA';
  if (cleanName.includes('hatacco')) return 'EMP_USA';

  return 'ABS_NORTH';
}

export function getCustomerById(customerId, customersList = state.customers) {
  if (!customerId || customerId === 'all') return null;
  const str = String(customerId).trim();
  return (customersList || []).find(c => c.id === str || c.code === str) || null;
}

export function getCustomerName(customerId, fallbackName = '', customersList = state.customers) {
  if (!customerId || customerId === 'all') return fallbackName || 'Khách hàng';
  const cust = getCustomerById(customerId, customersList);
  return cust ? cust.name : (fallbackName || customerId);
}

export function getUserById(userIdOrUsername, usersList = state.users) {
  if (!userIdOrUsername || userIdOrUsername === 'all') return null;
  const str = String(userIdOrUsername).trim();
  return (usersList || []).find(u =>
    String(u.id || '') === str
    || String(u.authUserId || u.auth_user_id || '') === str
    || isSameUser(u.username, str)
    || isSameUser(u.email, str)
  ) || null;
}

export function getUserDisplayName(userIdOrUsername, fallbackName = '', usersList = state.users) {
  if (Array.isArray(fallbackName)) {
    usersList = fallbackName;
    fallbackName = '';
  }
  if (!usersList || !Array.isArray(usersList)) {
    usersList = state.users || [];
  }

  if (!userIdOrUsername || userIdOrUsername === 'all') return fallbackName || 'Nhân viên';

  let target = userIdOrUsername;
  if (typeof target === 'object') {
    if (Array.isArray(target)) {
      const names = target.map(u => getUserDisplayName(u, fallbackName, usersList)).filter(Boolean);
      return names.length > 0 ? names.join(', ') : (fallbackName || 'Nhân viên');
    }
    target = target.displayName || target.username || target.name || target.id || '';
  }

  const str = String(target).trim();
  if (!str || str === 'null' || str === 'undefined' || str === 'Unknown' || str === 'unassigned' || str.startsWith('[object Object]')) {
    return fallbackName || 'Chưa phân công / Khác';
  }

  if (str.startsWith('{') || str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      return getUserDisplayName(parsed, fallbackName, usersList);
    } catch (e) {}
  }

  const cleanStr = str.toLowerCase();
  if (cleanStr === 'ctyabs@lendon.com' || cleanStr.includes('abs_japan') || cleanStr.includes('abs-japan') || cleanStr === 'ctyabs') {
    return 'ABS JAPAN (Công ty)';
  }
  if (cleanStr === 'emp_hoa_ky' || cleanStr.includes('emp-hoa-ky') || cleanStr === 'emp_hoaky') {
    return 'EMP Hoa Kỳ (Công ty)';
  }

  const user = getUserById(str, usersList);
  if (user) return user.displayName;

  if (str.includes('@')) return str.split('@')[0];
  return fallbackName || str;
}

export function getPricelistById(pricelistId, pricelistsList = state.pricelists) {
  if (!pricelistId) return null;
  const str = String(pricelistId).trim();
  return (pricelistsList || []).find(p => p.id === str) || null;
}

export function getPricelistName(pricelistId, pricelistsList = state.pricelists) {
  if (!pricelistId || pricelistId === 'retail') return 'Bán lẻ (Giá chuẩn)';
  const pl = getPricelistById(pricelistId, pricelistsList);
  return pl ? pl.name : pricelistId;
}

// Lấy tên công ty theo ID
export function getCompanyNameById(companyId, companiesList = state.companies) {
  return getCompanyName(companyId, companiesList);
}

// Lấy ID công ty của nhân viên hiện tại
export function getUserCompanyId(user) {
  if (!user) return 'ABS_NORTH';
  return user.companyId || user.company_id || 'ABS_NORTH';
}

// Xác định các thuộc tính doanh thu cho một dòng sản phẩm đơn hàng
export function getRevenueAttributes(itemBrand, customerAgencyBrand, orderCompanyId, brandsList = state.brands) {
  const productBrand = itemBrand || 'Nano10*';
  const agencyBrand = (customerAgencyBrand && customerAgencyBrand !== 'Tất cả') ? customerAgencyBrand : productBrand;
  const revenueBrand = (isFestivalBrand(productBrand) || isSharedBrand(productBrand, brandsList)) ? agencyBrand : productBrand;

  let revenueCompany = getCompanyIdByBrand(revenueBrand, brandsList) || orderCompanyId || 'ABS_NORTH';

  return {
    productBrand,
    agencyBrand,
    revenueBrand,
    revenueCompany
  };
}

// Định dạng chỉ hiển thị ngày
export function formatDateOnly(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
}

// Hiển thị thông báo Toast
export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'danger' ? 'toast-danger' : type === 'warning' ? 'toast-warning' : ''}`;
  
  let iconName = 'check-circle';
  if (type === 'danger') iconName = 'alert-triangle';
  if (type === 'warning') iconName = 'alert-circle';
  
  toast.innerHTML = `
    <i data-lucide="${iconName}"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  safeCreateIcons();
  
  // Fade out và xóa khỏi DOM
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 3000);
}

// Cập nhật giao diện trạng thái đồng bộ cơ sở dữ liệu
export function updateDbStatusUI(status, message = '') {
  const badge = document.getElementById('db-status-badge');
  if (!badge) return;
  badge.className = 'db-status-badge'; // reset
  badge.style.border = ''; // reset styles
  
  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  
  if (status === 'cloud') {
    badge.classList.add('status-cloud');
    badge.innerHTML = `<i data-lucide="cloud" style="width:12px;height:12px;"></i> ${message || 'Đám mây (Supabase)'}`;
  } else if (status === 'connecting') {
    badge.classList.add('status-connecting');
    badge.innerHTML = `<i data-lucide="loader" style="width:12px;height:12px;animation:spin 1s linear infinite;"></i> ${message || 'Đang kết nối...'}`;
  } else if (status === 'local_failed' && savedUrl && savedKey) {
    badge.classList.add('status-local');
    badge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
    badge.innerHTML = `
      <i data-lucide="database" style="width:12px;height:12px;"></i> Cục bộ (Lỗi Cloud)
      <button id="btn-retry-connection" style="background: var(--color-primary); color: #fff; border: none; padding: 2px 8px; border-radius: 4px; margin-left: 8px; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-weight: 500; font-family: var(--font-sans);">
        <i data-lucide="refresh-cw" style="width:10px;height:10px;"></i> Kết nối lại
      </button>
    `;
  } else {
    badge.classList.add('status-local');
    badge.innerHTML = `<i data-lucide="database" style="width:12px;height:12px;"></i> Cục bộ (LocalStorage)${message ? ` - ${message}` : ''}`;
  }
  safeCreateIcons();
}

// Định dạng số điện thoại ngăn cách bằng dấu chấm
export function formatPhoneNumber(phone) {
  if (!phone) return 'N/A';
  const clean = phone.toString().replace(/\D/g, '');
  if (clean.length === 10) {
    return `${clean.slice(0, 4)}.${clean.slice(4, 7)}.${clean.slice(7)}`;
  } else if (clean.length === 11) {
    return `${clean.slice(0, 4)}.${clean.slice(4, 7)}.${clean.slice(7, 10)}.${clean.slice(10)}`;
  } else if (clean.length === 9) {
    return `${clean.slice(0, 3)}.${clean.slice(3, 6)}.${clean.slice(6)}`;
  }
  return phone;
}

// So sánh hai tên đăng nhập / email linh hoạt (không phân biệt hoa thường và so khớp tiền tố)
export function isSameUser(u1, u2) {
  if (!u1 || !u2) return false;
  const clean1 = u1.toLowerCase().trim();
  const clean2 = u2.toLowerCase().trim();
  if (clean1 === clean2) return true;
  
  // Coi abs_japan, abs-japan và ctyabs@lendon.com (bao gồm cả dạng đuôi @lendon.com) là cùng một người quản lý (Tài khoản công ty ABS JAPAN)
  const isAbs1 = clean1.includes('abs_japan') || clean1.includes('abs-japan') || clean1.includes('ctyabs') || clean1.includes('absjapan');
  const isAbs2 = clean2.includes('abs_japan') || clean2.includes('abs-japan') || clean2.includes('ctyabs') || clean2.includes('absjapan');
  if (isAbs1 && isAbs2) return true;

  const prefix1 = clean1.split('@')[0];
  const prefix2 = clean2.split('@')[0];
  return prefix1 === prefix2;
}

// Lấy tên hiển thị của người quản lý linh hoạt, hỗ trợ fallback cho tài khoản công ty và email
export function getManagerDisplayName(managedBy, fallbackName = '', usersList = state.users) {
  if (Array.isArray(fallbackName)) {
    usersList = fallbackName;
    fallbackName = '';
  }
  if (!usersList || !Array.isArray(usersList)) {
    usersList = state.users || [];
  }

  if (!managedBy) return fallbackName || 'Chưa bàn giao / Khác';

  let target = managedBy;
  if (typeof target === 'object') {
    if (Array.isArray(target)) {
      const names = target.map(m => getManagerDisplayName(m, fallbackName, usersList)).filter(Boolean);
      return names.length > 0 ? names.join(', ') : (fallbackName || 'Chưa bàn giao / Khác');
    }
    target = target.username || target.id || target.displayName || target.name || '';
  }

  const strM = String(target).trim();
  if (!strM || strM === 'null' || strM === 'undefined' || strM === 'Unknown' || strM === 'unassigned' || strM.startsWith('[object Object]')) {
    return fallbackName || 'Chưa bàn giao / Khác';
  }

  if (strM.startsWith('{') || strM.startsWith('[')) {
    try {
      const parsed = JSON.parse(strM);
      return getManagerDisplayName(parsed, fallbackName, usersList);
    } catch (e) {}
  }

  const cleanM = strM.toLowerCase();
  if (cleanM === 'ctyabs@lendon.com' || cleanM.includes('abs_japan') || cleanM.includes('abs-japan') || cleanM === 'ctyabs') {
    return 'ABS JAPAN (Công ty)';
  }
  if (cleanM === 'emp_hoa_ky' || cleanM.includes('emp-hoa-ky') || cleanM === 'emp_hoaky') {
    return 'EMP Hoa Kỳ (Công ty)';
  }

  const u = usersList.find(usr => isSameUser(usr.username, strM) || isSameUser(usr.id, strM));
  if (u) return u.displayName;

  if (strM.includes('@')) return strM.split('@')[0];
  return fallbackName || strM;
}

export const PROVINCES = {
  AG: 'An Giang',
  BRVT: 'Bà Rịa - Vũng Tàu',
  BG: 'Bắc Giang',
  BK: 'Bắc Kạn',
  BL: 'Bạc Liêu',
  BN: 'Bắc Ninh',
  BT: 'Bến Tre',
  BDI: 'Bình Định',
  BD: 'Bình Dương',
  BP: 'Bình Phước',
  BTH: 'Bình Thuận',
  CM: 'Cà Mau',
  CT: 'Cần Thơ',
  CB: 'Cao Bằng',
  DN: 'Đà Nẵng',
  DL: 'Đắk Lắk',
  DNO: 'Đắk Nông',
  DB: 'Điện Biên',
  DNai: 'Đồng Nai',
  DT: 'Đồng Tháp',
  GL: 'Gia Lai',
  HG: 'Hà Giang',
  HNam: 'Hà Nam',
  HN: 'Hà Nội',
  HT: 'Hà Tĩnh',
  HD: 'Hải Dương',
  HP: 'Hải Phòng',
  HGi: 'Hậu Giang',
  HB: 'Hòa Bình',
  HY: 'Hưng Yên',
  KH: 'Khánh Hòa',
  KG: 'Kiên Giang',
  KT: 'Kon Tum',
  LC: 'Lai Châu',
  LD: 'Lâm Đồng',
  LS: 'Lạng Sơn',
  LCai: 'Lào Cai',
  LA: 'Long An',
  ND: 'Nam Định',
  NA: 'Nghệ An',
  NBi: 'Ninh Bình',
  NT: 'Ninh Thuận',
  PT: 'Phú Thọ',
  PY: 'Phú Yên',
  QB: 'Quảng Bình',
  QNa: 'Quảng Nam',
  QNg: 'Quảng Ngãi',
  QN: 'Quảng Ninh',
  QT: 'Quảng Trị',
  ST: 'Sóc Trăng',
  SL: 'Sơn La',
  TNin: 'Tây Ninh',
  TB: 'Thái Bình',
  TN: 'Thái Nguyên',
  TH: 'Thanh Hóa',
  TTH: 'Thừa Thiên Huế',
  TG: 'Tiền Giang',
  HCM: 'TP Hồ Chí Minh',
  TV: 'Trà Vinh',
  TQ: 'Tuyên Quang',
  VL: 'Vĩnh Long',
  VP: 'Vĩnh Phúc',
  YB: 'Yên Bái',
  OTHER: 'Khác'
};

export function getProvinceNameByCode(code) {
  return PROVINCES[code] || '';
}

// Biến đổi thẻ select thường thành dạng có hỗ trợ tìm kiếm từ khóa
export function makeSelectSearchable(selectId, placeholder = 'Tìm kiếm...', showSearchInput = true) {
  const select = document.getElementById(selectId);
  if (!select) return;
  
  // Tránh tạo lặp nhiều lần wrapper
  if (select.parentNode.classList.contains('searchable-select-wrapper')) {
    const label = select.parentNode.querySelector('.searchable-select-label');
    if (label) label.innerText = select.options[select.selectedIndex]?.text || placeholder;
    if (select.value === 'Tất cả' || select.value === '') {
      select.classList.add('default-red');
    } else {
      select.classList.remove('default-red');
    }
    return;
  }
  
  // Tạo wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-select-wrapper';
  
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.style.display = 'none';
  if (select.value === 'Tất cả' || select.value === '') {
    select.classList.add('default-red');
  } else {
    select.classList.remove('default-red');
  }
  
  // Tạo nút trigger hiển thị lựa chọn hiện tại
  const trigger = document.createElement('div');
  trigger.className = 'searchable-select-trigger';
  
  const label = document.createElement('span');
  label.className = 'searchable-select-label';
  label.innerText = select.options[select.selectedIndex]?.text || placeholder;
  trigger.appendChild(label);
  
  const icon = document.createElement('span');
  icon.innerHTML = '<i data-lucide="chevron-down" style="width: 16px; height: 16px; color: var(--text-secondary);"></i>';
  trigger.appendChild(icon);
  
  wrapper.appendChild(trigger);
  
  // Tạo hộp dropdown chứa ô tìm kiếm và danh sách lựa chọn
  const dropdown = document.createElement('div');
  dropdown.className = 'searchable-select-dropdown';
  
  let searchInput = null;
  if (showSearchInput) {
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'searchable-select-search-input';
    searchInput.placeholder = placeholder;
    dropdown.appendChild(searchInput);
  }
  
  const list = document.createElement('div');
  list.className = 'searchable-select-options-list';
  dropdown.appendChild(list);
  
  wrapper.appendChild(dropdown);
  
  function updateOptions() {
    list.innerHTML = '';
    const options = Array.from(select.options);
    const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    // Hàm chuẩn hóa tiếng Việt không dấu để tìm kiếm thông minh hơn
    const removeAccents = str => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
    const searchValNorm = removeAccents(searchVal);
    
    const filtered = options.filter(opt => {
      if (!searchInput) return true;
      const text = opt.text.toLowerCase();
      const textNorm = removeAccents(text);
      return text.includes(searchVal) || textNorm.includes(searchValNorm);
    });
    
    if (filtered.length === 0) {
      const noRes = document.createElement('div');
      noRes.innerText = 'Không tìm thấy kết quả';
      noRes.style.padding = '10px';
      noRes.style.color = 'var(--text-muted)';
      noRes.style.fontSize = '0.85rem';
      noRes.style.textAlign = 'center';
      list.appendChild(noRes);
      return;
    }
    
    filtered.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'searchable-select-option-item';
      if (opt.selected) item.classList.add('selected');
      item.innerText = opt.text;
      
      if (opt.value === 'Tất cả' || opt.text === 'Chọn nhãn sơn') {
        item.style.setProperty('color', '#ff0000', 'important');
        item.style.setProperty('font-weight', 'bold', 'important');
      }
      
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        select.value = opt.value;
        label.innerText = opt.text;
        
        if (opt.value === 'Tất cả' || opt.value === '') {
          select.classList.add('default-red');
        } else {
          select.classList.remove('default-red');
        }
        
        select.dispatchEvent(new Event('change'));
        
        dropdown.style.display = 'none';
        if (searchInput) searchInput.value = '';
      });
      list.appendChild(item);
    });
  }
  
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isShowing = dropdown.style.display === 'flex';
    document.querySelectorAll('.searchable-select-dropdown').forEach(d => d.style.display = 'none');
    
    if (!isShowing) {
      dropdown.style.display = 'flex';
      updateOptions();
      if (searchInput) setTimeout(() => searchInput.focus(), 50);
    } else {
      dropdown.style.display = 'none';
    }
  });
  
  if (searchInput) searchInput.addEventListener('input', updateOptions);
  
  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      dropdown.style.display = 'none';
      if (searchInput) searchInput.value = '';
    }
  });
  
  const updateDisabledState = () => {
    if (select.disabled || select.hasAttribute('disabled')) {
      trigger.style.pointerEvents = 'none';
      trigger.style.opacity = '0.65';
      trigger.style.cursor = 'not-allowed';
      trigger.style.backgroundColor = 'rgba(255,255,255,0.05)';
    } else {
      trigger.style.pointerEvents = 'auto';
      trigger.style.opacity = '1';
      trigger.style.cursor = 'pointer';
      trigger.style.backgroundColor = '';
    }
  };

  const observer = new MutationObserver(() => {
    label.innerText = select.options[select.selectedIndex]?.text || placeholder;
    updateDisabledState();
  });
  observer.observe(select, { childList: true, subtree: true, attributes: true });
  
  updateDisabledState();
  
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    set: function(val) {
      descriptor.set.call(this, val);
      label.innerText = select.options[select.selectedIndex]?.text || placeholder;
    },
    get: function() {
      return descriptor.get.call(this);
    }
  });
}

export function docSoTienBangChu(number) {
  if (number === 0) return 'Không đồng';
  
  const chuSo = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  let units = ['', 'nghìn', 'triệu', 'tỷ'];
  
  let temp = Math.abs(number);
  let blocks = [];
  
  while (temp > 0) {
    blocks.push(temp % 1000);
    temp = Math.floor(temp / 1000);
  }
  
  let result = '';
  
  for (let i = blocks.length - 1; i >= 0; i--) {
    let block = blocks[i];
    if (block === 0) {
      continue;
    }
    
    let tram = Math.floor(block / 100);
    let chuc = Math.floor((block % 100) / 10);
    let donvi = block % 10;
    
    let blockStr = '';
    
    if (i < blocks.length - 1 || tram > 0) {
      blockStr += chuSo[tram] + ' trăm ';
    }
    
    if (chuc === 0) {
      if (donvi > 0 && (i < blocks.length - 1 || tram > 0)) {
        blockStr += 'linh ';
      }
    } else if (chuc === 1) {
      blockStr += 'mười ';
    } else {
      blockStr += chuSo[chuc] + ' mươi ';
    }
    
    if (donvi === 1) {
      if (chuc > 1) {
        blockStr += 'mốt ';
      } else {
        blockStr += 'một ';
      }
    } else if (donvi === 5) {
      if (chuc > 0) {
        blockStr += 'lăm ';
      } else {
        blockStr += 'năm ';
      }
    } else if (donvi === 4) {
      if (chuc > 1) {
        blockStr += 'tư ';
      } else {
        blockStr += 'bốn ';
      }
    } else if (donvi > 0) {
      blockStr += chuSo[donvi] + ' ';
    }
    
    blockStr += units[i] + ' ';
    result += blockStr;
  }
  
  result = result.trim().replace(/\s+/g, ' ');
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1) + ' đồng chẵn';
  }
  return result;
}

import { parseExcelDate } from './import-date.js';

const FIELD_ALIASES = Object.freeze({
  invoiceNumber: ['mahd', 'sohoadon', 'mahoadon', 'invoice number', 'invoice no'],
  date: ['ngayhoadon', 'ngaylap', 'ngaychungtu', 'invoice date'],
  itemCode: ['mahang', 'masp', 'sku', 'product code', 'item code'],
  itemName: ['tenhanghoa', 'tenhang', 'tensanpham', 'product name', 'item name'],
  unit: ['dvt', 'donvitinh', 'unit'],
  quantity: ['soluong', 'sl', 'quantity', 'qty'],
  unitPrice: ['dongia', 'don gia', 'unit price'],
  lineAmount: ['thanhtien', 'tienhang', 'line total', 'amount'],
  taxRate: ['thuesuat', 'thuesuatvat', 'thuesuatkhac', 'vat rate', 'tax rate'],
  taxAmount: ['tienthue', 'tienvat', 'vat amount', 'tax amount'],
  currency: ['tiente', 'currency'],
  buyerCode: ['makhachhang', 'customer code', 'buyer code'],
  buyerName: ['tennguoimua', 'tenkhachhang', 'tennguoinhan'],
  buyerCompany: ['tendonvi', 'tencongty', 'buyer company'],
  buyerTaxCode: ['masothue', 'masothuebenuam', 'buyer tax code'],
  buyerAddress: ['diachikhachhang', 'diachibenuam', 'buyer address'],
  buyerEmail: ['email'],
  issuerName: ['tennguoiban', 'tennguoibanhang', 'tennguoiguihang', 'tennguoixuat', 'seller name', 'issuer name'],
  issuerTaxCode: ['masothuenguoiban', 'masothuenguoiguihang', 'seller tax code', 'issuer tax code'],
  paymentMethod: ['hinhthucthanhtoan', 'phuongthucthanhtoan', 'payment method'],
  notes: ['ghichu', 'ghichudong', 'notes'],
  invoiceDiscount: ['giamtruhoadon', 'tiengiamtruhoadon', 'invoice discount'],
  lineDiscount: ['giamtrutungdonghanghoa', 'tiengiamtru', 'tienchietkhau', 'line discount'],
  discountRate: ['tyle chietkhau', 'tylechietkhau', 'discount rate'],
  rowNumber: ['sott', 'stt', 'line number'],
  lineType: ['tinhchat', 'linetype']
});

const REQUIRED_FIELDS = ['invoiceNumber', 'date', 'itemCode', 'itemName', 'quantity', 'unitPrice', 'lineAmount', 'taxRate', 'taxAmount'];
const UNSUPPORTED_DISCOUNT_FIELDS = ['invoiceDiscount', 'lineDiscount', 'discountRate'];

export function normalizeInvoiceImportHeader(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, match => match === 'Đ' ? 'D' : 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fieldValues(row, mapping, key) {
  const indexes = mapping[key] === undefined
    ? []
    : (Array.isArray(mapping[key]) ? mapping[key] : [mapping[key]]);
  return indexes.map(index => row[index]);
}

function fieldValue(row, mapping, key) {
  return fieldValues(row, mapping, key).find(meaningful) ?? null;
}

function meaningful(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function parseInvoiceImportNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!meaningful(value)) return null;

  let text = String(value).trim()
    .replace(/\s/g, '')
    .replace(/(?:VND|VNĐ|₫)/gi, '');
  if (!/^[+-]?[\d.,]+$/.test(text)) return null;

  const sign = text.startsWith('-') ? -1 : 1;
  text = text.replace(/^[+-]/, '');
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  const lastSeparator = Math.max(lastDot, lastComma);
  const separatorCount = (text.match(/[.,]/g) || []).length;

  if (lastSeparator >= 0) {
    const decimalDigits = text.length - lastSeparator - 1;
    const hasBothSeparators = lastDot >= 0 && lastComma >= 0;
    const groupedInteger = decimalDigits === 3 && !hasBothSeparators && separatorCount === 1;
    if (hasBothSeparators || (decimalDigits > 0 && decimalDigits <= 2 && !groupedInteger)) {
      const integerPart = text.slice(0, lastSeparator).replace(/[.,]/g, '');
      const decimalPart = text.slice(lastSeparator + 1);
      text = `${integerPart}.${decimalPart}`;
    } else {
      text = text.replace(/[.,]/g, '');
    }
  }

  const parsed = Number(text) * sign;
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveHeaderMapping(headerRow) {
  const normalizedHeaders = headerRow.map(normalizeInvoiceImportHeader);
  const mapping = {};
  const multiColumnFields = new Set([...UNSUPPORTED_DISCOUNT_FIELDS, 'taxRate']);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const accepted = new Set(aliases.map(normalizeInvoiceImportHeader));
    const matches = normalizedHeaders
      .map((header, index) => accepted.has(header) ? index : -1)
      .filter(index => index >= 0);
    if (matches.length > 1 && !multiColumnFields.has(field)) {
      return { error: `Có nhiều cột cùng khớp trường “${field}”. Hãy giữ lại một cột.` };
    }
    if (matches.length === 1) mapping[field] = matches[0];
    if (matches.length > 1) mapping[field] = matches;
  }

  const missing = REQUIRED_FIELDS.filter(field => mapping[field] === undefined);
  return missing.length
    ? { error: `Thiếu cột bắt buộc: ${missing.join(', ')}.` }
    : { mapping };
}

function normalizedText(value) {
  return meaningful(value) ? String(value).trim().replace(/\s+/g, ' ') : '';
}

function consistentValue(group, field, candidate, rowNumber, issueLabel) {
  if (!meaningful(candidate)) return;
  const value = normalizedText(candidate);
  if (!group[field]) {
    group[field] = value;
  } else if (group[field].toLowerCase() !== value.toLowerCase()) {
    group.issues.push(`Dòng ${rowNumber}: ${issueLabel} không nhất quán trong cùng hóa đơn.`);
  }
}

function sourceRowToItem(row, mapping, sourceRowNumber) {
  const invoiceNumber = normalizedText(fieldValue(row, mapping, 'invoiceNumber'));
  const dateValue = fieldValue(row, mapping, 'date');
  const date = parseExcelDate(dateValue);
  const quantity = parseInvoiceImportNumber(fieldValue(row, mapping, 'quantity'));
  const unitPrice = parseInvoiceImportNumber(fieldValue(row, mapping, 'unitPrice'));
  const lineAmount = parseInvoiceImportNumber(fieldValue(row, mapping, 'lineAmount'));
  const rawTaxRates = fieldValues(row, mapping, 'taxRate').filter(meaningful);
  const parsedTaxRates = rawTaxRates.map(parseInvoiceImportNumber);
  const taxRate = parsedTaxRates.find(value => value !== null) ?? null;
  const taxAmount = parseInvoiceImportNumber(fieldValue(row, mapping, 'taxAmount'));
  const code = normalizedText(fieldValue(row, mapping, 'itemCode'));
  const name = normalizedText(fieldValue(row, mapping, 'itemName'));
  const issues = [];

  if (!invoiceNumber) issues.push('Thiếu mã hóa đơn.');
  if (!date) issues.push('Ngày hóa đơn trống hoặc không đúng định dạng.');
  if (!code) issues.push('Thiếu mã hàng.');
  if (!name) issues.push('Thiếu tên hàng.');
  if (quantity === null || quantity <= 0) issues.push('Số lượng phải là số lớn hơn 0.');
  if (unitPrice === null || unitPrice < 0) issues.push('Đơn giá phải là số không âm.');
  if (unitPrice !== null && !Number.isInteger(unitPrice)) issues.push('Đơn giá lẻ nhỏ hơn một đồng chưa được hỗ trợ.');
  if (lineAmount === null || lineAmount < 0 || !Number.isInteger(lineAmount)) issues.push('Thành tiền phải là số nguyên VND không âm.');
  if (taxRate === null || taxRate < 0 || taxRate > 100) issues.push('Thuế suất phải nằm trong khoảng 0–100%.');
  if (parsedTaxRates.some(value => value === null)) issues.push('Có cột thuế suất không phải số hợp lệ.');
  if (new Set(parsedTaxRates.filter(value => value !== null)).size > 1) issues.push('Các cột thuế suất khác nhau trong cùng dòng; cần kế toán kiểm tra.');
  if (taxAmount === null || taxAmount < 0 || !Number.isInteger(taxAmount)) issues.push('Tiền thuế phải là số nguyên VND không âm.');

  if (quantity !== null && unitPrice !== null && lineAmount !== null
      && Math.round(quantity * unitPrice) !== lineAmount) {
    issues.push(`Dòng ${sourceRowNumber}: số lượng × đơn giá không khớp thành tiền nguồn.`);
  }
  if (lineAmount !== null && taxRate !== null && taxAmount !== null
      && Math.round(lineAmount * taxRate / 100) !== taxAmount) {
    issues.push(`Dòng ${sourceRowNumber}: tiền thuế không khớp cách làm tròn theo dòng trong file.`);
  }

  for (const field of UNSUPPORTED_DISCOUNT_FIELDS) {
    for (const raw of fieldValues(row, mapping, field)) {
      if (!meaningful(raw)) continue;
      const numeric = parseInvoiceImportNumber(raw);
      if (numeric === null || numeric !== 0) {
        issues.push(`Cột giảm trừ/chiết khấu (${field}) đang có dữ liệu và cần kế toán xử lý trước.`);
        break;
      }
    }
    if (issues.some(issue => issue.startsWith('Cột giảm trừ/chiết khấu'))) break;
  }

  const currency = normalizedText(fieldValue(row, mapping, 'currency'));
  if (currency && !/^vnd|vnđ|đ$/i.test(currency)) issues.push(`Loại tiền “${currency}” chưa được hỗ trợ.`);

  return {
    sourceRowNumber,
    invoiceNumber,
    date,
    code,
    name,
    unit: normalizedText(fieldValue(row, mapping, 'unit')),
    quantity,
    unitPrice,
    lineAmount,
    taxRate,
    taxAmount,
    currency: currency || 'VND',
    buyerName: normalizedText(fieldValue(row, mapping, 'buyerName')),
    buyerCode: normalizedText(fieldValue(row, mapping, 'buyerCode')),
    buyerCompany: normalizedText(fieldValue(row, mapping, 'buyerCompany')),
    buyerTaxCode: normalizedText(fieldValue(row, mapping, 'buyerTaxCode')),
    buyerAddress: normalizedText(fieldValue(row, mapping, 'buyerAddress')),
    buyerEmail: normalizedText(fieldValue(row, mapping, 'buyerEmail')),
    issuerName: normalizedText(fieldValue(row, mapping, 'issuerName')),
    issuerTaxCode: normalizedText(fieldValue(row, mapping, 'issuerTaxCode')),
    paymentMethod: normalizedText(fieldValue(row, mapping, 'paymentMethod')),
    notes: normalizedText(fieldValue(row, mapping, 'notes')),
    rowNumber: normalizedText(fieldValue(row, mapping, 'rowNumber')),
    lineType: normalizedText(fieldValue(row, mapping, 'lineType')),
    issues
  };
}

export function parseInvoiceImportRows(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 2) {
    return { groups: [], dataRowCount: 0, error: 'File Excel chưa có dòng tiêu đề và dữ liệu.' };
  }

  const headerIndex = matrix.findIndex(row => Array.isArray(row) && row.some(meaningful));
  if (headerIndex < 0 || headerIndex === matrix.length - 1) {
    return { groups: [], dataRowCount: 0, error: 'File Excel không có dòng dữ liệu.' };
  }

  const resolved = resolveHeaderMapping(matrix[headerIndex]);
  if (resolved.error) return { groups: [], dataRowCount: 0, error: resolved.error };

  const groupsByKey = new Map();
  const sourceRows = matrix.slice(headerIndex + 1);
  let dataRowCount = 0;

  sourceRows.forEach((row, offset) => {
    if (!Array.isArray(row) || !row.some(meaningful)) return;
    dataRowCount += 1;
    const sourceRowNumber = headerIndex + offset + 2;
    const item = sourceRowToItem(row, resolved.mapping, sourceRowNumber);
    const groupKey = `${item.invoiceNumber || 'MISSING'}\u0000${item.date || `ROW-${sourceRowNumber}`}`;
    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, {
        key: groupKey,
        invoiceNumber: item.invoiceNumber,
        date: item.date,
        buyerName: '',
        buyerCode: '',
        buyerCompany: '',
        buyerTaxCode: '',
        buyerAddress: '',
        buyerEmail: '',
        issuerName: '',
        issuerTaxCode: '',
        paymentMethod: '',
        items: [],
        issues: [],
        warnings: []
      });
    }
    const group = groupsByKey.get(groupKey);
    group.items.push(item);
    group.issues.push(...item.issues);
    consistentValue(group, 'buyerName', item.buyerName, sourceRowNumber, 'Tên người mua');
    consistentValue(group, 'buyerCode', item.buyerCode, sourceRowNumber, 'Mã khách hàng nguồn');
    consistentValue(group, 'buyerCompany', item.buyerCompany, sourceRowNumber, 'Tên đơn vị mua');
    consistentValue(group, 'buyerTaxCode', item.buyerTaxCode, sourceRowNumber, 'Mã số thuế người mua');
    consistentValue(group, 'buyerAddress', item.buyerAddress, sourceRowNumber, 'Địa chỉ người mua');
    consistentValue(group, 'buyerEmail', item.buyerEmail, sourceRowNumber, 'Email người mua');
    consistentValue(group, 'issuerName', item.issuerName, sourceRowNumber, 'Tên người bán');
    consistentValue(group, 'issuerTaxCode', item.issuerTaxCode, sourceRowNumber, 'Mã số thuế người bán');
    consistentValue(group, 'paymentMethod', item.paymentMethod, sourceRowNumber, 'Phương thức thanh toán');
  });

  const groups = [...groupsByKey.values()].map(group => {
    const taxRates = new Set(group.items.map(item => item.taxRate).filter(value => value !== null));
    const currencies = new Set(group.items.map(item => item.currency));
    if (taxRates.size > 1) group.issues.push('Một hóa đơn có nhiều thuế suất; cần kiểm tra riêng trước khi nhập.');
    if (currencies.size > 1) group.issues.push('Một hóa đơn có nhiều loại tiền.');

    const rate = taxRates.size === 1 ? [...taxRates][0] : 0;
    const lineTaxBases = group.items.map(item => item.lineAmount);
    const lineTaxAmounts = group.items.map(item => item.taxAmount);
    const netAmount = group.items.reduce((sum, item) => sum + (item.lineAmount || 0), 0);
    const taxAmount = group.items.reduce((sum, item) => sum + (item.taxAmount || 0), 0);
    if (netAmount <= 0) group.issues.push('Tổng giá trị hóa đơn phải lớn hơn 0.');

    return {
      ...group,
      rate,
      currency: currencies.size === 1 ? [...currencies][0] : '',
      lineTaxBases,
      lineTaxAmounts,
      netAmount,
      taxAmount,
      totalWithTax: netAmount + taxAmount,
      issues: [...new Set(group.issues)],
      warnings: group.items.some(item => item.lineType && item.lineType !== '1')
        ? ['Có cột tính chất dòng hàng; cần kế toán kiểm tra loại dòng sau khi lưu nháp.']
        : []
    };
  });

  return { groups, dataRowCount, error: '' };
}

export function findInvoiceImportProductMatches(item, products = []) {
  const code = String(item?.code ?? '').trim().toLocaleLowerCase('vi');
  if (!code) return [];
  return (products || []).filter(product => product?.isActive !== false
    && String(product.variantCode || product.code || '').trim().toLocaleLowerCase('vi') === code);
}

export function buildInvoiceImportFingerprint(group) {
  return JSON.stringify({
    number: group.invoiceNumber,
    date: group.date,
    buyerTaxCode: group.buyerTaxCode,
    buyerCode: group.buyerCode,
    buyerName: group.buyerName,
    buyerCompany: group.buyerCompany,
    buyerAddress: group.buyerAddress,
    buyerEmail: group.buyerEmail,
    issuerTaxCode: group.issuerTaxCode,
    issuerName: group.issuerName,
    paymentMethod: group.paymentMethod,
    currency: group.currency,
    rate: group.rate,
    lines: group.items.map(item => [
      item.sourceRowNumber,
      item.code,
      item.name,
      item.unit,
      item.quantity,
      item.unitPrice,
      item.lineAmount,
      item.taxRate,
      item.taxAmount,
      item.currency,
      item.rowNumber,
      item.lineType,
      item.notes
    ])
  });
}

export function buildInvoiceImportIdentity(group, workspaceId = '') {
  const identifier = value => String(value || '').trim().replace(/[\s.-]/g, '').toLocaleUpperCase('vi');
  const person = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
  return JSON.stringify({
    workspace: String(workspaceId || ''),
    issuerTaxCode: identifier(group.issuerTaxCode),
    number: group.invoiceNumber || '',
    date: group.date || '',
    buyerCode: identifier(group.buyerCode),
    buyerTaxCode: identifier(group.buyerTaxCode),
    buyerName: person(group.buyerCompany || group.buyerName)
  });
}

export function stableInvoiceImportUuid(hex) {
  const chars = String(hex || '').slice(0, 32).split('');
  if (chars.length !== 32 || chars.some(character => !/[0-9a-f]/i.test(character))) {
    throw new Error('A 32-character hexadecimal digest is required');
  }
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

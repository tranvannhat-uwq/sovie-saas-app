import { parseExcelDate } from './import-date.js';

export const PURCHASE_IMPORT_COLUMNS = Object.freeze([
  { key: 'groupCode', label: 'Mã nhóm phiếu', aliases: ['Mã nhóm phiếu', 'Mã phiếu nguồn', 'Mã nhóm nhập'] },
  { key: 'supplierCode', label: 'Mã nhà cung cấp', aliases: ['Mã nhà cung cấp', 'Mã NCC'] },
  { key: 'invoiceNumber', label: 'Số hóa đơn đầu vào', aliases: ['Số hóa đơn đầu vào', 'Số hóa đơn', 'Hóa đơn đầu vào'] },
  { key: 'purchaseDate', label: 'Ngày mua', aliases: ['Ngày mua', 'Ngày phiếu mua'] },
  { key: 'itemCode', label: 'Mã hàng hóa/dịch vụ', aliases: ['Mã hàng hóa/dịch vụ', 'Mã hàng hóa', 'Mã hàng', 'Mã sản phẩm'] },
  { key: 'itemName', label: 'Tên hàng hóa/dịch vụ', aliases: ['Tên hàng hóa/dịch vụ', 'Tên hàng hóa', 'Tên hàng', 'Tên sản phẩm'] },
  { key: 'unit', label: 'Đơn vị tính', aliases: ['Đơn vị tính', 'ĐVT', 'Đơn vị'] },
  { key: 'quantity', label: 'Số lượng', aliases: ['Số lượng', 'SL', 'Qty'] },
  { key: 'unitPrice', label: 'Đơn giá', aliases: ['Đơn giá', 'Giá mua'] },
  { key: 'paidAmount', label: 'Thanh toán ngay (đ)', aliases: ['Thanh toán ngay (đ)', 'Thanh toán ngay', 'Đã thanh toán', 'Số tiền thanh toán'] },
  { key: 'paymentMethod', label: 'Phương thức chi', aliases: ['Phương thức chi', 'Phương thức thanh toán'] },
  { key: 'notes', label: 'Ghi chú', aliases: ['Ghi chú', 'Ghi chú phiếu'] }
]);

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('vi')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === '') return null;
  let text = String(value).trim().replace(/[\s₫đ]/gi, '');
  if (!text) return null;
  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (hasComma && hasDot) {
    const decimalSeparator = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    text = text.split(groupingSeparator).join('');
    if (decimalSeparator === ',') text = text.replace(',', '.');
  } else if (hasComma) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(text)) text = text.replace(/,/g, '');
    else text = text.replace(',', '.');
  } else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, '');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizePaymentMethod(value) {
  const method = normalizeHeader(value || 'cash');
  if (['cash', 'tien mat', 'tm'].includes(method)) return 'cash';
  if (['bank', 'ngan hang', 'chuyen khoan'].includes(method)) return 'bank';
  if (['wallet', 'vi dien tu', 'vi'].includes(method)) return 'wallet';
  return null;
}

function readCell(row, columns, key) {
  const index = columns[key];
  return index >= 0 ? row[index] : '';
}

function isBlankRow(row) {
  return row.every(value => String(value ?? '').trim() === '');
}

function setGroupValue(group, key, value, rowNumber, errors) {
  if (value === null || value === undefined || String(value).trim() === '') return;
  const normalized = String(value).trim();
  if (group.metadata[key] && group.metadata[key].value !== normalized) {
    errors.push('Dòng ' + rowNumber + ': thông tin ' + key + ' không khớp trong cùng mã nhóm ' + group.groupCode + '.');
    return;
  }
  group.metadata[key] = { value: normalized };
}

export function parsePurchaseImportRows(rows, suppliers = []) {
  const input = Array.isArray(rows) ? rows : [];
  const headerRowIndex = input.findIndex(row => {
    const headers = (row || []).map(normalizeHeader);
    const hasGroupCode = PURCHASE_IMPORT_COLUMNS[0].aliases.some(alias => headers.includes(normalizeHeader(alias)));
    const hasSupplierCode = PURCHASE_IMPORT_COLUMNS[1].aliases.some(alias => headers.includes(normalizeHeader(alias)));
    const hasItemName = PURCHASE_IMPORT_COLUMNS[5].aliases.some(alias => headers.includes(normalizeHeader(alias)));
    return hasGroupCode && hasSupplierCode && hasItemName;
  });
  if (headerRowIndex < 0) {
    return { purchases: [], errors: ['Không tìm thấy tiêu đề bắt buộc: Mã nhóm phiếu, Mã nhà cung cấp và Tên hàng hóa/dịch vụ.'] };
  }

  const headers = input[headerRowIndex].map(normalizeHeader);
  const columns = {};
  for (const definition of PURCHASE_IMPORT_COLUMNS) {
    columns[definition.key] = headers.findIndex(header => definition.aliases.some(alias => normalizeHeader(alias) === header));
  }
  const required = ['groupCode', 'supplierCode', 'purchaseDate', 'itemCode', 'itemName', 'quantity', 'unitPrice'];
  const missing = required.filter(key => columns[key] < 0);
  if (missing.length) {
    return { purchases: [], errors: ['Thiếu cột bắt buộc: ' + missing.map(key => PURCHASE_IMPORT_COLUMNS.find(column => column.key === key).label).join(', ') + '.'] };
  }

  const supplierByCode = new Map((Array.isArray(suppliers) ? suppliers : [])
    .filter(supplier => supplier && supplier.isActive !== false)
    .map(supplier => [String(supplier.code || '').trim().toLocaleUpperCase('vi'), supplier]));
  const groups = new Map();
  const errors = [];

  for (let index = headerRowIndex + 1; index < input.length; index += 1) {
    const row = input[index] || [];
    if (isBlankRow(row)) continue;
    const rowNumber = index + 1;
    const rawGroupCode = String(readCell(row, columns, 'groupCode') ?? '').trim();
    if (!rawGroupCode) {
      errors.push('Dòng ' + rowNumber + ': cần có mã nhóm phiếu để gom các dòng hàng.');
      continue;
    }
    if (rawGroupCode.length > 70) {
      errors.push('Dòng ' + rowNumber + ': mã nhóm phiếu không được dài quá 70 ký tự.');
      continue;
    }
    const groupCode = rawGroupCode.toLocaleUpperCase('vi');
    const supplierCode = String(readCell(row, columns, 'supplierCode') ?? '').trim().toLocaleUpperCase('vi');
    const purchaseDateText = readCell(row, columns, 'purchaseDate');
    const purchaseDate = purchaseDateText === '' || purchaseDateText === null || purchaseDateText === undefined
      ? ''
      : parseExcelDate(purchaseDateText);
    if (purchaseDateText !== '' && purchaseDateText !== null && purchaseDateText !== undefined && !purchaseDate) {
      errors.push('Dòng ' + rowNumber + ': ngày mua không hợp lệ.');
    }

    let group = groups.get(groupCode);
    if (!group) {
      group = {
        groupCode,
        supplierCode: '',
        purchaseDate: '',
        invoiceNumber: '',
        paidAmount: 0,
        paymentMethod: 'cash',
        notes: '',
        metadata: {},
        paidAmountSet: false,
        paymentMethodSet: false,
        notesSet: false,
        items: [],
        firstRow: rowNumber
      };
      groups.set(groupCode, group);
    }

    setGroupValue(group, 'Mã nhà cung cấp', supplierCode, rowNumber, errors);
    if (supplierCode) group.supplierCode = supplierCode;
    setGroupValue(group, 'Ngày mua', purchaseDate, rowNumber, errors);
    if (purchaseDate) group.purchaseDate = purchaseDate;

    const invoiceNumber = String(readCell(row, columns, 'invoiceNumber') ?? '').trim();
    if (invoiceNumber) {
      setGroupValue(group, 'số hóa đơn đầu vào', invoiceNumber, rowNumber, errors);
      if (!group.invoiceNumber) group.invoiceNumber = invoiceNumber;
    }
    const paidRaw = readCell(row, columns, 'paidAmount');
    if (paidRaw !== '' && paidRaw !== null && paidRaw !== undefined) {
      const paidAmount = parseNumber(paidRaw);
      if (paidAmount === null || paidAmount < 0) errors.push('Dòng ' + rowNumber + ': thanh toán ngay phải là số không âm.');
      else {
        if (group.paidAmountSet && group.paidAmount !== paidAmount) errors.push('Dòng ' + rowNumber + ': số thanh toán không khớp trong cùng mã nhóm ' + groupCode + '.');
        group.paidAmount = paidAmount;
        group.paidAmountSet = true;
      }
    }
    const paymentRaw = String(readCell(row, columns, 'paymentMethod') ?? '').trim();
    if (paymentRaw) {
      const method = normalizePaymentMethod(paymentRaw);
      if (!method) errors.push('Dòng ' + rowNumber + ': phương thức chi chỉ nhận Tiền mặt, Ngân hàng hoặc Ví điện tử.');
      else {
        if (group.paymentMethodSet && group.paymentMethod !== method) errors.push('Dòng ' + rowNumber + ': phương thức chi không khớp trong cùng mã nhóm ' + groupCode + '.');
        group.paymentMethod = method;
        group.paymentMethodSet = true;
      }
    }
    const notes = String(readCell(row, columns, 'notes') ?? '').trim();
    if (notes) {
      if (group.notesSet && group.notes !== notes) errors.push('Dòng ' + rowNumber + ': ghi chú không khớp trong cùng mã nhóm ' + groupCode + '.');
      group.notes = notes;
      group.notesSet = true;
    }

    const itemCode = String(readCell(row, columns, 'itemCode') ?? '').trim();
    const itemName = String(readCell(row, columns, 'itemName') ?? '').trim();
    const unit = String(readCell(row, columns, 'unit') ?? '').trim();
    const quantity = parseNumber(readCell(row, columns, 'quantity'));
    const unitPrice = parseNumber(readCell(row, columns, 'unitPrice'));
    if (!itemCode || !itemName || quantity === null || quantity <= 0 || unitPrice === null || unitPrice < 0) {
      errors.push('Dòng ' + rowNumber + ': cần mã, tên hàng, số lượng lớn hơn 0 và đơn giá không âm.');
      continue;
    }
    group.items.push({ code: itemCode, name: itemName, unit, quantity, unitPrice });
    if (group.items.length > 100) errors.push('Mã nhóm ' + groupCode + ' có quá 100 dòng hàng; hãy tách phiếu.');
  }

  const purchases = [];
  for (const group of groups.values()) {
    const supplier = supplierByCode.get(group.supplierCode);
    if (!group.supplierCode) errors.push('Nhóm ' + group.groupCode + ' thiếu mã nhà cung cấp.');
    else if (!supplier) errors.push('Nhóm ' + group.groupCode + ': mã nhà cung cấp ' + group.supplierCode + ' chưa có hoặc đã ngừng sử dụng.');
    if (!group.purchaseDate) errors.push('Nhóm ' + group.groupCode + ' thiếu ngày mua hợp lệ.');
    if (!group.items.length) errors.push('Nhóm ' + group.groupCode + ' chưa có dòng hàng hợp lệ.');
    const totalAmount = group.items.reduce((sum, item) => sum + Math.round(item.quantity * Math.round(item.unitPrice)), 0);
    if (totalAmount <= 0) errors.push('Nhóm ' + group.groupCode + ' có tổng tiền bằng 0; phiếu mua phải lớn hơn 0.');
    if (group.paidAmount > totalAmount) errors.push('Nhóm ' + group.groupCode + ' thanh toán ngay vượt tổng tiền.');
    if (supplier && group.purchaseDate && group.items.length && group.items.length <= 100 && totalAmount > 0 && group.paidAmount <= totalAmount) {
      purchases.push({
        groupCode: group.groupCode,
        supplierId: supplier.id,
        supplierCode: supplier.code,
        supplierName: supplier.name,
        invoiceNumber: group.invoiceNumber,
        purchaseDate: group.purchaseDate,
        paidAmount: group.paidAmount,
        paymentMethod: group.paymentMethod,
        notes: group.notes,
        totalAmount,
        items: group.items
      });
    }
  }
  if (!purchases.length && !errors.length) errors.push('Không tìm thấy phiếu mua nào trong tệp.');
  return { purchases, errors };
}

export function filterPurchasesForExport(purchases, query = '', status = 'all') {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase('vi');
  return (Array.isArray(purchases) ? purchases : []).filter(purchase => {
    if (!purchase) return false;
    if (status !== 'all' && String(purchase.status || 'completed') !== status) return false;
    const supplierText = [purchase.supplierCode, purchase.supplierName].join(' ');
    const searchable = [purchase.code, purchase.invoiceNumber, supplierText, purchase.createdBy]
      .join(' ').toLocaleLowerCase('vi');
    return !normalizedQuery || searchable.includes(normalizedQuery);
  });
}

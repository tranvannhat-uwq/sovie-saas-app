import { normalizeExcelHeader } from './customer-import-columns.js';

export const SUPPLIER_IMPORT_COLUMNS = Object.freeze([
  { key: 'code', aliases: ['Mã nhà cung cấp', 'Mã NCC', 'Mã', 'Code'] },
  { key: 'name', aliases: ['Tên nhà cung cấp', 'Tên NCC', 'Tên', 'Name'] },
  { key: 'phone', aliases: ['Điện thoại', 'Số điện thoại', 'SĐT', 'Di động', 'Phone'] },
  { key: 'address', aliases: ['Địa chỉ', 'Address'] },
  { key: 'notes', aliases: ['Ghi chú', 'Ghi chu', 'Notes'] }
]);

export function parseSupplierRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1) {
    return { records: [], errors: ['Tệp không có dòng tiêu đề.'] };
  }

  const headers = rows[0].map(normalizeExcelHeader);
  const columns = Object.fromEntries(SUPPLIER_IMPORT_COLUMNS.map(({ key, aliases }) => {
    const normalizedAliases = aliases.map(normalizeExcelHeader);
    return [key, headers.findIndex(header => normalizedAliases.includes(header))];
  }));
  const errors = [];
  if (columns.code < 0 || columns.name < 0) {
    const missing = [columns.code < 0 && 'Mã nhà cung cấp', columns.name < 0 && 'Tên nhà cung cấp'].filter(Boolean);
    return { records: [], errors: [`Thiếu cột bắt buộc: ${missing.join(', ')}.`] };
  }

  const records = [];
  const codes = new Set();
  rows.slice(1).forEach((row, index) => {
    if (!Array.isArray(row) || row.every(value => String(value ?? '').trim() === '')) return;

    const rowNumber = index + 2;
    const value = key => columns[key] >= 0 ? String(row[columns[key]] ?? '').trim() : '';
    const code = value('code').toUpperCase();
    const name = value('name');
    if (!code || !name) {
      errors.push(`Dòng ${rowNumber}: cần có mã và tên nhà cung cấp.`);
      return;
    }
    const normalizedCode = normalizeExcelHeader(code);
    if (codes.has(normalizedCode)) {
      errors.push(`Dòng ${rowNumber}: mã ${code} bị lặp trong tệp.`);
      return;
    }
    codes.add(normalizedCode);
    records.push({
      code,
      name,
      phone: value('phone'),
      address: value('address'),
      notes: value('notes')
    });
  });

  if (records.length === 0 && errors.length === 0) errors.push('Không tìm thấy dòng nhà cung cấp nào trong tệp.');
  return { records, errors };
}

export function filterSuppliersForExport(suppliers, query = '') {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
  return (Array.isArray(suppliers) ? suppliers : [])
    .filter(supplier => supplier && (
      !normalizedQuery ||
      String(supplier.code || supplier.id || '').toLocaleLowerCase().includes(normalizedQuery) ||
      String(supplier.name || '').toLocaleLowerCase().includes(normalizedQuery) ||
      String(supplier.phone || '').toLocaleLowerCase().includes(normalizedQuery)
    ))
    .slice()
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), 'vi'));
}

export function suggestNextSupplierCode(suppliers) {
  const existingCodes = new Set((Array.isArray(suppliers) ? suppliers : [])
    .map(supplier => String(supplier?.code || '').trim().toUpperCase()));
  let next = 1;
  while (existingCodes.has(`NCC${String(next).padStart(3, '0')}`)) next += 1;
  return `NCC${String(next).padStart(3, '0')}`;
}

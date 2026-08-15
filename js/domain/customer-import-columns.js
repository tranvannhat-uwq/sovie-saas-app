export function normalizeExcelHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

export function normalizeExcelSheetName(value) {
  return normalizeExcelHeader(value).replace(/\s+/g, '');
}

export const CUSTOMER_IMPORT_COLUMNS = Object.freeze([
  { key: 'code', label: 'Mã khách hàng', databaseField: 'customers.code', aliases: ['Mã khách hàng'] },
  { key: 'name', label: 'Tên khách hàng', databaseField: 'customers.name', aliases: ['Tên khách hàng'] },
  { key: 'phone', label: 'Điện thoại', databaseField: 'customers.phone', aliases: ['Điện thoại', 'Số điện thoại'] },
  { key: 'address', label: 'Địa chỉ', databaseField: 'customers.address', aliases: ['Địa chỉ', 'Địa chỉ (Khách hàng)'] },
  { key: 'excelBrand', label: 'Nhãn sơn', databaseField: 'customers.assigned_brand / assigned_brand_id', aliases: ['Nhãn sơn', 'Nhãn đại lý'] },
  { key: 'excelPricelist', label: 'Bảng giá', databaseField: 'customers.pricelist_id / default_price_list_id', aliases: ['Bảng giá'] },
  { key: 'excelManager', label: 'Người quản lý', databaseField: 'customers.managed_by', aliases: ['Người quản lý', 'Người tạo', 'Nhóm khách hàng'] },
  { key: 'totalTransaction', label: 'Tổng doanh số', databaseField: 'customers.total_transaction', aliases: ['Tổng doanh số', 'Tổng bán', 'Doanh số gốc'] },
  { key: 'totalReturns', label: 'Tổng giá trị trả hàng', databaseField: 'customers.total_return', aliases: ['Tổng giá trị trả hàng', 'Tổng trả hàng'] },
  { key: 'netSales', label: 'Doanh số sau trả', databaseField: 'customers.net_revenue', aliases: ['Doanh số sau trả'] },
  { key: 'debt', label: 'Công nợ hiện tại', databaseField: 'customers.debt + customer_debt_transactions', aliases: ['Công nợ hiện tại', 'Công nợ', 'Nợ cần thu hiện tại'] },
  { key: 'lastTransactionAt', label: 'Ngày giao dịch cuối', databaseField: 'customers.last_order_at', aliases: ['Ngày giao dịch cuối', 'Ngày giao dịch cuối cùng', 'Giao dịch cuối'] },
  { key: 'createdAt', label: 'Ngày tạo', databaseField: 'customers.created_at', aliases: ['Ngày tạo'] },
  { key: 'debtDays', label: 'Số ngày nợ', databaseField: 'customers.brand_discounts.debtDays', aliases: ['Số ngày nợ'] },
  { key: 'notes', label: 'Ghi chú', databaseField: 'customers.notes', aliases: ['Ghi chú', 'Ghi chu'] }
]);

export function buildCustomerImportColumnMap(headers) {
  const originalHeaders = (headers || []).map(value => String(value ?? '').trim());
  const normalizedHeaders = originalHeaders.map(normalizeExcelHeader);
  const columns = {};
  const details = {};

  for (const definition of CUSTOMER_IMPORT_COLUMNS) {
    const aliases = definition.aliases.map(normalizeExcelHeader);
    const index = normalizedHeaders.findIndex(header => aliases.includes(header));
    columns[definition.key] = index;
    details[definition.key] = {
      label: definition.label,
      databaseField: definition.databaseField,
      index,
      originalHeader: index >= 0 ? originalHeaders[index] : null,
      normalizedHeader: index >= 0 ? normalizedHeaders[index] : null
    };
  }

  return { columns, details, originalHeaders, normalizedHeaders };
}

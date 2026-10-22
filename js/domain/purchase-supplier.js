export function resolvePurchaseSupplierDetails(purchase, supplierDirectory = []) {
  const supplier = (Array.isArray(supplierDirectory) ? supplierDirectory : [])
    .find(item => String(item?.id) === String(purchase?.supplierId ?? purchase?.supplier_id));
  return {
    supplierName: supplier?.name || purchase?.supplierName || purchase?.supplier_name || '',
    supplierCode: supplier?.code || purchase?.supplierCode || purchase?.supplier_code || ''
  };
}

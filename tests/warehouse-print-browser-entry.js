window.print = () => {
  document.body.dataset.printCalled = 'true';
};

const { renderAndPrintOrder } = await import('../js/components/invoice.js?v=20260809-activity8');

await renderAndPrintOrder({
  id: 'order-warehouse-print-test',
  date: '2026-08-05T08:00:00+07:00',
  customerName: 'ĐẠI LÝ MINH ANH',
  customerId: null,
  items: [{
    productName: 'Sơn chống thấm cao cấp',
    variantCode: 'CT-01-LON',
    quantity: 2,
    packagingName: 'Lon',
    specificationSnapshot: 'Lon 5 kg',
    colorCode: 'A01',
    notes: 'Hàng tặng'
  }],
  totalPayable: 0,
  amountDue: 0,
  paidAmount: 0,
  otherFeeValue: 0,
  shippingFeeAmount: 0,
  notes: '',
  createdBy: 'admin',
  status: 'settled'
}, 'warehouse');

document.body.dataset.warehousePrintReady = 'true';

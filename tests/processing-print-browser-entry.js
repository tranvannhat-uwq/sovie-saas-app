window.print = () => {
  document.body.dataset.printCalled = 'true';
};

const { state } = await import('../js/state.js');
const { renderAndPrintOrder } = await import('../js/components/invoice.js?v=20260814-processing-print-v2');

state.currentUser = { id: 'admin-print-test', username: 'admin', role: 'admin' };
state.customers = [{
  id: 'processing-customer',
  name: 'BÊN GIA CÔNG MINH ANH',
  phone: '0977183322',
  address: 'Vĩnh Phúc',
  managedBy: ''
}];

await renderAndPrintOrder({
  id: 'order-processing-print-test',
  date: '2026-08-14T08:00:00+07:00',
  customerName: 'BÊN GIA CÔNG MINH ANH',
  customerId: 'processing-customer',
  items: [{
    productName: 'Sơn chống thấm cao cấp',
    variantCode: 'MA-SP-PHAI-AN',
    quantity: 2,
    price: 125000,
    discountPercent: 5,
    packagingName: 'Lon',
    specificationSnapshot: 'Lon 5 kg',
    colorCode: 'A01',
    colorPercent: 10
  }],
  subtotal: 237500,
  totalDiscount: 12500,
  discountAmount: 0,
  totalPayable: 237500,
  amountDue: 237500,
  paidAmount: 0,
  otherFeeAmount: 0,
  shippingFeeAmount: 0,
  notes: 'Xuất hàng gia công',
  paymentMethod: 'bank_transfer',
  createdBy: 'admin',
  status: 'draft'
}, 'processing');

document.body.dataset.processingPrintReady = 'true';

export const DEFAULT_COMPANIES = [
  { id: 'ABS_NORTH', code: 'ABS_NORTH', name: 'Công ty Cổ phần ABS JAPAN (Miền Bắc)', address: 'Tiên Kha - Phúc Thịnh - Hà Nội', status: 'active' },
  { id: 'ABS_SOUTH', code: 'ABS_SOUTH', name: 'Công ty Cổ phần ABS JAPAN - Chi nhánh Miền Nam', address: '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh', status: 'active' },
  { id: 'EMP_USA', code: 'EMP_USA', name: 'Công ty Cổ phần EMP Hoa Kỳ', address: 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', status: 'active' }
];

// Đối tượng trạng thái toàn cục của ứng dụng (State)
export const state = {
  products: [],
  brands: [],
  companies: [...DEFAULT_COMPANIES],
  invoiceItems: [], // [{ product, brand, package, colorCode, colorPercent, quantity, discountPercent, price }]
  savedOrders: [],
  cashbookOpeningNetByMethod: null,
  cashbookOpeningStartIso: '',
  customers: [],
  pricelists: [],
  // Bản đầy đủ dùng để áp dụng bảng giá đã gán cho khách; pricelists vẫn là
  // danh sách đã lọc để hiển thị theo quyền người dùng.
  allPricelists: [],
  priceListItems: [],
  allPriceListItems: [],
  pricingSnapshotActorId: '',
  pricingSnapshotRole: '',
  pricingSnapshotSource: '',
  pricingSnapshotCachedAt: '',
  selectedPriceListIds: [],
  users: [],
  currentUser: null,
  activeCustomerId: '',
  activeCustomerBrand: 'Tất cả',
  currentTab: 'dashboard-panel',
  isQuickCustomerMode: false,
  dashboardFilter: {
    timeRange: 'month',
    startDate: '',
    endDate: '',
    companyId: 'all',
    brand: 'all',
    includeFestivalAllocation: true,
    saleUser: 'all',
    customerId: 'all'
  },
  dashboardChartView: 'month', // 'day', 'week', 'month', 'year'
  historyPage: 1,
  productsPage: 1,
  customersPage: 1,
  suppliers: [],
  suppliersPage: 1,
  purchases: [],
  rawMaterials: [],
  semiFinished: [],
  recipes: [],
  productionLogs: [],
  finishedGoodsStock: [],
  salesReturns: [],
  dashboardSalesMode: 'net', // 'net' (after returns) or 'gross' (original)
  historyViewMode: localStorage.getItem('historyViewMode') || 'card' // 'card' or 'details'
};

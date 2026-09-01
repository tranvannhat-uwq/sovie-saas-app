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
  saasContext: null,
  businessCapabilities: null,
  platformRole: '',
  platformOrganizations: [],
  platformSummary: null,
  platformPlans: [],
  activeOrganizationId: '',
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

export function resetTenantBusinessState() {
  state.products = [];
  state.brands = [];
  state.companies = [];
  state.invoiceItems = [];
  state.savedOrders = [];
  state.cashbookOpeningNetByMethod = null;
  state.cashbookOpeningStartIso = '';
  state.customers = [];
  state.pricelists = [];
  state.allPricelists = [];
  state.priceListItems = [];
  state.allPriceListItems = [];
  state.users = [];
  state.suppliers = [];
  state.purchases = [];
  state.rawMaterials = [];
  state.semiFinished = [];
  state.recipes = [];
  state.productionLogs = [];
  state.finishedGoodsStock = [];
  state.salesReturns = [];
  state.activeCustomerId = '';
  state.activeCustomerBrand = 'Tất cả';
}

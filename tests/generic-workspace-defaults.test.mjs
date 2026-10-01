import assert from 'node:assert/strict';
import test from 'node:test';
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {}
};

const { state } = await import('../js/state.js');
const {
  getCanonicalBrandName,
  getCompanyIdByBrand,
  getDefaultCompanyId,
  getRevenueAttributes,
  normalizeCompanyId,
  resolveWorkspaceCompanyId
} = await import('../js/utils.js');

test('SaaS company and brand fallbacks stay inside the active workspace', () => {
  const original = {
    saasContext: state.saasContext,
    currentUser: state.currentUser,
    companies: state.companies,
    brands: state.brands
  };

  try {
    state.saasContext = { organizationId: 'org-woodwork', organizationName: 'Mộc An' };
    state.currentUser = { companyId: '' };
    state.companies = [{ id: 'company-woodwork', code: 'MA', name: 'Mộc An' }];
    state.brands = [{ id: 'brand-custom', name: 'Mộc An Premium', companyId: 'company-woodwork' }];

    assert.equal(getDefaultCompanyId(), 'org-woodwork');
    assert.equal(normalizeCompanyId('Mộc An'), 'company-woodwork');
    assert.equal(normalizeCompanyId('another-company'), 'another-company');
    assert.equal(getCompanyIdByBrand('brand-custom'), 'company-woodwork');
    assert.equal(getCompanyIdByBrand('Unlisted Brand'), 'org-woodwork');
    assert.equal(getCanonicalBrandName('', state.brands), '');
    assert.equal(normalizeCompanyId('ABS_NORTH'), 'org-woodwork');
    assert.equal(resolveWorkspaceCompanyId('EMP_USA'), 'org-woodwork');
    assert.equal(getCanonicalBrandName('Nano10 MB', []), 'Nano10 MB');

    const revenue = getRevenueAttributes('', '', null, state.brands);
    assert.equal(revenue.productBrand, '');
    assert.equal(revenue.revenueBrand, '');
    assert.equal(revenue.revenueCompany, 'org-woodwork');
  } finally {
    state.saasContext = original.saasContext;
    state.currentUser = original.currentUser;
    state.companies = original.companies;
    state.brands = original.brands;
  }
});

test('an unresolved or unloaded workspace never receives paint-company defaults', () => {
  const original = {
    saasContext: state.saasContext,
    currentUser: state.currentUser,
    companies: state.companies,
    brands: state.brands
  };
  try {
    state.saasContext = null;
    state.currentUser = null;
    state.companies = [];
    state.brands = [];
    assert.equal(getDefaultCompanyId(), '');
    assert.equal(getCompanyIdByBrand('Nano10 MB'), '');
    assert.equal(getCanonicalBrandName('Nano10 MB', []), 'Nano10 MB');
  } finally {
    state.saasContext = original.saasContext;
    state.currentUser = original.currentUser;
    state.companies = original.companies;
    state.brands = original.brands;
  }
});

test('legacy brand aliases remain scoped to the explicitly identified legacy workspace', () => {
  const original = { saasContext: state.saasContext, companies: state.companies, brands: state.brands };
  try {
    state.saasContext = { organizationId: '00000000-0000-4000-8000-000000000001' };
    state.companies = [];
    state.brands = [{ id: 'brand-nano10-mb', name: 'NANO10 MB' }];
    assert.equal(getCanonicalBrandName('Nano10*', state.brands), 'NANO10 MB');
    assert.equal(getDefaultCompanyId(), 'ABS_NORTH');
  } finally {
    state.saasContext = original.saasContext;
    state.companies = original.companies;
    state.brands = original.brands;
  }
});

test('product presentation does not invent paint-specific features or units', async () => {
  const fs = await import('node:fs');
  const invoice = fs.readFileSync(new URL('../js/components/invoice.js', import.meta.url), 'utf8');
  const supabase = fs.readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');

  assert.match(invoice, /return product\?\.featureLabel \|\| product\?\.feature \|\| product\?\.category \|\| brand \|\| 'Sản phẩm'/);
  assert.doesNotMatch(invoice, /Bền màu 8 năm|Kháng kiềm cao cấp|Chống thấm co giãn/);
  assert.doesNotMatch(supabase, /package_weight_unit: product\.packageWeightUnit \|\| 'kg'/);
  assert.doesNotMatch(supabase, /package_weight_unit: p\.packageWeightUnit \|\| 'kg'/);
});

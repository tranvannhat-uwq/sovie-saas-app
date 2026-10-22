import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const invoice = read('js/components/invoice.js');
const brands = read('js/components/brands.js');
const service = read('js/services/supabase.js');
const workspaces = read('js/components/workspaces.js');
const migration = read('migrations/0105_optional_workspace_brands_and_invoice_issuer.sql');

test('sales invoice keeps customer details but removes the sale-reason row', () => {
  for (const id of ['print-customer-name', 'print-customer-phone', 'print-customer-address']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /Lý do xuất bán|print-invoice-reason/);
  assert.doesNotMatch(invoice, /print-invoice-reason/);
});

test('brand is catalog metadata while issuer information is set per company or branch', () => {
  for (const id of [
    'invoice-issuer-company', 'invoice-issuer-name', 'invoice-issuer-tax-code',
    'invoice-issuer-logo', 'invoice-issuer-hotline', 'invoice-issuer-customer-service',
    'invoice-issuer-email', 'invoice-issuer-address', 'invoice-issuer-warehouse-text',
    'invoice-issuer-sales-phone'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(workspaces, /saveInvoiceIssuerProfile\(issuerCompanySelect\?\.value/);
  assert.match(service, /rpc\('rpc_set_invoice_issuer_profile'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS issuer_profile_snapshot jsonb/);
  assert.match(migration, /CREATE TRIGGER orders_issuer_profile_snapshot/);
  assert.match(migration, /CREATE TRIGGER draft_orders_issuer_profile_snapshot/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.rpc_set_invoice_issuer_profile/);
  assert.doesNotMatch(brands, /brand-invoice-warehouse-text|brand-sales-phone/);
});

test('printed seller stays the order closer while NVKD comes from the dealer manager', () => {
  assert.match(invoice, /order\.salespersonId \|\| order\.salesperson_id \|\| order\.createdBy/);
  assert.match(invoice, /state\.customers\.find\(c => String\(c\.id\) === String\(order\.customerId\)\)/);
  assert.match(invoice, /const managerId = orderCustomer\?\.managedBy[\s\S]*order\.customerManagerId/);
  assert.match(invoice, /salesPhoneEl\.innerText = config\.salesPhone \|\| config\.hotline/);
  assert.match(invoice, /const warehouseText = String\(config\.invoiceWarehouseText \|\| ''\)\.trim\(\)/);
  assert.match(invoice, /warehouseTextEl\.innerText = warehouseText/);
  assert.match(invoice, /warehouseRowEl\.style\.display = type === 'retail' \|\| !warehouseText \? 'none' : ''/);
  assert.match(invoice, /normalized\.includes\('truong phong'\)[\s\S]*return 'TPKD'/);
  assert.match(invoice, /return 'NVKD'/);
  assert.match(service, /salespersonId: order\.salesperson_id/);
});

test('printed issuer prefers the order snapshot and never derives an issuer from product brand', () => {
  assert.match(invoice, /const issuerSnapshot = order\.issuerProfileSnapshot \|\| order\.issuer_profile_snapshot/);
  assert.match(invoice, /const profile = issuerSnapshot \|\| configuredIssuer \|\| legacyIssuer/);
  assert.match(invoice, /const legacyIssuer = isLegacyPaintWorkspace\(\)/);
  const dashboardStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.rpc_get_phase5_dashboard');
  const dashboardEnd = migration.indexOf('ALTER FUNCTION public.rpc_get_phase5_dashboard', dashboardStart);
  const dashboardSql = migration.slice(dashboardStart, dashboardEnd);
  assert.match(dashboardSql, /sale\.company_id revenue_company_id/);
  assert.equal((dashboardSql.match(/OR sale\.company_id = p_filters->>'company_id'/g) || []).length, 2);
  assert.doesNotMatch(dashboardSql, /brand\.company_id/);
});

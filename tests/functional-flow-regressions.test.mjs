import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('js/main.js');
const dashboard = read('js/components/dashboard.js');
const activity = read('js/components/activity-log.js');
const service = read('js/services/supabase.js');
const cashbook = read('js/components/so_quy.js');

test('dashboard and activity order links target the real history search control', () => {
  assert.match(html, /id="history-search-input"/);
  assert.match(dashboard, /getElementById\('history-search-input'\)/);
  assert.match(activity, /getElementById\('history-search-input'\)/);
  assert.doesNotMatch(`${dashboard}\n${activity}`, /order-search-input/);
});

test('login form and overlay interactions are wired once', () => {
  assert.equal((main.match(/addEventListener\('submit', handleLogin\)/g) || []).length, 1);
  assert.equal((main.match(/event\.target\.closest\('\.js-open-login'\)/g) || []).length, 1);
  assert.equal((main.match(/querySelectorAll\('\.js-open-login'\)/g) || []).length, 0);
});

test('an order with unknown status cannot be deleted from an assumed table', () => {
  const deleteOrder = service.slice(
    service.indexOf('export async function dbDeleteOrder'),
    service.indexOf('export async function dbDeleteAllOrders')
  );
  assert.match(deleteOrder, /Không xác định được trạng thái đơn hàng/);
  assert.doesNotMatch(deleteOrder, /Unknown status is treated as draft-only/);
  assert.match(deleteOrder, /}\s*return false;\s*}\s*$/);
});

test('active data writes fail closed while Cloud is unavailable', () => {
  assert.match(service, /return rejectUnavailableCloudWrite\('Sản phẩm'\)/);
  assert.match(service, /return rejectUnavailableCloudWrite\('Khách hàng'\)/);
  assert.match(service, /return rejectUnavailableCloudWrite\('Bảng giá'\)/);
  assert.match(service, /return rejectUnavailableCloudWrite\('Đơn hàng'\)/);
  assert.match(service, /return rejectUnavailableCloudWrite\('Thành viên'\)/);
  assert.match(service, /return rejectUnavailableCloudWrite\('Thương hiệu'\)/);
});

test('cashbook partner-type filtering handles Vietnamese categories consistently', () => {
  assert.match(cashbook, /removeVietnameseTones\(t\.category \|\| ''\)\.toLowerCase\(\)/);
  assert.match(cashbook, /categoryKey\.includes\('khach hang'\)/);
  assert.match(cashbook, /categoryKey\.includes\('nha cung cap'\)/);
  assert.doesNotMatch(cashbook, /khÃ|nhÃ|tiá»/);
});

test('public plan copy matches enforced quotas and excludes deferred modules', () => {
  const landing = html.slice(html.indexOf('id="landing-page"'), html.indexOf('id="app-layout"'));
  assert.match(landing, /Tối đa 5 tài khoản người dùng/);
  assert.match(landing, /Tối đa 20 tài khoản người dùng/);
  assert.match(landing, /Tối đa 100 tài khoản người dùng/);
  assert.match(landing, /5\.000 đơn hàng\/tháng/);
  assert.match(landing, /25\.000 đơn hàng\/tháng/);
  assert.doesNotMatch(landing, /199\.000|499\.000|Không giới hạn|Tự động tính KPI|Tính lương|Công thức sản xuất|Không thất thoát|50 ngành nghề/);
  assert.doesNotMatch(html, /href="#"/);
});

test('trial calls-to-action use the controlled account-provisioning contact flow', () => {
  const landing = html.slice(html.indexOf('id="landing-page"'), html.indexOf('id="app-layout"'));
  assert.ok((landing.match(/mailto:contact@sovie\.vn\?subject=[^"']*d%C3%B9ng%20th%E1%BB%AD%20SoVie/g) || []).length >= 3);
  assert.doesNotMatch(read('js/components/users.js'), /\.auth\.signUp\(/);
});

test('anchor-based app navigation has real fragment destinations', () => {
  const anchors = [...html.matchAll(/<a class="[^"]*nav-link[^"]*"([^>]*)>/g)];
  assert.ok(anchors.length >= 10);
  anchors.forEach(match => assert.match(match[1], /href="#[a-z0-9-]+"/));
});

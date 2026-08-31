import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');
const realtime = fs.readFileSync(path.join(root, 'js/services/realtime.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
const utils = fs.readFileSync(path.join(root, 'js/utils.js'), 'utf8');

test('Realtime subscription never masks failed Cloud reads', () => {
  assert.match(service, /export function getCloudReadHealth\(\)/);
  assert.match(service, /status: uniqueFailures\.length > 0 \? 'degraded' : 'healthy'/);
  assert.match(realtime, /getCloudReadHealth\(\)/);
  assert.match(realtime, /health\.status === 'degraded' \? 'cloud_degraded' : 'cloud'/);
  assert.match(utils, /status === 'cloud_degraded'/);
  assert.match(utils, /badge\.removeAttribute\('title'\)/);
});

test('failed lazy domains remain retryable instead of being marked loaded', () => {
  assert.match(main, /const failedDomains = new Set\(result\?\.failedDomains \|\| \[\]\)/);
  assert.match(main, /domains\.filter\(domain => !failedDomains\.has\(domain\)\)/);
});

test('ordinary Cloud reads never delete old drafts', () => {
  const start = service.indexOf('const fetchOrders = async () =>');
  const end = service.indexOf('const fetchCustomers = async () =>', start);
  const fetchOrders = service.slice(start, end);
  assert.doesNotMatch(fetchOrders, /\.delete\s*\(/);
  assert.doesNotMatch(fetchOrders, /twoDaysAgo/);
});

test('successful empty brand result is authoritative and refresh reports failures', () => {
  assert.match(service, /const sourceData = brandData \|\| \[\]/);
  assert.doesNotMatch(service, /brandData && brandData\.length > 0 \? brandData/);
  assert.match(service, /if \(result\.failedDomains\?\.length\)/);
  assert.match(service, /Dữ liệu đang thấy có thể là cache cũ/);
});

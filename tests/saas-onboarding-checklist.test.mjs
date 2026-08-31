import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboard = readFileSync(new URL('../js/components/dashboard.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('Owner and Admin receive a five-step tenant onboarding checklist', () => {
  assert.match(html, /id="saas-onboarding-checklist"/);
  assert.match(dashboard, /\['owner', 'admin'\]\.includes\(role\)/);
  for (const key of ['organization', 'members', 'products', 'customers', 'order']) {
    assert.match(dashboard, new RegExp(`key: '${key}'`));
  }
});

test('onboarding actions route through existing permission-aware navigation', () => {
  assert.match(dashboard, /class="saas-onboarding-action"/);
  assert.match(dashboard, /switchTab\(button\.dataset\.target\)/);
  assert.match(dashboard, /planUsage\?\.orders\?\.used/);
});

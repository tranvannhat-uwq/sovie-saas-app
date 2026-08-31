import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeIndustryKey,
  normalizePlatformCustomerPayload
} from '../js/domain/tenant-provisioning.js';

test('Vietnamese industry labels are normalized to stable internal keys', () => {
  assert.equal(normalizeIndustryKey('đa ngành'), 'general');
  assert.equal(normalizeIndustryKey('Tổng hợp'), 'general');
  assert.equal(normalizeIndustryKey('Thực phẩm & đồ uống'), 'food_beverage');
  assert.equal(normalizeIndustryKey('Sơn & phân phối'), 'paint_distribution');
  assert.equal(normalizeIndustryKey('Thương mại điện tử'), 'thuong-mai-dien-tu');
});

test('platform customer payload is normalized and validated before network calls', () => {
  const payload = normalizePlatformCustomerPayload({
    name: ' Công ty Tester ',
    slug: 'cong-ty-tester',
    ownerEmail: 'TVNHAT137@GMAIL.COM ',
    ownerName: ' Hứa Đức Quân ',
    planId: 'Pro',
    trialDays: '14',
    businessType: 'GENERAL_TRADE',
    industryKey: 'đa ngành'
  });
  assert.deepEqual(payload, {
    name: 'Công ty Tester',
    slug: 'cong-ty-tester',
    ownerEmail: 'tvnhat137@gmail.com',
    ownerName: 'Hứa Đức Quân',
    planId: 'pro',
    trialDays: 14,
    businessType: 'general_trade',
    industryKey: 'general'
  });
});

test('invalid provisioning values fail before reaching Supabase', () => {
  const valid = {
    name: 'Công ty Tester', slug: 'cong-ty-tester', ownerEmail: 'owner@example.com',
    ownerName: 'Owner Tester', planId: 'starter', trialDays: 14,
    businessType: 'general_trade', industryKey: 'general'
  };
  assert.throws(() => normalizePlatformCustomerPayload({ ...valid, slug: 'admin' }), /Tên miền con/);
  assert.throws(() => normalizePlatformCustomerPayload({ ...valid, ownerEmail: 'sai-email' }), /Email Owner/);
  assert.throws(() => normalizePlatformCustomerPayload({ ...valid, trialDays: 0 }), /1 đến 60/);
  assert.throws(() => normalizePlatformCustomerPayload({ ...valid, businessType: 'unknown' }), /Mô hình/);
});

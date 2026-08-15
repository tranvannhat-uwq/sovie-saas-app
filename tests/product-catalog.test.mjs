import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildVariantSnapshot,
  buildProductFamilies,
  getProductBaseCode,
  inferLegacyBaseCode,
  searchProductFamilies,
  shouldAutoSelectVariant,
  variantSpecification
} from '../js/domain/product-catalog.js';

const productsUi = readFileSync(new URL('../js/components/products.js', import.meta.url), 'utf8');
assert.match(productsUi, /'Lít', 'Cái', 'Bộ', 'Mét', 'Lọ'\]\.map\(value =>/);

const products = [
  {
    id: 'ct-d1-lon',
    code: 'CT-Đ1-LON',
    baseCode: 'CT-Đ1',
    name: 'Sơn lót chống kiềm nội thất cao cấp',
    brand: 'COVA NANO',
    packageType: 'Lon',
    packageWeight: 6.3,
    packageWeightUnit: 'kg',
    isActive: true,
    isLegacy: false
  },
  {
    id: 'ct-d1-thung',
    code: 'CT-Đ1-THÙNG',
    baseCode: 'CT-Đ1',
    name: 'Sơn lót chống kiềm nội thất cao cấp',
    brand: 'COVA NANO',
    packageType: 'Thùng',
    packageWeight: 22.5,
    packageWeightUnit: 'kg',
    isActive: true,
    isLegacy: false
  },
  {
    id: 'ct-d1-other-name',
    code: 'CT-Đ1-HỘP',
    baseCode: 'CT-Đ1',
    name: 'Sản phẩm khác',
    brand: 'COVA NANO',
    packageType: 'Hộp',
    packageWeight: 1,
    packageWeightUnit: 'kg',
    isActive: true,
    isLegacy: false
  },
  {
    id: 'ba-46-lon',
    code: 'BA-46-LON',
    name: 'Sơn siêu bóng',
    brand: 'MUTSUTEC NANO',
    packageType: 'Lon',
    packageWeight: 5.3,
    packageWeightUnit: 'kg',
    isActive: true,
    isLegacy: false
  }
];

assert.equal(inferLegacyBaseCode('CT-Đ1-THÙNG'), 'CT-Đ1');
assert.equal(inferLegacyBaseCode('SP-01-CAI'), 'SP-01');
assert.equal(inferLegacyBaseCode('SP-02-BO'), 'SP-02');
assert.equal(inferLegacyBaseCode('SP-03-MET'), 'SP-03');
assert.equal(inferLegacyBaseCode('SP-04-LO'), 'SP-04');
assert.equal(inferLegacyBaseCode('ABC-LÍT'), 'ABC');
assert.equal(inferLegacyBaseCode('NO-SUFFIX'), 'NO-SUFFIX');
assert.equal(getProductBaseCode(products[3], products), 'BA-46');
assert.equal(variantSpecification(products[0]), 'Lon 6,3 kg');
assert.equal(variantSpecification({ packageType: 'Cái', packageWeight: 1, packageWeightUnit: 'cái' }), 'Cái 1 cái');
assert.equal(variantSpecification({ packageType: 'Bộ', packageWeight: 1, packageWeightUnit: 'bộ' }), 'Bộ 1 bộ');
assert.equal(variantSpecification({ packageType: 'Mét', packageWeight: 1, packageWeightUnit: 'm' }), 'Mét 1 m');
assert.equal(variantSpecification({ packageType: 'Lọ', packageWeight: 1, packageWeightUnit: 'cái' }), 'Lọ 1 cái');
assert.deepEqual(buildVariantSnapshot(products[0]), {
  productGroupId: null,
  variantId: 'ct-d1-lon',
  variantCode: 'CT-Đ1-LON',
  baseCode: 'CT-Đ1',
  packagingName: 'Lon',
  weightOrVolume: 6.3,
  unitName: 'kg',
  specificationSnapshot: 'Lon 6,3 kg'
});
assert.equal(buildVariantSnapshot(products[1]).variantCode, 'CT-Đ1-THÙNG');
assert.equal(buildVariantSnapshot(products[1]).specificationSnapshot, 'Thùng 22,5 kg');

const families = buildProductFamilies(products);
assert.equal(families.length, 3);

const ctFamily = families.find(family => family.name === 'Sơn lót chống kiềm nội thất cao cấp');
assert.ok(ctFamily);
assert.equal(ctFamily.baseCode, 'CT-Đ1');
assert.deepEqual(ctFamily.variants.map(variant => variant.id).sort(), ['ct-d1-lon', 'ct-d1-thung']);

const skuSearch = searchProductFamilies(families, 'CT-Đ1-LON');
assert.equal(skuSearch.length, 1);
assert.equal(skuSearch[0].id, ctFamily.id);
assert.equal(skuSearch[0].matchedVariantId, 'ct-d1-lon');

assert.equal(searchProductFamilies(families, '22,5 kg')[0].id, ctFamily.id);
assert.equal(searchProductFamilies(families, 'COVA NANO').length, 2);
assert.equal(searchProductFamilies(families, 'Lon 6,3')[0].matchedVariantId, 'ct-d1-lon');
assert.equal(shouldAutoSelectVariant(ctFamily), false);
assert.equal(shouldAutoSelectVariant(families.find(family => family.baseCode === 'BA-46')), true);

console.log('product-catalog.test.mjs: all assertions passed');

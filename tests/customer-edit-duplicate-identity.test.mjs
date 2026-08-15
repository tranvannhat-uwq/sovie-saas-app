import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const customers = fs.readFileSync(path.join(root, 'js/components/customers.js'), 'utf8');
const saveCustomer = customers.slice(
  customers.indexOf('export async function saveCustomer()'),
  customers.indexOf('export async function deleteCustomer')
);

test('customer edit duplicate checks exclude the edited customer by stable id', () => {
  assert.match(
    saveCustomer,
    /state\.customers\.find\(customer => String\(customer\.id\) === String\(editId\)\)/
  );
  assert.match(
    saveCustomer,
    /if \(isEditing && String\(c\.id\) === String\(editId\)\) return false;/
  );
  assert.doesNotMatch(saveCustomer, /if \(idx === index\) return false;/);
});

test('customer edit preserves profile data from the id-resolved record', () => {
  assert.match(saveCustomer, /const oldCust = editedCustomer;/);
  assert.doesNotMatch(saveCustomer, /state\.customers\[index\]\.totalTransaction/);
});

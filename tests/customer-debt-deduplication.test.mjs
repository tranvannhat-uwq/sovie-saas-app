import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('finalizing an order does not append a second browser-only debt row', () => {
  const invoice = read('js/components/invoice.js');
  const finalizedBranch = invoice.slice(
    invoice.indexOf("if (status === 'draft')"),
    invoice.indexOf('// Lưu local')
  );
  assert.doesNotMatch(finalizedBranch, /debtHistory\.push/);
});

test('customer refresh merges the authoritative ledger and removes its legacy order twin', () => {
  const service = read('js/services/supabase.js');
  assert.match(service, /mergeCustomerDebtHistory\(/);
  assert.match(service, /if \(ledgerRows\)[\s\S]*ledgerRows\.map\(mapCustomerDebtTransaction\)/);
});

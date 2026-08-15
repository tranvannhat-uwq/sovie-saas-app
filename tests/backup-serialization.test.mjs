import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKUP_CHUNK_MANIFEST_COLUMN,
  EXCEL_SAFE_CELL_LENGTH,
  deserializeBackupRows,
  serializeBackupRows
} from '../js/services/backup-serialization.js';

test('backup serialization keeps every Excel cell below the safe length', () => {
  const longAuditJson = JSON.stringify({ payload: 'x'.repeat(90000) });
  const [serialized] = serializeBackupRows([{ id: 'audit-1', new_data: longAuditJson }]);

  for (const value of Object.values(serialized)) {
    if (typeof value === 'string') assert.ok(value.length <= EXCEL_SAFE_CELL_LENGTH);
  }
  assert.ok(serialized[BACKUP_CHUNK_MANIFEST_COLUMN]);
});

test('chunked backup values are reconstructed without data loss', () => {
  const original = [{
    id: 'audit-2',
    old_data: { payload: 'á'.repeat(70000), nested: { ok: true } },
    note: 'short value',
    nullable: null
  }];

  const restored = deserializeBackupRows(serializeBackupRows(original));
  assert.equal(restored[0].old_data, JSON.stringify(original[0].old_data));
  assert.equal(restored[0].note, original[0].note);
  assert.equal(restored[0].nullable, null);
  assert.equal(restored[0][BACKUP_CHUNK_MANIFEST_COLUMN], undefined);
});

test('corrupted chunk manifests are rejected during backup dry-run', () => {
  assert.throws(
    () => deserializeBackupRows([{
      id: 'audit-3',
      new_data: 'first part',
      [BACKUP_CHUNK_MANIFEST_COLUMN]: JSON.stringify([['new_data', 2]])
    }]),
    /Thiếu phần 2\/2/
  );
});

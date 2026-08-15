import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAllPages } from '../js/domain/pagination.js';

test('pagination continues when the server caps each response below the requested page size', async () => {
  const rows = Array.from({ length: 1420 }, (_, index) => ({ id: index + 1 }));
  const offsets = [];
  const result = await collectAllPages(async offset => {
    offsets.push(offset);
    return { data: rows.slice(offset, offset + 500), count: rows.length, error: null };
  }, 1000);

  assert.equal(result.length, 1420);
  assert.deepEqual(offsets, [0, 500, 1000]);
  assert.equal(result.at(-1).id, 1420);
});

test('pagination also reaches the empty page when exact count is unavailable', async () => {
  const rows = Array.from({ length: 750 }, (_, index) => ({ id: index + 1 }));
  const offsets = [];
  const result = await collectAllPages(async offset => {
    offsets.push(offset);
    return { data: rows.slice(offset, offset + 500), count: null, error: null };
  }, 1000);

  assert.equal(result.length, 750);
  assert.deepEqual(offsets, [0, 500, 750]);
});

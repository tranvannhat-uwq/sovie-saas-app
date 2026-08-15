import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWithConcurrency } from '../js/domain/async-pool.js';

test('async pool limits parallel work, preserves order and reports progress', async () => {
  let active = 0;
  let peak = 0;
  const progress = [];
  const values = [30, 5, 20, 1, 10, 2];

  const result = await mapWithConcurrency(values, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, delay));
    active -= 1;
    return `row-${index}`;
  }, {
    limit: 3,
    onProgress: event => progress.push(event.completed)
  });

  assert.equal(peak, 3);
  assert.deepEqual(result, values.map((_value, index) => `row-${index}`));
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6]);
});

test('async pool drains in-flight work before reporting an error', async () => {
  let active = 0;
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3], async value => {
      active += 1;
      await new Promise(resolve => setTimeout(resolve, value === 0 ? 1 : 10));
      active -= 1;
      if (value === 0) throw new Error('table failed');
      return value;
    }, { limit: 3 }),
    /table failed/
  );
  assert.equal(active, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardChartSeries } from '../js/domain/dashboard-series.js';

const augustSeries = [
  { date: '2026-08-04', amount: 89529216 },
  { date: '2026-08-05', amount: 152990273 },
  { date: '2026-08-06', amount: 105556430 },
  { date: '2026-08-07', amount: 154388816 },
  { date: '2026-08-08', amount: 114033581 }
];

test('year chart groups authoritative daily revenue into twelve months', () => {
  const result = buildDashboardChartSeries(augustSeries, 'year', {
    start: '2026-01-01T00:00:00+07:00',
    end: '2027-01-01T00:00:00+07:00'
  });
  assert.equal(result.labels.length, 12);
  assert.equal(result.dataPoints[7], 616498316);
  assert.equal(result.dataPoints.reduce((sum, value) => sum + value, 0), 616498316);
});

test('month chart fills missing calendar days without changing total revenue', () => {
  const result = buildDashboardChartSeries(augustSeries, 'month', {
    start: '2026-08-01T00:00:00+07:00',
    end: '2026-09-01T00:00:00+07:00'
  });
  assert.equal(result.labels.length, 31);
  assert.equal(result.dataPoints[0], 0);
  assert.equal(result.dataPoints[3], 89529216);
  assert.equal(result.dataPoints.reduce((sum, value) => sum + value, 0), 616498316);
});

test('week chart labels and zero-fills all seven days', () => {
  const result = buildDashboardChartSeries([{ date: '2026-08-04', amount: 10 }], 'week', {
    start: '2026-08-03T00:00:00+07:00',
    end: '2026-08-10T00:00:00+07:00'
  });
  assert.deepEqual(result.dataPoints, [0, 10, 0, 0, 0, 0, 0]);
  assert.equal(result.labels.length, 7);
});

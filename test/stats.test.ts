import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats, mad, median, quantile, recencyWeight, rejectOutliers, trendPct } from '../src/valuation/stats.ts';

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

test('median and quantiles interpolate', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([10, 20, 30, 40], 0.25), 17.5);
});

test('MAD is unmoved by a single extreme value', () => {
  const tight = [10, 11, 12, 11, 10];
  const withOutlier = [...tight, 900];
  assert.ok(Math.abs(mad(tight) - mad(withOutlier)) < 2);
});

test('outlier rejection uses indices so duplicate prices are counted separately', () => {
  const xs = [4, 4, 4, 4, 4, 400];
  const { keptIdx, removedIdx } = rejectOutliers(xs);
  assert.equal(keptIdx.length, 5);
  assert.deepEqual(removedIdx, [5]);
});

test('never discards more than 30% of the evidence', () => {
  const xs = [1, 1, 1, 500, 600, 700, 800];
  const { keptIdx } = rejectOutliers(xs);
  assert.ok(keptIdx.length >= Math.ceil(xs.length * 0.7));
});

test('all-identical prices yield no outliers', () => {
  const { removedIdx } = rejectOutliers([5, 5, 5, 5, 5]);
  assert.equal(removedIdx.length, 0);
});

test('one absurd sale does not move fair value', () => {
  const comps = [
    { priceAud: 40, soldAt: daysAgo(3) },
    { priceAud: 42, soldAt: daysAgo(6) },
    { priceAud: 38, soldAt: daysAgo(9) },
    { priceAud: 41, soldAt: daysAgo(12) },
    { priceAud: 39, soldAt: daysAgo(15) },
    { priceAud: 4000, soldAt: daysAgo(2) },   // mismatched listing
  ];
  const st = computeStats(comps);
  assert.ok(st.fairValue > 35 && st.fairValue < 46, `fairValue was ${st.fairValue}`);
  assert.equal(st.outliers.length, 1);
  assert.equal(st.nUsed, 5);
});

test('recency weighting pulls value toward recent sales in a falling market', () => {
  const falling = [
    { priceAud: 100, soldAt: daysAgo(85) },
    { priceAud: 95, soldAt: daysAgo(70) },
    { priceAud: 80, soldAt: daysAgo(45) },
    { priceAud: 70, soldAt: daysAgo(20) },
    { priceAud: 62, soldAt: daysAgo(8) },
    { priceAud: 60, soldAt: daysAgo(3) },
  ];
  const st = computeStats(falling, { halfLifeDays: 30 });
  assert.ok(st.fairValue < st.median, `expected fair value ${st.fairValue} below median ${st.median}`);
  assert.ok(st.fairValue > 55 && st.fairValue < 80);
});

test('a longer half-life weights older sales more (icon behaviour)', () => {
  const comps = [
    { priceAud: 100, soldAt: daysAgo(80) },
    { priceAud: 100, soldAt: daysAgo(60) },
    { priceAud: 60, soldAt: daysAgo(4) },
    { priceAud: 60, soldAt: daysAgo(2) },
  ];
  const fast = computeStats(comps, { halfLifeDays: 30 }).fairValue;
  const slow = computeStats(comps, { halfLifeDays: 300 }).fairValue;
  assert.ok(slow > fast, `slow ${slow} should exceed fast ${fast}`);
});

test('recency weight halves at the half-life', () => {
  assert.ok(Math.abs(recencyWeight(daysAgo(30), 30) - 0.5) < 0.01);
  assert.ok(Math.abs(recencyWeight(daysAgo(0), 30) - 1) < 0.01);
});

test('confidence is low on thin data and higher on deep agreeing data', () => {
  const thin = computeStats([
    { priceAud: 50, soldAt: daysAgo(1) },
    { priceAud: 90, soldAt: daysAgo(60) },
  ]);
  const deep = computeStats(Array.from({ length: 14 }, (_, i) => ({ priceAud: 50 + (i % 3), soldAt: daysAgo(i + 1) })));
  assert.ok(deep.confidence > thin.confidence);
  assert.ok(deep.confidence > 0.7, `deep confidence ${deep.confidence}`);
  assert.ok(thin.confidence < 0.6, `thin confidence ${thin.confidence}`);
});

test('empty comp set is handled without throwing', () => {
  const st = computeStats([]);
  assert.equal(st.n, 0);
  assert.equal(st.fairValue, 0);
  assert.equal(st.confidence, 0);
});

test('trend needs enough data on both sides of the cut', () => {
  assert.equal(trendPct([{ priceAud: 10, soldAt: daysAgo(1) }], 30), null);
  const comps = [
    ...Array.from({ length: 4 }, (_, i) => ({ priceAud: 100, soldAt: daysAgo(50 + i) })),
    ...Array.from({ length: 4 }, (_, i) => ({ priceAud: 75, soldAt: daysAgo(5 + i) })),
  ];
  const t = trendPct(comps, 30);
  assert.ok(t != null && t < -20 && t > -30, `trend was ${t}`);
});

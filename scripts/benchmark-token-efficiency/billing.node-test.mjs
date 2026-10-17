import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, commonPrefixLength, exactCacheRead, projectPrefixPolicy, projectMeasuredCounts } from './billing.mjs';
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
test('input partitions receive distinct rates', () => {
  const result = calculateCost({ inputTokens: 2000, cachedTokens: 1024, cacheWriteTokens: 512, outputTokens: 100 });
  assert.equal(result.ordinaryInputTokens, 464);
  close(result.totalUSD, (464 * 2 + 1024 * .1 + 512 * 2.5 + 100 * 10) / 1e6);
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => calculateCost({ inputTokens: bad }));
  assert.throws(() => calculateCost({ inputTokens: 100, cachedTokens: 60, cacheWriteTokens: 41 }));
});
test('long threshold applies to the whole request including cached input', () => {
  assert.equal(calculateCost({ inputTokens: 272000 }).tier, 'short');
  const result = calculateCost({ inputTokens: 272001, cachedTokens: 270000, cacheWriteTokens: 1000, outputTokens: 100 });
  assert.equal(result.tier, 'long');
  close(result.totalUSD, (1001 * 4 + 270000 * .2 + 1000 * 5 + 100 * 15) / 1e6);
});
test('exact mismatch and exact eligible endpoint counts', () => {
  assert.equal(commonPrefixLength([1, 2, 3], [1, 7, 3]), 1);
  assert.equal(commonPrefixLength([1, 2], [1, 2, 3]), 2);
  assert.equal(exactCacheRead(1023), 0);
  assert.equal(exactCacheRead(1024), 1024);
  assert.equal(exactCacheRead(1151), 1151);
  assert.equal(exactCacheRead(1152), 1152);
});
test('five-turn cache and full bust have hand-computed costs', () => {
  const requests = Array.from({ length: 5 }, (_, turn) => ({ promptIds: Array(1024 + turn * 128).fill(1), eligibleEnd: 1024 + turn * 128, lookupBoundaries: Array.from({ length: turn + 1 }, (_, i) => 1024 + i * 128), outputTokens: 10 }));
  const warm = projectPrefixPolicy(requests);
  // First 1024 writes; each later turn reads its predecessor and writes 128 new units.
  close(warm.totalUSD, (1536 * 2.5 + (1024 + 1152 + 1280 + 1408) * .1 + 50 * 10) / 1e6);
  const bust = projectPrefixPolicy(requests, { evictAt: [0, 1, 2, 3, 4] });
  close(bust.totalUSD, ((1024 + 1152 + 1280 + 1408 + 1536) * 2.5 + 50 * 10) / 1e6);
  close(warm.noHitTotalUSD, bust.totalUSD);
  assert.equal(bust.rows[4].cachedTokens, 0);
  assert.equal(bust.rows[4].structuralMaximumEligibleTokens, 1408);
});
test('suffix is ordinary input and a partial mismatch cannot match a saved endpoint', () => {
  const first = Array(1300).fill(1);
  const second = [...first]; second[1100] = 2;
  const result = projectPrefixPolicy([{ promptIds: first, eligibleEnd: 1200 }, { promptIds: second, eligibleEnd: 1200 }]);
  assert.equal(result.rows[1].residentExactPrefixTokens, 1100);
  assert.equal(result.rows[1].cachedTokens, 0);
  assert.equal(result.rows[1].cacheWriteTokens, 1200);
  assert.equal(result.rows[1].ordinaryInputTokens, 100);
  assert.throws(() => projectPrefixPolicy([{ promptIds: first }]));
  assert.throws(() => projectPrefixPolicy([{ promptIds: first, eligibleEnd: 1301 }]));
});

test('prefix eligibility minimum leaves smaller prompts ordinary', () => {
  for (const eligibleEnd of [0, 1023, 1024]) {
    const result = projectPrefixPolicy([{ promptIds: Array(1100).fill(1), eligibleEnd }]);
    assert.equal(result.rows[0].cacheWriteTokens, eligibleEnd < 1024 ? 0 : 1024);
    assert.equal(result.rows[0].ordinaryInputTokens, eligibleEnd < 1024 ? 1100 : 76);
    assert.equal(result.rows[0].noHitCost.cacheWriteTokens, result.rows[0].cacheWriteTokens);
  }
});
test('measured projections bound partitions and distinguish transferred counts', () => {
  const rows = [{ inputTokens: 1400, eligiblePrefixTokens: 1200, maxEarlierEligiblePrefixTokens: 1151, matchedEarlierBoundaryTokens: 1133, scriptedOutputTokens: 10, splashCachedTokens: 1133 }];
  const structural = projectMeasuredCounts(rows);
  assert.equal(structural.rows[0].cachedTokens, 1133);
  assert.equal(structural.rows[0].cacheWriteTokens, 67);
  assert.equal(structural.rows[0].ordinaryInputTokens, 200);
  const observed = projectMeasuredCounts(rows, 'observedSplash');
  assert.equal(observed.rows[0].cachedTokens, 1133);
  assert.match(observed.scenario, /not actual Sol hits/);
  assert.equal(projectMeasuredCounts(rows, 'zero').rows[0].cacheWriteTokens, 1200);
  assert.equal(projectMeasuredCounts([{ ...rows[0], splashCachedTokens: 1500 }], 'observedSplash').rows[0].cachedTokens, 1200);
  const below = projectMeasuredCounts([{ inputTokens: 1100, eligiblePrefixTokens: 1023, maxEarlierEligiblePrefixTokens: 1100 }]);
  assert.equal(below.rows[0].cachedTokens, 0);
  assert.equal(below.rows[0].cacheWriteTokens, 0);
  assert.equal(below.rows[0].ordinaryInputTokens, 1100);
  assert.throws(() => projectMeasuredCounts([{ ...rows[0], eligiblePrefixTokens: 1401 }]));
  assert.throws(() => projectMeasuredCounts(rows, 'wrong'));
  assert.throws(() => projectMeasuredCounts([{ ...rows[0], splashCachedTokens: -1 }], 'observedSplash'));
});

test('saved endpoint must occur in the incoming lookup window', () => {
  const first = { promptIds: Array(1100).fill(1), eligibleEnd: 1100 };
  const next = { promptIds: Array(1300).fill(1), eligibleEnd: 1300, lookupBoundaries: [1100, 1300] };
  const matched = projectPrefixPolicy([first, next]);
  assert.equal(matched.rows[1].cachedTokens, 1100);
  const absent = projectPrefixPolicy([first, { ...next, lookupBoundaries: [1099, 1300] }]);
  assert.equal(absent.rows[1].residentExactPrefixTokens, 1100);
  assert.equal(absent.rows[1].cachedTokens, 0);
  assert.equal(projectPrefixPolicy([first, next], { evictAt: [1] }).rows[1].cachedTokens, 0);
  const upper = projectMeasuredCounts([{ inputTokens: 1300, eligiblePrefixTokens: 1300, maxEarlierEligiblePrefixTokens: 1100 }], 'structuralUpperBound');
  assert.match(upper.scenario, /not a Sol cache-policy projection/);
});

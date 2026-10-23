/** Hypothetical Responses rate-card projection; callers must identify token units. */
export const LONG_INPUT_THRESHOLD = 272_000;
export const RATES = Object.freeze({
  short: Object.freeze({ ordinaryInput: 2, cacheRead: 0.10, cacheWrite: 2.50, output: 10 }),
  long: Object.freeze({ ordinaryInput: 4, cacheRead: 0.20, cacheWrite: 5, output: 15 }),
});
function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
}
export function calculateCost({ inputTokens, cachedTokens = 0, cacheWriteTokens = 0, outputTokens = 0 }) {
  for (const [name, value] of Object.entries({ inputTokens, cachedTokens, cacheWriteTokens, outputTokens })) count(value, name);
  if (cachedTokens + cacheWriteTokens > inputTokens) throw new RangeError('cache reads and writes must partition input tokens');
  const tier = inputTokens > LONG_INPUT_THRESHOLD ? 'long' : 'short';
  const rates = RATES[tier];
  const ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens;
  const costs = {
    ordinaryInput: ordinaryInputTokens * rates.ordinaryInput / 1_000_000,
    cacheRead: cachedTokens * rates.cacheRead / 1_000_000,
    cacheWrite: cacheWriteTokens * rates.cacheWrite / 1_000_000,
    output: outputTokens * rates.output / 1_000_000,
  };
  return { tier, rates, inputTokens, ordinaryInputTokens, cachedTokens, cacheWriteTokens, outputTokens, costs,
    totalUSD: Object.values(costs).reduce((a, b) => a + b, 0) };
}
export function commonPrefixLength(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return i;
}
export function exactCacheRead(tokens) {
  count(tokens, 'tokens');
  return tokens < 1024 ? 0 : tokens;
}
/** eligibleEnd is an exclusive token offset supplied from a rendered user/tool boundary. */
export function projectPrefixPolicy(requests, { evictAt = [] } = {}) {
  const eviction = new Set(evictAt);
  for (const index of eviction) count(index, 'eviction index');
  let resident = [];
  const history = [];
  const rows = requests.map((request, index) => {
    const { promptIds, eligibleEnd, lookupBoundaries = [eligibleEnd], outputTokens = 0 } = request;
    if (!Array.isArray(promptIds) || !promptIds.every(id => Number.isSafeInteger(id) && id >= 0)) throw new TypeError('promptIds must be nonnegative integer token IDs');
    count(eligibleEnd, 'eligibleEnd');
    if (eligibleEnd > promptIds.length) throw new RangeError('eligibleEnd exceeds input length');
    if (eviction.has(index)) resident = [];
    const eligible = promptIds.slice(0, eligibleEnd);
    const longest = collection => collection.reduce((best, previous) => Math.max(best, commonPrefixLength(eligible, previous)), 0);
    const structuralMaximumEligibleTokens = longest(history);
    const residentExactPrefixTokens = longest(resident);
    for (const boundary of lookupBoundaries) {
      count(boundary, 'lookup boundary');
      if (boundary > eligibleEnd) throw new RangeError('lookup boundary exceeds eligible end');
    }
    const matchedEarlierBoundaryTokens = resident.reduce((best, previous) =>
      lookupBoundaries.includes(previous.length) && commonPrefixLength(eligible, previous) === previous.length
        ? Math.max(best, previous.length) : best, 0);
    const cachedTokens = exactCacheRead(matchedEarlierBoundaryTokens);
    const cacheWriteTokens = eligibleEnd < 1024 ? 0 : eligibleEnd - cachedTokens;
    const cost = calculateCost({ inputTokens: promptIds.length, cachedTokens, cacheWriteTokens, outputTokens });
    const noHitCost = calculateCost({ inputTokens: promptIds.length, cacheWriteTokens: eligibleEnd < 1024 ? 0 : eligibleEnd, outputTokens });
    resident.push(eligible);
    history.push(eligible);
    return { index, eligibleEnd, structuralMaximumEligibleTokens, residentExactPrefixTokens, matchedEarlierBoundaryTokens, ...cost, noHitCost };
  });
  return { scenario: 'hypothetical exact-prefix residency policy; no observed Sol cache hits', rows,
    totalUSD: rows.reduce((sum, row) => sum + row.totalUSD, 0),
    noHitTotalUSD: rows.reduce((sum, row) => sum + row.noHitCost.totalUSD, 0) };
}

/** Observed Splash counts are transferred sensitivity inputs, never measured Sol hits. */
export function projectMeasuredCounts(rows, cacheSelection = 'boundaries') {
  if (!['boundaries', 'structuralUpperBound', 'observedSplash', 'zero'].includes(cacheSelection)) throw new TypeError('unknown cache selection');
  const projected = rows.map((row, index) => {
    const { inputTokens, eligiblePrefixTokens, maxEarlierEligiblePrefixTokens = 0, matchedEarlierBoundaryTokens = 0, scriptedOutputTokens = 0 } = row;
    count(inputTokens, 'inputTokens');
    count(eligiblePrefixTokens, 'eligiblePrefixTokens');
    count(maxEarlierEligiblePrefixTokens, 'maxEarlierEligiblePrefixTokens');
    count(matchedEarlierBoundaryTokens, 'matchedEarlierBoundaryTokens');
    if (eligiblePrefixTokens > inputTokens) throw new RangeError('eligible prefix exceeds input');
    let cachedTokens = 0;
    if (cacheSelection === 'boundaries') cachedTokens = exactCacheRead(Math.min(eligiblePrefixTokens, matchedEarlierBoundaryTokens));
    if (cacheSelection === 'structuralUpperBound') cachedTokens = exactCacheRead(Math.min(eligiblePrefixTokens, maxEarlierEligiblePrefixTokens));
    if (cacheSelection === 'observedSplash') {
      const observed = row.splashCachedTokens ?? row.splashUsage?.cached_tokens ?? row.splashUsage?.prompt_tokens_details?.cached_tokens;
      count(observed, 'Splash cached tokens');
      cachedTokens = Math.min(observed, eligiblePrefixTokens);
    }
    const cacheWriteTokens = eligiblePrefixTokens < 1024 ? 0 : eligiblePrefixTokens - cachedTokens;
    return { index, eligiblePrefixTokens, ...calculateCost({ inputTokens, cachedTokens, cacheWriteTokens, outputTokens: scriptedOutputTokens }) };
  });
  const scenario = cacheSelection === 'observedSplash'
    ? 'observed Splash cache counts transferred to hypothetical Sol rate-card accounting; not actual Sol hits'
    : cacheSelection === 'structuralUpperBound' ? 'structural LCP upper bound only; not a Sol cache-policy projection' : cacheSelection === 'boundaries' ? 'exact eligible-boundary residency sensitivity; not observed Sol hits' : 'zero cache reads sensitivity';
  return { cacheSelection, scenario, rows: projected, totalUSD: projected.reduce((sum, row) => sum + row.totalUSD, 0) };
}

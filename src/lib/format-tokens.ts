/** Token counts as quiet metadata: "842 tokens", "12.3k", "1.2M".
 *
 * Null (not "0") for zero so callers can drop the chip entirely — a task
 * that never ran shouldn't advertise a tally. Rounding runs on integer
 * tenths (n/100, n/100_000) rather than floats: 999_950/1000*10 lands on
 * 9999.499… in binary and would round DOWN to "999.9k" instead of
 * promoting to "1M". */
export function formatTokens(total: number): string | null {
  if (!Number.isFinite(total) || total < 1) return null;
  const n = Math.trunc(total);
  if (n < 1000) return n === 1 ? "1 token" : `${n} tokens`;
  // tenths-of-a-thousand; >= 10000 tenths means the rounded value hit 1000k
  const kTenths = Math.round(n / 100);
  if (kTenths < 10_000) return `${tenths(kTenths)}k`;
  return `${tenths(Math.round(n / 100_000))}M`;
}

/** 123 tenths → "12.3"; whole values drop the ".0" ("1k", not "1.0k"). */
function tenths(t: number): string {
  const frac = t % 10;
  return frac === 0 ? `${t / 10}` : `${(t - frac) / 10}.${frac}`;
}

// The phases a bot turn's time is split into, and the fixed-bucket histograms they are counted in. Numbers only.

/**
 * `queue`: from the person's message being stored to its turn starting. `handshake`: from the turn starting to its engine's
 * session starting (absent on a warm engine). `ttft`: from the turn starting to the engine's first output (a token, a tool
 * call or an ask). The rest split the turn's whole time (`total`) with nothing counted twice: `model` (the engine thinking
 * and streaming), `tool` (at least one tool call open), `resource` (queued for a computer or a browser), `person` (an
 * approval or a question waiting on someone), `retry` (from a retry's announcement to the engine's next event).
 */
export const PHASES = ["queue", "handshake", "ttft", "model", "tool", "resource", "person", "retry", "total"] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseMs = Partial<Record<Phase, number>>;

/** Upper bucket edges, ms; one more bucket counts everything slower. A percentile read from them is the edge of its
 * bucket (never above the largest value seen), so it reads high by at most the step to that edge: x1.28 from 100 ms to
 * 5 s, where handshakes and first tokens fall, x1.5 elsewhere, and up to 50 ms below 50 ms. */
export const BUCKET_EDGES_MS = [
  50, 75, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1_000, 1_250, 1_600, 2_000, 2_500, 3_200, 4_000, 5_000,
  7_500, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 240_000, 300_000, 450_000, 600_000,
  900_000, 1_200_000, 1_800_000, 2_700_000, 3_600_000, 5_400_000, 7_200_000,
] as const;
const BUCKETS = BUCKET_EDGES_MS.length + 1;

export interface Histogram { counts: number[]; max: number; sum: number }

export const emptyHistogram = (): Histogram => ({ counts: Array.from({ length: BUCKETS }, () => 0), max: 0, sum: 0 });

export function bucketOf(ms: number): number {
  let low = 0, high: number = BUCKET_EDGES_MS.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ms <= BUCKET_EDGES_MS[mid]!) high = mid; else low = mid + 1;
  }
  return low;
}

export function addTo(histogram: Histogram, ms: number): void {
  const value = Math.max(0, Math.round(ms));
  histogram.counts[bucketOf(value)]! += 1;
  histogram.max = Math.max(histogram.max, value);
  histogram.sum += value;
}

export function mergeInto(into: Histogram, from: Histogram): void {
  for (let index = 0; index < BUCKETS; index++) into.counts[index]! += from.counts[index] ?? 0;
  into.max = Math.max(into.max, from.max);
  into.sum += from.sum;
}

export const countOf = (histogram: Histogram): number => histogram.counts.reduce((sum, count) => sum + count, 0);

/** The edge of the bucket holding the q-th value, never above the largest value seen. */
export function histogramQuantile(histogram: Histogram, q: number): number {
  const total = countOf(histogram);
  if (!total) return 0;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let index = 0; index < BUCKETS; index++) {
    seen += histogram.counts[index]!;
    if (seen >= rank) return Math.min(BUCKET_EDGES_MS[index] ?? histogram.max, histogram.max);
  }
  return histogram.max;
}

/** Exact nearest-rank percentile of a list. */
export function exactQuantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export interface PhaseStats { p50: number; p95: number; max: number; n: number }

/** A histogram read back from disk: anything malformed counts as empty. */
export function parseHistogram(value: unknown): Histogram {
  const raw = value as Partial<Histogram> | null;
  const counts = Array.isArray(raw?.counts) && raw.counts.length === BUCKETS && raw.counts.every((count) => Number.isSafeInteger(count) && count >= 0)
    ? [...raw.counts] : null;
  if (!counts) return emptyHistogram();
  const finite = (number: unknown) => (typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : 0);
  return { counts, max: finite(raw?.max), sum: finite(raw?.sum) };
}

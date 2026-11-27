/** One native `result` frame. A steer sent after the turn's last model call runs as the CLI's next
 * native turn, so one logical turn can span several. */
export interface NativeTurnResult {
  ok: boolean;
  stopReason: string | null;
  cost: number | null;
  usage?: { input: number; output: number; cachedInput?: number };
  unsent?: true;
}

/** Merges native turns into one logical turn. Cost takes the latest figure: total_cost_usd is
 * "cumulative across turns in streaming-input sessions … read the latest result rather than
 * summing" (2.1.282). */
export function sumNativeTurnResults(earlier: NativeTurnResult | null, latest: NativeTurnResult): NativeTurnResult {
  if (!earlier) return latest;
  const usage = earlier.usage && latest.usage
    ? {
        input: earlier.usage.input + latest.usage.input,
        output: earlier.usage.output + latest.usage.output,
        ...(earlier.usage.cachedInput !== undefined || latest.usage.cachedInput !== undefined
          ? { cachedInput: (earlier.usage.cachedInput ?? 0) + (latest.usage.cachedInput ?? 0) }
          : {}),
      }
    : latest.usage ?? earlier.usage;
  return {
    ok: earlier.ok && latest.ok,
    stopReason: latest.stopReason ?? earlier.stopReason,
    cost: latest.cost ?? earlier.cost,
    ...(usage ? { usage } : {}),
    ...(earlier.unsent && latest.unsent ? { unsent: true as const } : {}),
  };
}

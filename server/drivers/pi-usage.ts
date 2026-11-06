/** pi-ai's per-message usage: `input` excludes cached prompt tokens, and `cost` is pi's own priced USD. */
export type PiUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
export type TurnUsage = { input: number; output: number; cachedInput?: number };

const usageCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** One pi run's tokens and priced cost, in the app's shape where input includes cached tokens like the other drivers. */
export class PiRunUsage {
  usage: TurnUsage | undefined;
  /** pi's priced USD. A zero is pi's default for a model without prices, so it stays unknown rather than booked as free. */
  cost: number | undefined;
  // pi sends a model call's usage on its assistant message_end, before any tool runs, and again on turn_end.
  private counted = false;

  /** Counts the current model call's usage once, so a stop while a tool runs still books it. */
  add(usage: PiUsage | undefined): void {
    if (!usage || this.counted) return;
    this.counted = true;
    const total = this.usage;
    const cacheRead = usageCount(usage.cacheRead);
    const cachedInput = cacheRead === undefined ? total?.cachedInput : (total?.cachedInput ?? 0) + cacheRead;
    this.usage = {
      input: (total?.input ?? 0) + (usageCount(usage.input) ?? 0) + (cacheRead ?? 0) + (usageCount(usage.cacheWrite) ?? 0),
      output: (total?.output ?? 0) + (usageCount(usage.output) ?? 0),
      ...(cachedInput === undefined ? {} : { cachedInput }),
    };
    const cost = usageCount(usage.cost?.total);
    if (cost) this.cost = (this.cost ?? 0) + cost;
  }

  /** turn_end closes a model call; the next call is counted again. */
  endTurn(usage: PiUsage | undefined): void {
    this.add(usage);
    this.counted = false;
  }
}

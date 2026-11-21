// A hand-off loop's hard stop. Rework sent back to one teammate is counted per request, so a worker and a checker that
// never agree end after REWORK_MAX rounds whatever their instructions say; the runtime's own loop guards reset on every
// result that comes back, so they never see this loop.

export const REWORK_MAX = 4;
const KEPT_MS = 6 * 60 * 60_000;

export const reworkRefusal = (bot: string): string =>
  `coordinate_bots was not run: this would be rework number ${REWORK_MAX + 1} sent to ${bot} for the same request, past the limit of ${REWORK_MAX}, so nothing was sent. Stop here: give the person the latest result and say what is still open, with ${bot}'s last report.`;

export function createReworkCap(now: () => number = Date.now) {
  const counts = new Map<string, { count: number; at: number }>();
  return {
    /** Counts one rework to each of `botIds` under `request`; the refusal for the first that is past the limit, which counts none. */
    take(request: string, botIds: readonly string[], name: (botId: string) => string): string | null {
      const at = now();
      for (const [key, entry] of counts) if (at - entry.at > KEPT_MS) counts.delete(key);
      const keys = botIds.map((botId) => `${request}\u0000${botId}`);
      const over = botIds.find((_botId, index) => (counts.get(keys[index]!)?.count ?? 0) >= REWORK_MAX);
      if (over !== undefined) return reworkRefusal(name(over));
      for (const key of keys) counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, at });
      return null;
    },
  };
}

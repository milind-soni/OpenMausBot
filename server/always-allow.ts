// A bot's (and each of its threads') "Always allow" list has a fixed size. A grant past it is refused, never dropped,
// so the approval card that asked to remember it stays waiting instead of being allowed as if it had been saved.
export const MAX_ALWAYS_ALLOW = 200;

/** `keys` with `key` added (once), or null when there is no room for it. */
export function withAlwaysAllowKey(keys: readonly string[] | undefined, key: string): string[] | null {
  const next = [...new Set([...(keys ?? []), key])];
  return next.length > MAX_ALWAYS_ALLOW ? null : next;
}

/** At start, a bot's grants with those recovered from its threads (newest thread first). The bot's own come first, as they
 * are the ones in force; past the limit the newest of its own stay, and one line says how many were kept: never silently. */
export function recoveredGrants(own: readonly string[] | undefined, recovered: readonly string[], botId: string, log: (line: string) => void = console.warn): string[] {
  const mine = [...new Set(own ?? [])];
  const all = [...new Set([...mine, ...recovered])];
  if (all.length <= MAX_ALWAYS_ALLOW) return all;
  const kept = mine.length >= MAX_ALWAYS_ALLOW ? mine.slice(-MAX_ALWAYS_ALLOW) : all.slice(0, MAX_ALWAYS_ALLOW);
  log(`[always-allow] bot ${botId}: kept ${kept.length} of ${all.length} always-allowed tools (the limit is ${MAX_ALWAYS_ALLOW}); the other ${all.length - kept.length} ask again.`);
  return kept;
}

// A bot's (and each of its threads') "Always allow" list has a fixed size. A grant past it is refused, never dropped,
// so the approval card that asked to remember it stays waiting instead of being allowed as if it had been saved.
export const MAX_ALWAYS_ALLOW = 200;

/** `keys` with `key` added (once), or null when there is no room for it. */
export function withAlwaysAllowKey(keys: readonly string[] | undefined, key: string): string[] | null {
  const next = [...new Set([...(keys ?? []), key])];
  return next.length > MAX_ALWAYS_ALLOW ? null : next;
}

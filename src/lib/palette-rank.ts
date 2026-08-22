/** Ranking for the command palette's name lists (bots, rooms).
 *
 * A prefix match is almost always what a few typed letters mean, so those
 * rows outrank plain substring matches. Within each tier the input order is
 * preserved — the caller's list already encodes a meaningful order (pinned
 * first, recency, …) and re-sorting it here would fight that. */
export function rankByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  // empty query = switcher mode: everything, untouched
  if (!q) return [...items];
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(item);
    else if (name.includes(q)) substring.push(item);
  }
  return [...prefix, ...substring];
}

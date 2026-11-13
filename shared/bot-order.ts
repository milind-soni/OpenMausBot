/** A stable partial reorder: the listed items take, in the order given, the positions they already occupy together;
 * every other item keeps its place. Ids the list does not have are ignored. So a client can reorder one bucket
 * (a team, Pinned, the loose bots) without knowing the whole fleet. */
export function reorderStable<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index] as const));
  const slots: number[] = [];
  items.forEach((item, index) => { if (rank.has(item.id)) slots.push(index); });
  const moved = slots.map((slot) => items[slot]!).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const out = [...items];
  slots.forEach((slot, index) => { out[slot] = moved[index]!; });
  return out;
}

/** Reorders `items` itself the same way (the server's schedulers and other readers hold the array and its records).
 * False, and nothing changes, for an empty list, a repeated id or an id it does not have. */
export function reorderInPlace<T extends { id: string }>(items: T[], ids: readonly string[]): boolean {
  if (!ids.length || new Set(ids).size !== ids.length) return false;
  const known = new Set(items.map((item) => item.id));
  if (ids.some((id) => !known.has(id))) return false;
  items.splice(0, items.length, ...reorderStable(items, ids));
  return true;
}

/** The reordered list, or null when no item moved (a client then keeps its state as it is). */
export function reorderIfMoved<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] | null {
  const next = reorderStable(items, ids);
  return next.some((item, index) => item !== items[index]) ? next : null;
}

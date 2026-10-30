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

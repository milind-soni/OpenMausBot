export const PINNED_CIRCLE_DRAG_TYPE = "application/x-openmausbot-pinned-circle";

export type PinnedCircleDropPlace = "before" | "after";
export type PinnedCircleDrop = { id: string; place: PinnedCircleDropPlace; axis: "x" | "y" };

export function placePinnedCircle(
  ids: readonly string[],
  from: string,
  target: string,
  place: PinnedCircleDropPlace,
): string[] {
  if (from === target || !ids.includes(from) || !ids.includes(target)) return [...ids];
  const next = ids.filter((id) => id !== from);
  next.splice(next.indexOf(target) + (place === "after" ? 1 : 0), 0, from);
  return next;
}

export function reorderPinnedCircles(
  saved: readonly string[],
  shown: readonly string[],
  from: string,
  target: string,
  place: PinnedCircleDropPlace,
): string[] | null {
  if (from === target || !shown.includes(from) || !shown.includes(target)) return null;
  const merged = [...new Set([...saved, ...shown])];
  const next = placePinnedCircle(merged, from, target, place);
  return next.every((id, index) => id === merged[index]) ? null : next;
}

export function pinnedCircleDropPlace(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  rtl = false,
): { place: PinnedCircleDropPlace; axis: "x" | "y" } {
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const before = rtl ? dx > 0 : dx < 0;
    return { place: before ? "before" : "after", axis: "x" };
  }
  return { place: dy < 0 ? "before" : "after", axis: "y" };
}

export function rankPinnedCircles<T extends { id: string }>(bots: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...bots];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...bots].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

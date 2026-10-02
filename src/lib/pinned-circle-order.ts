/** Separate from section and folder drags so a circle drop cannot reorder those. */
export const PINNED_CIRCLE_DRAG_TYPE = "application/x-openmausbot-pinned-circle";

/** A shorter move is a click that opens the bot, not a reorder. */
export const PINNED_CIRCLE_DRAG_THRESHOLD_PX = 4;

export type PinnedCircleDropPlace = "before" | "after";

function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function samePinnedCircleOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function samePinnedCircleSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

/**
 * Circle order is this array, not the row the grid happens to paint.
 * An empty save keeps today's order. Ids that are no longer pinned drop out.
 * Pins missing from the save append, so a new pin does not take an old slot.
 */
export function orderedPinnedCircles(pinnedIds: readonly string[], savedOrder: readonly string[]): string[] {
  const pinned = unique(pinnedIds);
  const pinnedSet = new Set(pinned);
  const kept = unique(savedOrder).filter((id) => pinnedSet.has(id));
  if (kept.length === 0) return pinned;
  const seen = new Set(kept);
  for (const id of pinned) {
    if (!seen.has(id)) kept.push(id);
  }
  return kept;
}

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

export function movePinnedCircle(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = ids[index + direction];
  return index < 0 || !target ? [...ids] : placePinnedCircle(ids, id, target, direction < 0 ? "before" : "after");
}

export function draggedPinnedCircle(raw: string, ids: readonly string[]): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    const botId = value && typeof value === "object" && "botId" in value ? value.botId : null;
    return typeof botId === "string" && ids.includes(botId) ? botId : null;
  } catch {
    return null;
  }
}

export function pinnedCircleDragPastThreshold(
  dx: number,
  dy: number,
  threshold = PINNED_CIRCLE_DRAG_THRESHOLD_PX,
): boolean {
  return dx * dx + dy * dy >= threshold * threshold;
}

/** Rename fields own the pointer. A selection inside the circle is a text drag, not a reorder. */
export function pinnedCircleDragBlocked(inRenameField: boolean, selectionInsideCircle: boolean): boolean {
  return inRenameField || selectionInsideCircle;
}

/** Which side of the circle the pointer is on. Reading order, not which row the grid wrapped. */
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
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...bots].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

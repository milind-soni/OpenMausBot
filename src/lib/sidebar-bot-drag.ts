import type { SectionDropPlace } from "./sidebar-layout";

/** Hold long enough that a click still opens the bot. */
export const BOT_LONG_PRESS_MS = 450;
/** Finger jitter / a scroll cancels the pending lift. */
export const BOT_LONG_PRESS_MOVE_PX = 10;

export type BotRowBox = { id: string; top: number; height: number };

export type BotLift = {
  id: string;
  sectionId: string;
  width: number;
  height: number;
  grabOffsetX: number;
  grabOffsetY: number;
  x: number;
  y: number;
  pointerId: number;
};

export function botPointerMatches(sessionId: number, eventId: number): boolean {
  return sessionId === eventId;
}

export function botLongPressShouldCancel(
  originX: number,
  originY: number,
  x: number,
  y: number,
  threshold = BOT_LONG_PRESS_MOVE_PX,
): boolean {
  const dx = x - originX;
  const dy = y - originY;
  return dx * dx + dy * dy > threshold * threshold;
}

/** Before lift, the list can still pan. After lift, consume touchmove so
 * Chromium does not claim the gesture as a scroll and fire pointercancel. */
export function botLiftNeedsTouchMoveGuard(lifted: boolean): boolean {
  return lifted;
}

/** Non-passive window listener used only after the row has lifted. */
export function bindLiftedTouchMoveGuard(target: EventTarget): () => void {
  const onTouchMove = (event: Event) => {
    event.preventDefault();
  };
  target.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  return () => {
    target.removeEventListener("touchmove", onTouchMove, { capture: true });
  };
}

/** A drop with no other row (empty space / cancelled pointer) does not persist. */
export function botDropCommits(over: { id: string } | null | undefined): boolean {
  return Boolean(over);
}

export type BotClickLatch = { suppressed: boolean };

/** Next pointerdown on the row always starts a fresh click. */
export function clearBotClickLatch(latch: BotClickLatch): void {
  latch.suppressed = false;
}

export function armBotClickLatch(latch: BotClickLatch, wasLifted: boolean): void {
  if (wasLifted) latch.suppressed = true;
}

/** True when this click is the leftover from a finished drag and should not select. */
export function consumeBotClickLatch(latch: BotClickLatch): boolean {
  if (!latch.suppressed) return false;
  latch.suppressed = false;
  return true;
}

export function botDropPlace(clientY: number, top: number, height: number): SectionDropPlace {
  return clientY < top + height / 2 ? "before" : "after";
}

export function botFloatPosition(
  pointerX: number,
  pointerY: number,
  grabOffsetX: number,
  grabOffsetY: number,
): { left: number; top: number } {
  return { left: pointerX - grabOffsetX, top: pointerY - grabOffsetY };
}

/** Nearest other row, split before/after at its midline. */
export function botDropTarget(
  clientY: number,
  rows: BotRowBox[],
  draggingId: string,
): { id: string; place: SectionDropPlace } | null {
  const others = rows.filter((row) => row.id !== draggingId && row.height > 0);
  if (others.length === 0) return null;
  let best = others[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const row of others) {
    const mid = row.top + row.height / 2;
    const dist = Math.abs(clientY - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = row;
    }
  }
  return { id: best.id, place: botDropPlace(clientY, best.top, best.height) };
}

export function readBotRowBoxes(sectionId: string, root?: ParentNode | null): BotRowBox[] {
  const scope = root ?? (typeof document === "undefined" ? null : document);
  if (!scope) return [];
  const nodes = scope.querySelectorAll("[data-sidebar-bot-row]");
  const boxes: BotRowBox[] = [];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.getAttribute("data-sidebar-bot-section") !== sectionId) continue;
    if (node.dataset.sidebarBotFloat === "true") continue;
    const id = node.getAttribute("data-sidebar-bot-row");
    if (!id) continue;
    const rect = node.getBoundingClientRect();
    boxes.push({ id, top: rect.top, height: rect.height });
  }
  return boxes;
}

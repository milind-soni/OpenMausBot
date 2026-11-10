import { useEffect, useRef, useState, type RefObject } from "react";

const REPLY_DISTANCE = 64;
const MAX_DISTANCE = 80;
const INTERACTIVE = "a, button, input, textarea, select, summary, label, pre, table, audio, video, iframe, canvas, [role=button], [role=slider], [contenteditable]:not([contenteditable=false])";

function ownsHorizontalScroll(target: Element, row: HTMLElement): boolean {
  for (let node: Element | null = target; node && node !== row; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

export function useMessageSwipeReply(rowRef: RefObject<HTMLElement | null>, onReply: (() => void) | undefined, longPressMs: number) {
  const reply = useRef(onReply);
  const enabled = Boolean(onReply);
  const [drag, setDrag] = useState<{ row: HTMLElement | null; offset: number }>({ row: null, offset: 0 });
  useEffect(() => { reply.current = onReply; }, [onReply]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || !enabled) { setDrag({ row: null, offset: 0 }); return; }
    const original = { translate: row.style.translate, transition: row.style.transition, position: row.style.position, willChange: row.style.willChange };
    if (!getComputedStyle(row).position || getComputedStyle(row).position === "static") row.style.position = "relative";
    let gesture: { id: number; x: number; y: number; at: number; claimed: boolean } | null = null;
    const selected = () => Boolean(window.getSelection()?.toString());
    const show = (offset: number, moving: boolean) => {
      row.style.transition = moving || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : "translate 180ms ease-out";
      row.style.translate = `${offset}px`;
      row.style.willChange = moving ? "translate" : original.willChange;
      setDrag({ row, offset });
    };
    const cancel = () => {
      if (gesture?.claimed) show(0, false);
      gesture = null;
    };
    const start = (event: TouchEvent) => {
      cancel();
      const target = event.target;
      const point = event.touches[0];
      if (event.touches.length !== 1 || !point || !(target instanceof Element) || selected() || target.closest(INTERACTIVE) || ownsHorizontalScroll(target, row)) return;
      gesture = { id: point.identifier, x: point.clientX, y: point.clientY, at: Date.now(), claimed: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const point = Array.from(event.touches).find(touch => touch.identifier === gesture?.id);
      if (event.touches.length !== 1 || !point || !event.cancelable || selected()) return cancel();
      const dx = point.clientX - gesture.x, dy = point.clientY - gesture.y;
      if (!gesture.claimed) {
        if (Date.now() - gesture.at >= longPressMs || dx < -10 || Math.abs(dy) > 10 && dx <= Math.abs(dy) * 1.5) return cancel();
        if (dx <= 10 || dx <= Math.abs(dy) * 1.5) return;
        gesture.claimed = true;
      }
      event.preventDefault();
      show(Math.max(0, Math.min(MAX_DISTANCE, dx)), true);
    };
    const end = (event: TouchEvent) => {
      const ended = gesture;
      const point = Array.from(event.changedTouches).find(touch => touch.identifier === ended?.id);
      if (!ended?.claimed || !point || event.touches.length || selected()) return cancel();
      const dx = point.clientX - ended.x, dy = point.clientY - ended.y;
      if (event.cancelable) event.preventDefault();
      cancel();
      if (dx >= REPLY_DISTANCE && dx > Math.abs(dy) * 1.5) reply.current?.();
    };
    row.addEventListener("touchstart", start, { passive: true });
    row.addEventListener("touchmove", move, { passive: false });
    row.addEventListener("touchend", end, { passive: false });
    row.addEventListener("touchcancel", cancel);
    return () => {
      row.removeEventListener("touchstart", start);
      row.removeEventListener("touchmove", move);
      row.removeEventListener("touchend", end);
      row.removeEventListener("touchcancel", cancel);
      Object.assign(row.style, original);
    };
  }, [rowRef, enabled, longPressMs]);

  return { ...drag, progress: Math.min(1, drag.offset / REPLY_DISTANCE) };
}

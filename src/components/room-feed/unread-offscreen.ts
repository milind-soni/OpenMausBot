import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

export type Band = { top: number; bottom: number };
export type HiddenMark = { dir: "above" | "below"; index: number };

/** Which way the nearest unread or waiting row that is wholly out of sight lies, and which row it is; null when every
 * marked row can be seen. The feed never moves on its own for one: the jump button says where it is. */
export function hiddenMark(view: Band, rows: readonly Band[]): HiddenMark | null {
  let best: HiddenMark | null = null;
  let bestGap = Infinity;
  rows.forEach((row, index) => {
    const above = row.bottom <= view.top, below = row.top >= view.bottom;
    if (!above && !below) return;
    const gap = above ? view.top - row.bottom : row.top - view.bottom;
    if (gap < bestGap) { best = { dir: above ? "above" : "below", index }; bestGap = gap; }
  });
  return best;
}

const MARKED = "li[data-feed-thread]:has([data-feed-mark])";

/** The feed's nearest hidden marked row, kept up to date as it scrolls, resizes and changes; `jump` brings it into
 * view. The band under the room's header (its glass bar) and the one behind the composer count as out of sight. */
export function useHiddenMark(scrollRef: RefObject<HTMLElement | null>, { changed, bottomInset, beforeJump }: {
  changed: unknown; bottomInset: number; beforeJump: () => void;
}) {
  const [dir, setDir] = useState<HiddenMark["dir"] | null>(null);
  const find = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof scroller.querySelectorAll !== "function") return null;
    const box = scroller.getBoundingClientRect();
    const frame = scroller.closest<HTMLElement>("[data-glass-frame]");
    const header = frame ? Number.parseFloat(getComputedStyle(frame).getPropertyValue("--glass-top")) || 0 : 0;
    const rows = [...scroller.querySelectorAll<HTMLElement>(MARKED)];
    const hit = hiddenMark({ top: box.top + header, bottom: box.bottom - bottomInset }, rows.map((row) => row.getBoundingClientRect()));
    return hit ? { dir: hit.dir, row: rows[hit.index]! } : null;
  }, [scrollRef, bottomInset]);
  const measure = useCallback(() => setDir(find()?.dir ?? null), [find]);
  useLayoutEffect(() => {
    measure();
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(measure);
    sizes.observe(scroller);
    if (scroller.firstElementChild) sizes.observe(scroller.firstElementChild);
    return () => sizes.disconnect();
  }, [measure, changed, scrollRef]);
  const jump = useCallback(() => {
    const hit = find();
    if (!hit) return;
    beforeJump();
    hit.row.scrollIntoView({ block: "center" });
    measure();
  }, [find, measure, beforeJump]);
  return { dir, measure, jump };
}

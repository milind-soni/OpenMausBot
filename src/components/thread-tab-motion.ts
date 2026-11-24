import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { reducedMotion } from "./MenuMotion";

const TAB_MS = 200;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const NONE: ReadonlySet<string> = new Set();

type MotionTab = { threadId: string; draft: boolean };
export type ShownTab<T> = T & { leaving?: true };

/** Puts tabs that just went back at the place they left, for as long as they take to fold away. */
export function withLeaving<T extends MotionTab>(tabs: readonly T[], leaving: readonly { tab: T; index: number }[]): ShownTab<T>[] {
  const shown: ShownTab<T>[] = [...tabs];
  for (const { tab, index } of [...leaving].sort((a, b) => a.index - b.index)) {
    if (!shown.some((other) => other.threadId === tab.threadId)) shown.splice(Math.min(index, shown.length), 0, { ...tab, leaving: true });
  }
  return shown;
}

/**
 * The strip's motion: a new tab widens into its place, a closed one narrows away, and tabs that change places glide
 * there. The blank New thread tab turning into its thread is one tab, so nothing moves.
 */
export function useTabMotion<T extends MotionTab>(tabs: readonly T[], scroller: RefObject<HTMLElement | null>) {
  const ids = tabs.map((tab) => tab.threadId).join("\n");
  const previous = useRef(tabs);
  const [entering, setEntering] = useState(NONE);
  const [leaving, setLeaving] = useState<{ tab: T; index: number }[]>([]);
  const timers = useRef<number[]>([]);
  const later = (run: () => void) => { timers.current.push(window.setTimeout(run, TAB_MS)); };
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  useLayoutEffect(() => {
    const was = previous.current;
    const before = new Set(was.map((tab) => tab.threadId)), now = new Set(tabs.map((tab) => tab.threadId));
    const added = tabs.filter((tab) => !before.has(tab.threadId));
    const gone = was.flatMap((tab, index) => (now.has(tab.threadId) ? [] : [{ tab, index }]));
    const madeFromDraft = added.length === 1 && gone.length === 1 && gone[0].tab.draft;
    if (reducedMotion() || madeFromDraft) return;
    if (added.length) {
      const fresh = new Set(added.map((tab) => tab.threadId));
      setEntering(fresh);
      later(() => setEntering((current) => (current === fresh ? NONE : current)));
    }
    if (gone.length) {
      setLeaving((current) => [...current, ...gone]);
      later(() => setLeaving((current) => current.filter((entry) => !gone.includes(entry))));
    }
  }, [ids]);
  useLayoutEffect(() => { previous.current = tabs; });

  const places = useRef<{ order: string; at: Map<string, number> }>({ order: "", at: new Map() });
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const at = new Map<string, number>();
    const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-tab-id]:not([data-leaving])"));
    for (const element of elements) at.set(element.dataset.tabId ?? "", element.offsetLeft);
    const kept = (order: string, keep: Map<string, number>) => order.split("\n").filter((id) => keep.has(id)).join("\n");
    const moved = places.current.order && kept(places.current.order, at) !== kept(ids, places.current.at);
    if (moved && !reducedMotion()) {
      for (const element of elements) {
        const from = places.current.at.get(element.dataset.tabId ?? ""), to = at.get(element.dataset.tabId ?? "");
        if (from === undefined || to === undefined || from === to || typeof element.animate !== "function") continue;
        element.animate([{ transform: `translateX(${from - to}px)` }, { transform: "none" }], { duration: TAB_MS, easing: EASE });
      }
    }
    places.current = { order: ids, at };
  }, [ids]);

  return { shown: withLeaving(tabs, leaving), entering };
}

export type IndicatorBox = { left: number; width: number };

/**
 * Where the open tab's ground sits under the open tab, kept in step as tabs resize or move. It only glides once it has
 * been placed, so the strip's first paint has it in place.
 */
export function useSlidingIndicator(scroller: RefObject<HTMLElement | null>, activeId: string): { box: IndicatorBox | null; glide: boolean } {
  const [box, setBox] = useState<IndicatorBox | null>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const place = () => {
      const tab = root.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]:not([data-leaving])`);
      const next = tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : null;
      setBox((current) => (current?.left === next?.left && current?.width === next?.width ? current : next));
    };
    place();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(place);
    for (const tab of root.querySelectorAll("[data-tab-id]")) observer.observe(tab);
    return () => observer.disconnect();
  });
  useEffect(() => { if (box) placed.current = true; }, [box]);
  return { box, glide: placed.current && !reducedMotion() };
}

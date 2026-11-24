import { useEffect, useReducer, useRef, useState } from "react";
import { useStableCallback } from "./use-stable-callback";

/** Each entry the hook adds keeps its place above the start in its history state, so a press can tell Back from Forward. */
const ENTRY = "ombPhoneBack";

function entryOf(state: unknown): number | undefined {
  const entry = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[ENTRY] : undefined;
  return typeof entry === "number" ? entry : undefined;
}

function withEntry(entry: number): Record<string, unknown> {
  const state: unknown = window.history.state;
  return { ...(typeof state === "object" && state !== null ? state : {}), [ENTRY]: entry };
}

/**
 * Lets a phone's back button (Android's, or a phone browser's) step back inside the app instead of leaving it. While
 * `enabled`, the page keeps one history entry above where it started for each of the `steps` the person can go back,
 * and a back press calls `back` once. A step closed in the app takes its entry away again, so back never does nothing;
 * a press that leaves the steps as they were gets its entry back. Forward onto an entry the app has already stepped back
 * from is not a step: the app stays where it is and the entry is taken away again.
 */
export function usePhoneBack(enabled: boolean, steps: number, back: () => void): void {
  // A reload keeps the entries added before it, with the page on one of them; count from that one.
  const [start] = useState(() => entryOf(window.history.state) ?? 0);
  const added = useRef(start);
  const ownPops = useRef(0);
  const stepBack = useStableCallback(back);
  const [, redraw] = useReducer((draws: number) => draws + 1, 0);
  useEffect(() => {
    const wanted = enabled ? steps : 0;
    if (wanted > added.current) {
      // While the app's own step back is still on its way, the current entry is the one it leaves, not the start.
      if (added.current === 0 && ownPops.current === 0) window.history.replaceState(withEntry(0), "", window.location.href);
      for (let entry = added.current + 1; entry <= wanted; entry += 1) window.history.pushState(withEntry(entry), "", window.location.href);
    } else if (wanted < added.current) {
      ownPops.current += 1;
      window.history.go(wanted - added.current);
    }
    added.current = wanted;
  });
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (ownPops.current > 0) {
        ownPops.current -= 1;
        // A step opened again while the app's own step back was on its way may have been added above the entry it left;
        // count from the entry the page landed on so the effect adds back what is missing.
        const landed = entryOf(event.state);
        if (ownPops.current === 0 && landed !== undefined && landed < added.current) {
          added.current = landed;
          redraw();
        }
        return;
      }
      if (added.current === 0) return;
      const entry = entryOf(event.state);
      if (entry !== undefined && entry >= added.current) {
        added.current = entry;
        redraw();
        return;
      }
      // An entry whose state the app replaced since lost its place; count it as one step back, as before.
      added.current = entry ?? added.current - 1;
      stepBack();
      redraw();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [stepBack]);
}

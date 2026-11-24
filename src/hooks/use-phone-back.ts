import { useEffect, useReducer, useRef } from "react";
import { useStableCallback } from "./use-stable-callback";

/**
 * Lets a phone's back button (Android's, or a phone browser's) step back inside the app instead of leaving it. While
 * `enabled`, the page keeps one history entry above where it started for each of the `steps` the person can go back,
 * and a back press calls `back` once. A step closed in the app takes its entry away again, so back never does nothing;
 * a press that leaves the steps as they were gets its entry back.
 */
export function usePhoneBack(enabled: boolean, steps: number, back: () => void): void {
  const added = useRef(0);
  const ownPops = useRef(0);
  const stepBack = useStableCallback(back);
  const [, redraw] = useReducer((draws: number) => draws + 1, 0);
  useEffect(() => {
    const wanted = enabled ? steps : 0;
    if (wanted > added.current) {
      for (let entry = added.current; entry < wanted; entry += 1) window.history.pushState(window.history.state, "", window.location.href);
    } else if (wanted < added.current) {
      ownPops.current += 1;
      window.history.go(wanted - added.current);
    }
    added.current = wanted;
  });
  useEffect(() => {
    const onPop = () => {
      if (ownPops.current > 0) {
        ownPops.current -= 1;
        return;
      }
      if (added.current === 0) return;
      added.current -= 1;
      stepBack();
      redraw();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [stepBack]);
}

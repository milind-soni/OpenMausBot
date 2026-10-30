import { useEffect, useState } from "react";
import type { ChromeRailState } from "../../electron/chrome-rail.mjs";

let current: ChromeRailState | null = null;
let started = false;
const listeners = new Set<(state: ChromeRailState | null) => void>();

const bridge = () => (typeof window === "undefined" ? undefined : window.ogb?.rail);

function publish(next: ChromeRailState | null) {
  current = next;
  for (const listener of listeners) listener(current);
}

function start() {
  const rail = bridge();
  if (started || !rail?.state) return;
  started = true;
  rail.onState?.(publish);
  void rail.state().then(publish, () => publish(null));
}

/** The window's own rail of places, as the page beside it knows it: null in a browser, on an older app or on a page that
 * isn't beside it. Asking offers this page's button that hides and shows it. */
export function useChromeRail(): ChromeRailState | null {
  const [state, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    start();
    setState(current);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

/** From the person's click: main hides or shows the rail, and this desktop keeps the choice. */
export function setChromeRailHidden(hidden: boolean): void {
  const rail = bridge(), before = current;
  if (!rail?.setHidden || !before) return;
  publish({ ...before, hidden });
  void rail.setHidden(hidden).then(publish, () => publish(before));
}

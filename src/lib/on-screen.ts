import { useEffect, useState, type RefObject } from "react";

// One observer per margin, each with its own elements, so an element can be watched at two margins at once.
const observers = new Map<number, { observer: IntersectionObserver; watchers: Map<Element, (onScreen: boolean) => void> }>();

function watch(element: Element, onChange: (onScreen: boolean) => void, margin = 0): () => void {
  let watching = observers.get(margin);
  if (!watching) {
    const watchers = new Map<Element, (onScreen: boolean) => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
      },
      // scrollMargin carries the margin into scrolling boxes (like the chat's), not only the window.
      margin ? ({ rootMargin: `${margin}px 0px`, scrollMargin: `${margin}px 0px` } as IntersectionObserverInit) : undefined,
    );
    watching = { observer, watchers };
    observers.set(margin, watching);
  }
  const { observer, watchers } = watching;
  watchers.set(element, onChange);
  observer.observe(element);
  return () => {
    watchers.delete(element);
    observer.unobserve(element);
  };
}

/** Whether the element is on screen: false until the browser says so, true where it cannot tell. */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return setOnScreen(true);
    return watch(element, setOnScreen);
  }, [ref]);
  return onScreen;
}

/** How far from the screen, in pixels, an element counts as near it. */
const NEAR_SCREEN_MARGIN = 800;

/** Whether the element has come within NEAR_SCREEN_MARGIN of the screen yet. It stays true once it has, and is true at
 * once where the browser cannot tell. */
export function useNearScreen(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    return watch(element, (nearNow) => nearNow && setNear(true), NEAR_SCREEN_MARGIN);
  }, [ref, near]);
  return near;
}

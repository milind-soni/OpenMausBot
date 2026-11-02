import { useEffect, useState, type RefObject } from "react";

const watchers = new Map<Element, (onScreen: boolean) => void>();
let observer: IntersectionObserver | undefined;

function watch(element: Element, onChange: (onScreen: boolean) => void): () => void {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
  });
  watchers.set(element, onChange);
  observer.observe(element);
  return () => {
    watchers.delete(element);
    observer?.unobserve(element);
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

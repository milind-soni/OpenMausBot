import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { reducedMotion } from "@/lib/onboarding";

function subscribeReducedMotion(changed: () => void) {
  const query = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)");
  query?.addEventListener?.("change", changed);
  const root = globalThis.document?.documentElement;
  const hook = root && typeof MutationObserver === "function" ? new MutationObserver(changed) : null;
  if (root) hook?.observe(root, { attributes: true, attributeFilter: ["data-reduced-motion"] });
  return () => {
    query?.removeEventListener?.("change", changed);
    hook?.disconnect();
  };
}

/** Whether a decoration may move: never under reduced motion (the system setting or the dev hook), and only while on screen. */
export function useLiveMotion(target: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const node = target.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const watch = new IntersectionObserver(entries => setInView(entries.at(-1)?.isIntersecting ?? true));
    watch.observe(node);
    return () => watch.disconnect();
  }, [target]);
  const live = !useSyncExternalStore(subscribeReducedMotion, reducedMotion, reducedMotion);
  return live && inView;
}

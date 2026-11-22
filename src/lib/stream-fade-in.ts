// A streaming reply's new blocks, list items and table rows fade in as they arrive instead of appearing at once. The
// fade lives on the elements' animations, never in the markup, so the streamed page stays the page the saved message
// draws.
import { useLayoutEffect, useRef, type RefObject } from "react";

/** What fades in: the reply's top-level blocks (a list by its items), list items and table rows. */
const STREAM_FADE_TARGETS = ":scope > :not(ul, ol), li, tr";
const FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const FADE_TIMING: KeyframeAnimationOptions = { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Footnotes sit at the reply's end and a long table draws only the rows in view, so neither keeps page order. */
const keepsPageOrder = (target: Element) => !target.closest("[data-footnotes], [data-virtual]");

/**
 * Fades in what a streaming reply drew since `content` last changed: the whole reply on its first draw, then each new
 * target. Targets are counted in page order, so one already shown does not play again when a finished block is drawn
 * anew.
 */
export function useStreamFadeIn(streaming: boolean, content: unknown): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!streaming || !host) {
      shown.current = null;
      return;
    }
    const targets = [...host.querySelectorAll(STREAM_FADE_TARGETS)].filter(keepsPageOrder);
    const fresh = shown.current === null ? [host] : targets.slice(shown.current);
    if (!reducedMotion()) for (const target of fresh) target.animate?.(FADE, FADE_TIMING);
    shown.current = targets.length;
  }, [streaming, content]);
  return ref;
}

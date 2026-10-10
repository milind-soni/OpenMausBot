import { useLayoutEffect, useState, type RefObject } from "react";

/** Same as Tailwind `gap-3` on the transcript stack. The last bubble sits
 * this far above the composer when the pane is scrolled to the end. */
export const TRANSCRIPT_GAP = "0.75rem";

/** Empty one-line pill (~44px) plus the dock's `pb-3`. ResizeObserver
 * replaces this as soon as the real composer mounts. */
const FALLBACK_COMPOSER_PX = 64;

export function transcriptEndPad(composerHeightPx: number): string {
  const height = Number.isFinite(composerHeightPx)
    ? Math.max(0, Math.ceil(composerHeightPx))
    : FALLBACK_COMPOSER_PX;
  return `calc(${height}px + ${TRANSCRIPT_GAP})`;
}

/** Pad the transcript so rest-at-bottom leaves one inter-bubble gap of
 * black above the docked composer. Tracks composer resizes (multiline,
 * queued chip, approval takeover). */
export function useComposerDockPad(ref: RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setHeight(el.getBoundingClientRect().height);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  const measured = height > 0 ? height : FALLBACK_COMPOSER_PX;
  return { pad: transcriptEndPad(measured), height: measured };
}

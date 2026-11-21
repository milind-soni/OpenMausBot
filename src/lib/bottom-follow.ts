import { useLayoutEffect, type RefObject } from "react";

export const BOTTOM_FOLLOW_THRESHOLD = 4;

interface BottomFollowScroller {
  scrollHeight: number;
  scrollTo(options?: ScrollToOptions): void;
}

export function followBottomGrowth(scroller: BottomFollowScroller, following: boolean, smooth = false): boolean {
  if (!following) return false;
  scroller.scrollTo(smooth ? { top: scroller.scrollHeight, behavior: "smooth" } : { top: scroller.scrollHeight });
  return true;
}

/** Calls `onResize` whenever the transcript's content changes size: a reply growing inside its last row included. */
export function useBottomFollowResize(
  scrollRef: RefObject<HTMLElement | null>,
  transcriptRef: RefObject<HTMLElement | null>,
  observeKey: string | null,
  onResize: () => void,
): void {
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!scroller || !transcript || observeKey === null) return;

    const observer = new ResizeObserver(onResize);
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [observeKey, onResize, scrollRef, transcriptRef]);
}

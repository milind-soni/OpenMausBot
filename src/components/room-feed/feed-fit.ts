import { useLayoutEffect, useRef, useState } from "react";
import { closeInbox } from "@/state/inbox";
import { PANEL_MIN_WIDTH } from "../computer-panel-resize";

/** The narrowest a room's feed gets beside the thread open next to it. */
export const FEED_MIN_WIDTH = 420;

/** Whether a room's feed and the thread open beside it both fit in the width they share. */
export function feedThreadFits(available: number): boolean {
  return available >= FEED_MIN_WIDTH + PANEL_MIN_WIDTH;
}

/** What a thread opened from a room's feed does in the width it has: beside the feed when both fit; otherwise it takes
 * the feed's place, with a way back to the feed. When the thread was opened with the Inbox already open and the Inbox
 * is what leaves too little room, the Inbox closes instead; an Inbox opened later, beside the thread, stays. */
export function feedThreadPlace(available: number, { inboxBeforeThread, inboxWidth }: { inboxBeforeThread: boolean; inboxWidth: number }): "beside" | "full" | "close-inbox" {
  if (feedThreadFits(available)) return "beside";
  return inboxBeforeThread && inboxWidth > 0 && feedThreadFits(available + inboxWidth) ? "close-inbox" : "full";
}

const width = (element: Element) => element.getBoundingClientRect().width;
/** Widths move while the sidebar folds and the panel slides in; the Inbox is only closed once they have held still. */
const SETTLE_MS = 300;

/** True while the room thread open beside a feed (`threadId`) has to take the feed's place. It measures the elements
 * marked `data-feed-area` (the feed's main area and the thread's panel, or the thread alone in the feed's place),
 * whose widths add up to the same row space either way, so the choice never flips back and forth. */
export function useFeedThreadFull(threadId: string | null): boolean {
  const [full, setFull] = useState(false);
  const opened = useRef<string | null>(null);
  // The Inbox was open when this thread opened, and hasn't been closed for it yet. Widths settle over the sidebar's and
  // the panel's own motion, so this holds until then rather than for the first measurement only.
  const inboxBeforeThread = useRef(false);
  useLayoutEffect(() => {
    if (!threadId) { opened.current = null; setFull(false); return; }
    if (opened.current !== threadId) inboxBeforeThread.current = Boolean(document.querySelector('[data-inbox-panel="side"]'));
    opened.current = threadId;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const read = (settled = false) => {
      clearTimeout(settle);
      const parts = [...document.querySelectorAll("[data-feed-area]")];
      if (parts.length === 0) return;
      const inbox = document.querySelector('[data-inbox-panel="side"]');
      const place = feedThreadPlace(parts.reduce((sum, part) => sum + width(part), 0), { inboxBeforeThread: inboxBeforeThread.current, inboxWidth: inbox ? width(inbox) : 0 });
      if (place === "close-inbox" && settled) { inboxBeforeThread.current = false; closeInbox(); return; }
      if (place === "close-inbox") settle = setTimeout(() => read(true), SETTLE_MS);
      setFull(place !== "beside");
    };
    const reread = () => read();
    read();
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reread);
    for (const part of document.querySelectorAll("[data-feed-area]")) sizes?.observe(part);
    window.addEventListener("resize", reread);
    return () => { clearTimeout(settle); sizes?.disconnect(); window.removeEventListener("resize", reread); };
  }, [threadId, full]);
  return Boolean(threadId) && full;
}

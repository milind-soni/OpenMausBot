import { useEffect } from "react";
import type { AppState } from "@/state/store";

/** Scroll the row of a thread the person asked to open into view, once the
 * switch has landed and that thread is the one on screen. `block: nearest`
 * keeps an already-visible row still. */
export function useRevealedThreadRow(reveal: AppState["revealThread"], currentThreadId: string | null) {
  useEffect(() => {
    if (!reveal || reveal.threadId !== currentThreadId) return;
    const findRow = () => document.querySelector<HTMLElement>(`[data-sidebar-thread-row="${CSS.escape(reveal.threadId)}"]`);
    const row = findRow();
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      return;
    }
    // A target inside a collapsed project expands in a later commit, so the
    // synchronous query can miss its row; look again on the next frame.
    const frame = requestAnimationFrame(() => {
      findRow()?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, currentThreadId]);
}


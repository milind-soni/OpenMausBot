import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { readInboxRow, unreadInboxRow } from "@/state/inbox";

/** How long an opened line stays on screen, with the window focused, before it counts as read. */
export const READ_AFTER_MS = 2_000;

const looking = () => document.visibilityState !== "hidden" && document.hasFocus();

/** Reads `row` once it has been on screen for READ_AFTER_MS with the window focused; leaving the window pauses it. */
function useReadAfterLooking(row: InboxRow | undefined, onRead: (row: InboxRow) => void): void {
  const latest = useRef({ row, onRead });
  latest.current = { row, onRead };
  const id = row?.unread ? row.id : null;
  useEffect(() => {
    if (!id) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { clearTimeout(timer); timer = undefined; };
    const start = () => {
      stop();
      if (!looking()) return;
      timer = setTimeout(() => {
        const { row: now, onRead: read } = latest.current;
        if (now?.id === id && now.unread) read(now);
      }, READ_AFTER_MS);
    };
    start();
    window.addEventListener("focus", start);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", start);
    };
  }, [id]);
}

/** Calls `onRead` when `row` turns read while it stays open, by anything but an answer: opening its conversation reads
 * it as well. */
function useReadWithoutAnswer(row: InboxRow | undefined, onRead: (id: string) => void): void {
  const was = useRef<Pick<InboxRow, "id" | "unread" | "tab"> | null>(null);
  const latest = useRef(onRead);
  latest.current = onRead;
  const id = row?.id, unread = row?.unread, tab = row?.tab, kind = row?.kind;
  useEffect(() => {
    const before = was.current;
    was.current = id && tab ? { id, unread: Boolean(unread), tab } : null;
    if (!id || before?.id !== id || !before.unread || unread) return;
    const answered = kind === "ask" || (tab === "done" && before.tab !== "done" && kind !== "result");
    if (!answered) latest.current(id);
  }, [id, unread, tab, kind]);
}

/** The line the person opened last. It keeps its place in the list, read or settled, until they pick another, so no row
 * moves under the pointer; it is read after a moment on screen, with an Undo for that. */
export function useInboxHold(view: InboxView | null, reading: string | null) {
  const [held, setHeld] = useState<string | null>(reading);
  const [marked, setMarked] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const pick = useCallback((row: Pick<InboxRow, "id">) => {
    setHeld(row.id);
    setMarked(null);
    setKept(null);
  }, []);
  useEffect(() => { if (reading) pick({ id: reading }); }, [reading, pick]);
  const row = held && held !== kept ? view?.rows.find((one) => one.id === held) : undefined;
  useReadAfterLooking(row, (seen) => { readInboxRow(seen); setMarked(seen.id); });
  useReadWithoutAnswer(row, setMarked);
  const undo = useCallback(() => {
    if (!marked) return;
    unreadInboxRow({ id: marked });
    setKept(marked);
    setMarked(null);
  }, [marked]);
  return { held, marked, pick, undo };
}

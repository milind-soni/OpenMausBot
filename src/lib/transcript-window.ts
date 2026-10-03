/** Long computer-use threads carry hundreds of rows (inline screenshots
 * included); mounting all of them makes the DOM heavy even though the memoized
 * list bails out of re-renders. Only the last `TRANSCRIPT_WINDOW_SIZE`
 * messages mount by default; a pill expands by the same step. */
export const TRANSCRIPT_WINDOW_SIZE = 120;

export interface TranscriptWindow<T> {
  visible: T[];
  /** Messages hidden before the window — the pill's "(X more)" count. */
  hiddenCount: number;
  /** Messages hidden after a finite search-focus window. */
  laterCount: number;
  /** The boundary actually applied after clamping; expand steps from this,
   * not from the stored value, so a clamped window expands predictably. */
  startIndex: number;
  /** Exclusive end boundary, or the current list length for a tail window. */
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

/** Boundary for a fresh window: the last `size` messages. */
export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

/** Boundary for a reader following the bottom: the tail window, but never
 * past the newest message the person sent. A turn can add hundreds of tool
 * steps that draw nothing (Tool calls is off by default); counted against the
 * window, they would push the question out while the person watches it being
 * answered. */
export function followWindowStart(
  messages: readonly { role?: string }[],
  size: number = TRANSCRIPT_WINDOW_SIZE,
): number {
  const tail = tailWindowStart(messages.length, size);
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return Math.min(tail, index);
  }
  return tail;
}

/** One "Show earlier" click: pull the boundary back by another `size`. */
export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

/** A bounded window containing a search target. Keeping this finite avoids
 * mounting an entire old transcript merely to land on one result. */
export function focusWindowRange(
  total: number,
  targetIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): TranscriptWindowRange {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, size);
  const target = Math.max(0, Math.min(targetIndex, Math.max(0, safeTotal - 1)));
  const start = Math.max(0, Math.min(target - Math.floor(safeSize / 2), Math.max(0, safeTotal - safeSize)));
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

/** Resolve a stored boundary against the current list. The boundary is
 * anchored — appends grow the window instead of sliding it, so rows the
 * reader is looking at never drop out from under them. (The viewport hook
 * moves the boundary up to `followWindowStart` while the reader follows the
 * bottom, so only a reader who has scrolled away sees the window grow.)
 * Anchoring means a thread that shrinks (branch switch, edit rewinding the
 * tail) can leave the boundary at or past the new end; that stale boundary
 * falls back to a fresh tail window rather than blanking the transcript. */
export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? messages.length : Math.max(0, Math.min(messages.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start =
    startIndex >= messages.length || invalidFiniteWindow
      ? tailWindowStart(messages.length, size)
      : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? messages.length : Math.max(start, requestedEnd);
  return {
    visible: messages.slice(start, end),
    hiddenCount: start,
    laterCount: messages.length - end,
    startIndex: start,
    endIndex: end,
  };
}

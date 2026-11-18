export const TRANSCRIPT_WINDOW_SIZE = 120;
/** The most rows drawn at once while the reader is away from the end: one step past it unloads rows at the far edge. */
export const TRANSCRIPT_WINDOW_MAX = 2 * TRANSCRIPT_WINDOW_SIZE;

export interface TranscriptWindow<T> {
  visible: T[];
  hiddenCount: number;
  laterCount: number;
  startIndex: number;
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

export function followWindowStart(messages: readonly { role?: string }[], start: number): number {
  const tail = tailWindowStart(messages.length);
  const oldest = Math.max(start, tail - TRANSCRIPT_WINDOW_SIZE);
  for (let index = messages.length - 1; index >= oldest; index--) {
    if (messages[index].role === "user") return Math.min(tail, index);
  }
  return tail;
}

export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

/** A window over a transcript; a null `end` reaches the newest row and grows with it. */
export interface TranscriptWindowBounds {
  start: number;
  end: number | null;
}

/** Holds a window to `TRANSCRIPT_WINDOW_MAX` rows by dropping rows at its bottom; an end at the newest row is null. */
export function capWindowEnd({ start, end }: TranscriptWindowBounds, total: number): TranscriptWindowBounds {
  const last = Math.min(total, end ?? total);
  if (last - start > TRANSCRIPT_WINDOW_MAX) return { start, end: start + TRANSCRIPT_WINDOW_MAX };
  return { start, end: last >= total ? null : last };
}

export function windowEarlier(window: TranscriptWindowBounds, total: number): TranscriptWindowBounds {
  return capWindowEnd({ start: expandWindowStart(window.start), end: window.end }, total);
}

/** One step down: rows below join and, past the cap, rows at the top leave. */
export function windowLater({ start, end }: TranscriptWindowBounds, total: number): TranscriptWindowBounds {
  if (end === null) return { start, end };
  const nextEnd = Math.min(total, end + TRANSCRIPT_WINDOW_SIZE);
  return { start: Math.max(start, nextEnd - TRANSCRIPT_WINDOW_MAX), end: nextEnd >= total ? null : nextEnd };
}

/** The window after `added` older rows were put in front of the transcript: a window at the top shows one step of them. */
export function windowAfterPrepend({ start, end }: TranscriptWindowBounds, added: number, total: number): TranscriptWindowBounds {
  const moved = { start: start === 0 ? Math.max(0, added - TRANSCRIPT_WINDOW_SIZE) : start + added, end: end === null ? null : end + added };
  return capWindowEnd(moved, total);
}

/** The window that puts a remembered row back on screen, drawing at most `TRANSCRIPT_WINDOW_MAX` rows. */
export function restoreWindow(total: number, rowIndex: number, rememberedStart: number | undefined): TranscriptWindowBounds {
  const start = Math.max(0, rowIndex - TRANSCRIPT_WINDOW_SIZE, Math.min(rowIndex, rememberedStart ?? rowIndex, tailWindowStart(total)));
  return capWindowEnd({ start, end: null }, total);
}

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

/** The window's rows, with the newest card that `rests` on put back on top when the window has left it behind: work rests
 * on that card until the person answers it, so its answer and its Not now stay on screen however long the chat grows. */
export function withRestingCard<T>(messages: readonly T[], visible: T[], startIndex: number, rests?: (row: T) => boolean): T[] {
  const index = rests ? messages.findLastIndex(rests) : -1;
  return index >= 0 && index < startIndex ? [messages[index]!, ...visible] : visible;
}

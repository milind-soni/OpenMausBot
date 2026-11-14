export const TRANSCRIPT_WINDOW_SIZE = 120;

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

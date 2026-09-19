// Per-frame stream state lives in its OWN context: token frames update only
// the components that read useStreaming (the chat's streaming tail), while
// every useStore consumer — sidebar, mascots, pickers, the settled transcript
// — keeps its render tree untouched during a stream.
import { createContext, useContext } from "react";

export interface StreamState {
  /** in-flight assistant text per threadId */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
}

export const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };

export const StreamContext = createContext<StreamState>(EMPTY_STREAM);

export type PendingDelta = { text: string; reasoning: string };

/** Paint once per frame, but keep draining when a hidden tab pauses rAF.
 * Flush pending chunks at 64 Ki UTF-16 characters or a 100ms fallback timer.
 * Accumulated output remains intact and unbounded; this is not a memory cap. */
export function createStreamDeltaBuffer(onFlush: (entries: Array<[string, PendingDelta]>) => void) {
  const buffer = new Map<string, PendingDelta>();
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let characters = 0;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    if (!buffer.size) return;
    const entries = [...buffer];
    buffer.clear();
    characters = 0;
    onFlush(entries);
  };
  return {
    push(threadId: string, kind: string, delta: string) {
      if (kind !== "assistant_text" && kind !== "reasoning_text") return;
      const entry = buffer.get(threadId) ?? { text: "", reasoning: "" };
      if (kind === "assistant_text") entry.text += delta;
      else entry.reasoning += delta;
      buffer.set(threadId, entry);
      characters += delta.length;
      if (characters >= 64 * 1024) flush();
      else if (frame === null) {
        frame = requestAnimationFrame(flush);
        timer = setTimeout(flush, 100);
      }
    },
    clear(threadId: string) {
      const entry = buffer.get(threadId);
      if (entry) characters -= entry.text.length + entry.reasoning.length;
      buffer.delete(threadId);
      if (!buffer.size) cancel();
    },
    flush,
    dispose() {
      cancel();
      buffer.clear();
      characters = 0;
    },
  };
}

/** Merge one batched frame of stream deltas into the stream state. Pure:
 * StoreProvider calls this inside setStream's updater so token frames never
 * touch the main tree. */
export function mergeStreamDeltas(prev: StreamState, entries: Array<[string, PendingDelta]>) {
  const streaming = { ...prev.streaming };
  const reasoning = { ...prev.reasoning };
  for (const [threadId, d] of entries) {
    if (d.text) streaming[threadId] = (streaming[threadId] ?? "") + d.text;
    if (d.reasoning) reasoning[threadId] = (reasoning[threadId] ?? "") + d.reasoning;
  }
  return { streaming, reasoning };
}

/** Drop one thread from the stream state — a settled message or a rewind.
 * Pure counterpart of the ghost-tail cleanup in StoreProvider: returning
 * prev unchanged keeps never-streamed consumers from re-rendering. */
export function clearThreadStream(prev: StreamState, threadId: string) {
  if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
  const { [threadId]: _s, ...streaming } = prev.streaming;
  const { [threadId]: _r, ...reasoning } = prev.reasoning;
  return { streaming, reasoning };
}

export function useStreaming() {
  return useContext(StreamContext);
}

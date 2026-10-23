// What each thread's running turn is doing right now, read from the live runtime frames: the engine's own report of a
// tool call (turn.progress), reasoning or reply text streaming, and the turn's end. Held per thread outside the app
// reducer, so a frame re-renders only the chat that shows that thread, and only when what it shows changes.
import { useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../shared/runtime-events";
import type { TurnProgressActivity } from "../../shared/turn-progress";

export type LiveStatus =
  | { activity: TurnProgressActivity; tool?: string; file?: string; bytes?: number; itemId?: string }
  | { activity: "thinking" | "reply"; itemId?: undefined };

export interface TurnLive {
  turnId?: string;
  /** The newest turn this thread showed has completed, failed or stopped. */
  ended: boolean;
  status: LiveStatus | null;
}

const UNKNOWN: TurnLive = { ended: false, status: null };
const MAX_THREADS = 500;
const threads = new Map<string, TurnLive>();
const listeners = new Map<string, Set<() => void>>();

function sameStatus(a: LiveStatus | null, b: LiveStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return ["activity", "tool", "file", "bytes", "itemId"].every((key) => left[key] === right[key]);
}

function put(threadId: string, next: TurnLive): void {
  const current = threads.get(threadId);
  if (current && current.turnId === next.turnId && current.ended === next.ended && sameStatus(current.status, next.status)) return;
  threads.delete(threadId);
  threads.set(threadId, next);
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
  for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
}

/** One live runtime frame. A row in the chat supersedes the status it came from, except the row of the very tool call
 * the status describes: "Writing index.html · 14 KB" outlasts the call's own chip until the call finishes. */
export function noteTurnEvent(event: RuntimeEvent): void {
  const { threadId } = event;
  const current = threads.get(threadId);
  const sameTurn = current && (!event.turnId || event.turnId === current.turnId);
  const turnId = event.turnId ?? current?.turnId;
  const live: TurnLive = sameTurn ? current : { turnId, ended: false, status: null };
  switch (event.type) {
    case "turn.started":
      return put(threadId, { turnId, ended: false, status: null });
    case "turn.completed":
    case "cap.exhausted":
    case "session.exited":
      return put(threadId, { turnId, ended: true, status: null });
    case "turn.progress": {
      const { activity, tool, file, bytes, itemId } = event;
      return put(threadId, { turnId, ended: false, status: { activity, ...(tool ? { tool } : {}), ...(file ? { file } : {}), ...(bytes !== undefined ? { bytes } : {}), ...(itemId ? { itemId } : {}) } });
    }
    case "content.delta":
      return put(threadId, { turnId, ended: false, status: { activity: event.streamKind === "reasoning_text" ? "thinking" : "reply" } });
    case "item.started":
      return put(threadId, { ...live, ended: false, status: live.status?.itemId && live.status.itemId === event.itemId ? live.status : null });
    case "item.completed":
    case "request.opened":
      return put(threadId, { ...live, status: null });
    default:
      if (live !== current) put(threadId, live);
  }
}

export function turnLive(threadId: string | null | undefined): TurnLive {
  return (threadId && threads.get(threadId)) || UNKNOWN;
}

function subscribe(threadId: string | null | undefined, listener: () => void): () => void {
  if (!threadId) return () => {};
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}

export function useTurnLive(threadId: string | null | undefined): TurnLive {
  return useSyncExternalStore(
    (listener) => subscribe(threadId, listener),
    () => turnLive(threadId),
    () => turnLive(threadId),
  );
}

/** Tests only. */
export function resetTurnLive(): void {
  threads.clear();
}

// What each thread's running turn is doing right now, read from the live runtime frames: the engine's own report of a
// tool call (turn.progress), reasoning or reply text streaming, and the turn's end. Held per thread outside the app
// reducer, so a frame re-renders only the chat that shows that thread, and only when what it shows changes.
import { useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { progressKey, type TurnProgressActivity, type TurnProgressFields } from "../../shared/turn-progress";

export type LiveStatus =
  | ({ activity: TurnProgressActivity } & Omit<TurnProgressFields, "type" | "activity">)
  | { activity: "thinking" | "reply" | "summarizing"; itemId?: undefined };

export interface TurnLive {
  turnId?: string;
  /** The newest turn this thread showed has completed, failed or stopped. */
  ended: boolean;
  status: LiveStatus | null;
  /** Tool calls the current turn has started, for the live status line's step count. */
  toolSteps?: number;
  /** A summary started after this turn had ended (the Compact button); its end puts the ended state back. */
  reopened?: true;
}

const UNKNOWN: TurnLive = { ended: false, status: null };
const MAX_THREADS = 500;
const threads = new Map<string, TurnLive>();
const lastFrames = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const toolTurnSeen = new Map<string, Set<string>>();
/** The turn each thread last started. Kept apart from the turn of the last frame, which a late frame of an earlier turn can change. */
const lastStartedTurn = new Map<string, string>();

function toolSeenKey(threadId: string, turnId: string | undefined): string {
  return turnId ? `${threadId}\0${turnId}` : threadId;
}

function bumpToolStep(threadId: string, turnId: string | undefined, itemId: string | undefined, current: number | undefined): number {
  if (!itemId) return current ?? 0;
  const key = toolSeenKey(threadId, turnId);
  let seen = toolTurnSeen.get(key);
  if (!seen) toolTurnSeen.set(key, (seen = new Set()));
  if (seen.has(itemId)) return current ?? 0;
  seen.add(itemId);
  return (current ?? 0) + 1;
}

function clearToolSeen(threadId: string, keepTurnId?: string): void {
  const keep = keepTurnId === undefined ? undefined : toolSeenKey(threadId, keepTurnId);
  for (const key of toolTurnSeen.keys()) {
    if ((key === threadId || key.startsWith(`${threadId}\0`)) && key !== keep) toolTurnSeen.delete(key);
  }
}

function sameStatus(a: LiveStatus | null, b: LiveStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return ("bytes" in a ? a.bytes : undefined) === ("bytes" in b ? b.bytes : undefined) && progressKey(a) === progressKey(b);
}

function put(threadId: string, next: TurnLive): void {
  const current = threads.get(threadId);
  if (current && current.turnId === next.turnId && current.ended === next.ended
    && (current.toolSteps ?? 0) === (next.toolSteps ?? 0) && sameStatus(current.status, next.status)) return;
  threads.delete(threadId);
  threads.set(threadId, next);
  if (threads.size > MAX_THREADS) {
    const dropped = threads.keys().next().value!;
    threads.delete(dropped);
    clearToolSeen(dropped);
    lastStartedTurn.delete(dropped);
  }
  for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
}

/** One live runtime frame. A row in the chat supersedes the status it came from, except the row of the very tool call
 * the status describes: "Writing index.html · 14 KB" outlasts the call's own chip until the call finishes. */
export function noteTurnEvent(event: RuntimeEvent): void {
  const { threadId } = event;
  lastFrames.delete(threadId);
  lastFrames.set(threadId, Date.now());
  if (lastFrames.size > MAX_THREADS) lastFrames.delete(lastFrames.keys().next().value!);
  const current = threads.get(threadId);
  const sameTurn = current && (!event.turnId || event.turnId === current.turnId);
  const turnId = event.turnId ?? current?.turnId;
  const live: TurnLive = sameTurn && current ? current : { turnId, ended: false, status: null, toolSteps: toolTurnSeen.get(toolSeenKey(threadId, turnId))?.size ?? 0 };
  switch (event.type) {
    case "turn.started": {
      // The turn that started before this one keeps its counted calls, so a late frame of it does not restart from zero.
      // Before any turn.started was seen for the thread, the last observed turn is the best guess for the one that ended.
      const previousStarted = lastStartedTurn.get(threadId) ?? current?.turnId;
      clearToolSeen(threadId, previousStarted === turnId ? undefined : previousStarted);
      if (turnId) lastStartedTurn.set(threadId, turnId);
      else lastStartedTurn.delete(threadId);
      return put(threadId, { turnId, ended: false, status: null, toolSteps: 0 });
    }
    case "turn.completed":
    case "cap.exhausted":
    case "session.exited":
      return put(threadId, { turnId, ended: true, status: null, toolSteps: live.toolSteps ?? 0 });
    case "turn.progress": {
      const { activity, tool, file, bytes, itemId, target, detail, quiet, tail } = event;
      return put(threadId, { turnId, ended: false, toolSteps: live.toolSteps ?? 0, status: {
        activity, ...(tool ? { tool } : {}), ...(file ? { file } : {}), ...(bytes !== undefined ? { bytes } : {}), ...(itemId ? { itemId } : {}),
        ...(target ? { target } : {}), ...(detail ? { detail } : {}), ...(quiet ? { quiet } : {}), ...(tail?.length ? { tail } : {}),
      } });
    }
    case "content.delta":
      return put(threadId, { turnId, ended: false, toolSteps: live.toolSteps ?? 0, status: { activity: event.streamKind === "reasoning_text" ? "thinking" : "reply" } });
    case "item.started": {
      const toolSteps = event.itemType === "tool"
        ? bumpToolStep(threadId, turnId, event.itemId, live.toolSteps)
        : live.toolSteps ?? 0;
      return put(threadId, {
        ...live, turnId, ended: false, toolSteps,
        status: live.status?.itemId && live.status.itemId === event.itemId ? live.status : null,
      });
    }
    case "item.completed":
    case "request.opened":
      return put(threadId, { ...live, status: null });
    case "context.summarizing": {
      if (event.active) return put(threadId, { ...live, ended: false, status: { activity: "summarizing" }, ...(live.ended ? { reopened: true as const } : {}) });
      const { reopened, ...rest } = live;
      const stillSummarizing = rest.status?.activity === "summarizing";
      return put(threadId, { ...rest, ended: rest.ended || (!!reopened && stillSummarizing), status: stillSummarizing ? null : rest.status });
    }
    default:
      if (live !== current) put(threadId, live);
  }
}

export function turnLive(threadId: string | null | undefined): TurnLive {
  return (threadId && threads.get(threadId)) || UNKNOWN;
}

/** When this thread last sent any live frame, or, before its first one, when this window first asked. Read on a clock
 * rather than subscribed, so streamed text never re-renders. */
export function silentSince(threadId: string): number {
  const at = lastFrames.get(threadId);
  if (at !== undefined) return at;
  const now = Date.now();
  lastFrames.set(threadId, now);
  return now;
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
  lastFrames.clear();
  toolTurnSeen.clear();
  lastStartedTurn.clear();
}
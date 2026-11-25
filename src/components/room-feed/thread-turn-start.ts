import { useRef } from "react";
import type { Group, GroupTask } from "@/state/store";

type Room = Pick<Group, "threadId" | "busyBotId" | "turnStartedAt">;
type Thread = Pick<GroupTask, "threadId" | "working" | "busyBotId">;

/** When the turn running in a room's thread beside its feed started, for its Thinking readout: the room's own stamp
 * for its current thread (the server keeps one per room, for that thread's speaker), otherwise when this window first
 * saw the thread working. Null while nothing runs there. `seen` keeps those first sightings between renders. */
export function threadTurnStart(room: Room, thread: Thread, seen: Map<string, number>, now = Date.now()): number | null {
  const speaker = thread.busyBotId ?? null;
  const key = `${thread.threadId}:${speaker ?? ""}`;
  if (!thread.working && !speaker) {
    for (const old of seen.keys()) if (old.startsWith(`${thread.threadId}:`)) seen.delete(old);
    return null;
  }
  if (thread.threadId === room.threadId && typeof room.turnStartedAt === "number" && (!speaker || room.busyBotId === speaker)) return room.turnStartedAt;
  if (!seen.has(key)) seen.set(key, now);
  return seen.get(key)!;
}

export function useThreadTurnStart(room: Room | undefined, thread: Thread | undefined): number | null {
  const seen = useRef(new Map<string, number>()).current;
  return room && thread ? threadTurnStart(room, thread, seen) : null;
}

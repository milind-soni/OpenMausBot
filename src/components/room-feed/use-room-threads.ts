import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomThreadSummariesResponse, RoomThreadSummary } from "../../../shared/room-threads";
import { api, type Group, type GroupTask } from "@/state/store";

/** A live line in a thread that is not on screen only moves its task's stamps, so the feed asks again once they settle. */
const SETTLE_MS = 400;

export interface FeedThread {
  task: GroupTask;
  summary: RoomThreadSummary & { first: NonNullable<RoomThreadSummary["first"]> };
}

/** The room's threads that have a first line, oldest first, so the newest sits at the foot of the feed and a thread
 * stays in its place when a reply comes in. */
export function feedThreads(tasks: readonly GroupTask[], summaries: readonly RoomThreadSummary[]): FeedThread[] {
  const byThread = new Map(tasks.filter((task) => task.archivedAt === undefined).map((task) => [task.threadId, task]));
  return summaries.flatMap((summary) => {
    const task = byThread.get(summary.threadId);
    return task && summary.first ? [{ task, summary: summary as FeedThread["summary"] }] : [];
  }).sort((a, b) => a.summary.first.at - b.summary.first.at || a.task.createdAt - b.task.createdAt);
}

const stamps = (tasks: readonly GroupTask[] | undefined) =>
  (tasks ?? []).map((task) => `${task.threadId}:${task.updatedAt ?? ""}:${task.lastThreadOrderAt ?? ""}:${task.archivedAt ?? ""}`).join("|");

/** The room's thread summaries, asked again whenever one of its threads moves; the last answer stays on screen while
 * the next is on its way, and an answer for an older ask is dropped. */
export function useRoomThreads(group: Pick<Group, "id" | "tasks">) {
  const [answer, setAnswer] = useState<{ groupId: string; threads: RoomThreadSummary[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signature = stamps(group.tasks);
  const loaded = answer?.groupId === group.id;
  const settled = useRef(loaded);
  settled.current = loaded;
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api<RoomThreadSummariesResponse>(`/api/groups/${group.id}/threads/summary`)
        .then((response) => { if (current) { setAnswer({ groupId: group.id, threads: response.threads }); setFailed(false); } })
        .catch(() => { if (current) setFailed(true); });
    }, settled.current ? SETTLE_MS : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [group.id, signature, attempt]);
  const threads = useMemo(() => (loaded ? feedThreads(group.tasks ?? [], answer.threads) : null), [loaded, group.tasks, answer]);
  return { threads, failed: failed && !loaded, retry: () => setAttempt((count) => count + 1) };
}

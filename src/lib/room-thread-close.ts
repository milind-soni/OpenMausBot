import type { Dispatch } from "react";
import { api, type Action, type GroupTask, type ThreadCloser } from "@/state/store";

/** How many more of a fold's closed threads one press shows. */
export const FOLD_STEP = 10;

export const isClosed = (task: Pick<GroupTask, "closedAt">): boolean => task.closedAt !== undefined;

/** A room thread's close as a thread row's menu and byline read a close. */
export function threadRowCloser(task: Pick<GroupTask, "closedAt" | "closedBy">): ThreadCloser | undefined {
  return task.closedAt === undefined ? undefined : { botId: task.closedBy?.id ?? "", name: task.closedBy?.name ?? "", at: task.closedAt };
}

/** Everyone's feed follows from the room's frame, which the server sends once the change is saved. */
export function setRoomThreadClosed(groupId: string, threadId: string, closed: boolean, dispatch: Dispatch<Action>): void {
  void api(`/api/groups/${groupId}/tasks/${threadId}`, { method: "PATCH", body: JSON.stringify({ closed }) })
    .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
}

export type FeedItem<Row> = { kind: "row"; row: Row } | { kind: "fold"; key: string; hidden: number };

/** A feed's rows with each run of consecutive rows that `folds` (closed, with nothing new) as one fold. A fold shows
 * `shown[key]` of its run, newest first from the run's foot, below the fold; the key is the run's first thread. */
export function foldClosedRuns<Row extends { threadId: string }>(rows: readonly Row[], folds: (row: Row) => boolean,
  shown: Readonly<Record<string, number>>): FeedItem<Row>[] {
  const items: FeedItem<Row>[] = [];
  let run: Row[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const key = run[0]!.threadId;
    const open = Math.min(run.length, shown[key] ?? 0);
    if (open < run.length) items.push({ kind: "fold", key, hidden: run.length - open });
    for (const row of run.slice(run.length - open)) items.push({ kind: "row", row });
    run = [];
  };
  for (const row of rows) {
    if (folds(row)) { run.push(row); continue; }
    flush();
    items.push({ kind: "row", row });
  }
  flush();
  return items;
}

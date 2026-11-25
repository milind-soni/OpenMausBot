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

export type FeedItem<Row> = { kind: "row"; row: Row } | { kind: "fold"; key: string; threadIds: string[] };

/** A feed's rows with each run of consecutive rows that `folds` (closed, with nothing new) and the person has not opened
 * as one fold. A thread once shown stays shown, wherever its run later splits. */
export function foldClosedRuns<Row extends { threadId: string }>(rows: readonly Row[], folds: (row: Row) => boolean,
  shown: ReadonlySet<string>): FeedItem<Row>[] {
  const items: FeedItem<Row>[] = [];
  for (const row of rows) {
    if (!folds(row) || shown.has(row.threadId)) { items.push({ kind: "row", row }); continue; }
    const last = items.at(-1);
    if (last?.kind === "fold") last.threadIds.push(row.threadId);
    else items.push({ kind: "fold", key: row.threadId, threadIds: [row.threadId] });
  }
  return items;
}

/** What one press on a fold shows: its newest FOLD_STEP threads, the ones nearest the rows under it. */
export const unfoldStep = (fold: { threadIds: readonly string[] }): string[] => fold.threadIds.slice(-FOLD_STEP);

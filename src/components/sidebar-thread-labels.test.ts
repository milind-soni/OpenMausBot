import { describe, expect, it } from "vitest";
import type { Task } from "@/state/store";
import { canUnfold, threadLabels } from "./sidebar-thread-labels";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const thread = (threadId: string, daysAgo: number, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: NOW - daysAgo * DAY, updatedAt: NOW - daysAgo * DAY, ...extra });
const bot = (tasks: Task[], threadId = tasks[0]!.threadId) => ({ threadId, tasks });
const ids = (labels: ReturnType<typeof threadLabels>) => labels.rows.map((row) => row.task.threadId);

describe("a bot's threads under its sidebar row", () => {
  it("unfolds only for a bot with more than one open thread of the person's own", () => {
    expect(canUnfold(bot([thread("main", 9)]))).toBe(false);
    expect(canUnfold(bot([thread("main", 9), thread("routine", 1, { routineRunId: "r" }), thread("old", 2, { archivedAt: 3 })]))).toBe(false);
    expect(canUnfold(bot([thread("main", 9), thread("nda", 1)]))).toBe(true);
  });

  it("folded, lists only what is going on, never the thread the row opens", () => {
    const tasks = [thread("main", 9, { unread: true }), thread("nda", 1), thread("lease", 2, { busy: true, activity: "working" }), thread("brief", 3, { unread: true })];
    const folded = threadLabels(bot(tasks), {}, { unfolded: false, rowThreadId: "main", now: NOW });
    expect(ids(folded)).toEqual(["lease", "brief"]);
    expect(folded.rows.map((row) => row.status)).toEqual(["working", "unread"]);
    expect(folded.more).toBe(0);
  });

  it("unfolded, lists the active ones (open, going on, or used this week), newest first, at most four, and counts the rest", () => {
    const tasks = [thread("main", 30), thread("a", 1), thread("b", 2), thread("c", 3), thread("d", 4), thread("e", 5), thread("old", 20), thread("going", 40, { unread: true })];
    const open = threadLabels(bot(tasks, "main"), {}, { unfolded: true, current: "main", rowThreadId: "main", now: NOW });
    // An old thread with an unread reply is listed too, as it is while folded.
    expect(ids(open)).toEqual(["a", "b", "c", "main", "going"]);
    expect(open.rows.find((row) => row.task.threadId === "main")?.current).toBe(true);
    expect(open.more).toBe(3);
  });

  it("leaves a week-old thread nobody touched in the count, not the list", () => {
    const labels = threadLabels(bot([thread("main", 1), thread("stale", 8)]), {}, { unfolded: true, rowThreadId: "main", now: NOW });
    expect(ids(labels)).toEqual(["main"]);
    expect(labels.more).toBe(1);
  });

  it("lists a thread a bot started on its own only while it runs", () => {
    const tasks = [thread("main", 1), thread("nda", 2), thread("burst", 1, { openedBy: { botId: "x", name: "X", at: 1 } }), thread("run", 1, { routineRunId: "r", busy: true })];
    expect(ids(threadLabels(bot(tasks), {}, { unfolded: true, rowThreadId: "main", now: NOW }))).toEqual(["main", "nda", "run"]);
  });

  it("shows three running threads and counts the others as running", () => {
    const working = { busy: true, activity: "working" as const };
    const tasks = [thread("main", 1), ...["w1", "w2", "w3", "w4", "w5"].map((id, index) => thread(id, index + 1, working))];
    const folded = threadLabels(bot(tasks), {}, { unfolded: false, rowThreadId: "main", now: NOW });
    expect(folded.rows).toHaveLength(3);
    expect(folded.runningMore).toBe(2);
  });
});

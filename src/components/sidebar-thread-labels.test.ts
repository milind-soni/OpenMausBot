import { describe, expect, it } from "vitest";
import type { Task } from "@/state/store";
import { canUnfold, openThreadPinned, threadLabels } from "./sidebar-thread-labels";

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

  it("unfolded, lists the main thread first, however old it is, in place of the oldest active one", () => {
    const tasks = [thread("main", 30), thread("a", 1), thread("b", 2), thread("c", 3), thread("d", 4), thread("e", 5)];
    const labels = threadLabels({ ...bot(tasks, "e"), mainThreadId: "main" }, {}, { unfolded: true, current: "e", rowThreadId: "e", now: NOW });
    expect(ids(labels)).toEqual(["main", "a", "b", "e"]);
    expect(labels.more).toBe(2);
  });

  it("unfolded, lists the main thread first whoever opened it and whatever its state", () => {
    const listed = (main: Partial<Task>) => {
      const labels = threadLabels({ ...bot([thread("a", 1), thread("b", 2), thread("main", 30, main)], "a"), mainThreadId: "main" }, {}, { unfolded: true, current: "a", rowThreadId: "a", now: NOW });
      return labels.rows.map((row) => [row.task.threadId, row.main]);
    };
    const first = [["main", true], ["a", false], ["b", false]];
    expect(listed({ openedBy: { botId: "atlas", name: "Atlas", at: 1 } })).toEqual(first);
    expect(listed({ openedBy: { botId: "maus", name: "Maus", at: 1, burstId: "burst" } })).toEqual(first);
    expect(listed({ snoozedUntil: NOW + DAY })).toEqual(first);
    expect(canUnfold({ ...bot([thread("a", 1), thread("main", 30, { openedBy: { botId: "atlas", name: "Atlas", at: 1 } })]), mainThreadId: "main" })).toBe(true);
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

  it("folded, keeps the pinned threads listed first, above running ones, each once", () => {
    const working = { busy: true, activity: "working" as const };
    const tasks = [thread("main", 1), thread("lease", 2, working), thread("weekly", 40, { pinned: true, lastThreadOrderAt: NOW - 40 * DAY }),
      thread("brief", 30, { pinned: true, ...working, lastThreadOrderAt: NOW - 5 * DAY }), thread("once", 3)];
    const folded = threadLabels(bot(tasks), {}, { unfolded: false, rowThreadId: "main", now: NOW });
    expect(ids(folded)).toEqual(["brief", "weekly", "lease"]);
    expect(folded.rows.map((row) => row.pinned)).toEqual([true, true, false]);
    expect(folded.rows[0]!.status).toBe("working");
  });

  it("unpinned, a quiet thread folds away again", () => {
    const tasks = [thread("main", 1), thread("weekly", 40, { pinned: true }), thread("once", 3)];
    expect(ids(threadLabels(bot(tasks), {}, { unfolded: false, rowThreadId: "main", now: NOW }))).toEqual(["weekly"]);
    const unpinned = tasks.map((task) => task.threadId === "weekly" ? { ...task, pinned: undefined } : task);
    expect(ids(threadLabels(bot(unpinned), {}, { unfolded: false, rowThreadId: "main", now: NOW }))).toEqual([]);
  });

  it("keeps the open pinned thread listed, where it carries the selected fill", () => {
    const tasks = [thread("main", 1), thread("weekly", 40, { pinned: true })];
    const folded = threadLabels(bot(tasks, "weekly"), {}, { unfolded: false, current: "weekly", rowThreadId: "weekly", now: NOW });
    expect(ids(folded)).toEqual(["weekly"]);
    expect(folded.rows[0]!.current).toBe(true);
    expect(openThreadPinned(bot(tasks, "weekly"))).toBe(true);
    expect(openThreadPinned(bot(tasks, "main"))).toBe(false);
  });

  it("unfolded, lists pins beyond the four active ones and leaves them out of the count", () => {
    const tasks = [thread("main", 1), thread("a", 1), thread("b", 2), thread("c", 3), thread("d", 4), thread("old", 30, { pinned: true })];
    const open = threadLabels(bot(tasks), {}, { unfolded: true, rowThreadId: "main", now: NOW });
    expect(ids(open)).toEqual(["old", "main", "a", "b", "c"]);
    expect(open.more).toBe(1);
  });

  it("lists no pin for a bot whose only open thread it is, nor an archived or snoozed pin", () => {
    expect(ids(threadLabels(bot([thread("main", 1, { pinned: true })]), {}, { unfolded: false, rowThreadId: "main", now: NOW }))).toEqual([]);
    const tasks = [thread("main", 1), thread("gone", 2, { pinned: true, archivedAt: 5 }), thread("later", 2, { pinned: true, snoozedUntil: 0 })];
    expect(ids(threadLabels(bot(tasks), {}, { unfolded: false, rowThreadId: "main", now: NOW }))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { FOLD_STEP, foldClosedRuns, threadRowCloser } from "./room-thread-close";

const rows = (spec: string) => [...spec].map((mark, index) => ({ threadId: `t${index}`, closed: mark === "c" }));
const shape = (items: ReturnType<typeof foldClosedRuns<{ threadId: string; closed: boolean }>>) =>
  items.map((item) => item.kind === "fold" ? `fold(${item.key}:${item.hidden})` : item.row.threadId);

describe("folding a room feed's closed threads", () => {
  it("folds each run of consecutive closed threads into one row, and leaves open ones alone", () => {
    expect(shape(foldClosedRuns(rows("occcoc"), (row) => row.closed, {}))).toEqual(["t0", "fold(t1:3)", "t4", "fold(t5:1)"]);
    expect(shape(foldClosedRuns(rows("ooo"), (row) => row.closed, {}))).toEqual(["t0", "t1", "t2"]);
    expect(foldClosedRuns([], () => true, {})).toEqual([]);
  });

  it("unfolds a run in place, the newest of it first, ten at a time", () => {
    const many = rows(`o${"c".repeat(25)}o`);
    const once = shape(foldClosedRuns(many, (row) => row.closed, { t1: FOLD_STEP }));
    expect(once.slice(0, 2)).toEqual(["t0", "fold(t1:15)"]);
    expect(once.slice(2)).toEqual([...Array.from({ length: 10 }, (_, i) => `t${16 + i}`), "t26"]);
    const all = shape(foldClosedRuns(many, (row) => row.closed, { t1: 3 * FOLD_STEP }));
    expect(all).toEqual(many.map((row) => row.threadId));
  });

  it("keeps a closed thread with news out of the fold, splitting the run around it", () => {
    const feed = rows("cccc").map((row) => ({ ...row, unread: row.threadId === "t2" }));
    expect(shape(foldClosedRuns(feed, (row) => row.closed && !row.unread, {}))).toEqual(["fold(t0:2)", "t2", "fold(t3:1)"]);
  });

  it("reads a room thread's close as a thread row's close", () => {
    expect(threadRowCloser({})).toBeUndefined();
    expect(threadRowCloser({ closedAt: 5, closedBy: { kind: "bot", id: "b1", name: "Writer" } })).toEqual({ botId: "b1", name: "Writer", at: 5 });
  });
});

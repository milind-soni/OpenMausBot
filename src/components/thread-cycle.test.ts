import { describe, expect, it } from "vitest";
import type { Task } from "@/state/store";
import { threadCycleStep } from "@/lib/keyboard-shortcuts";
import { nextCycleThread, threadCycleOrder } from "./thread-cycle";

const thread = (threadId: string, at: number, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: at, lastThreadOrderAt: at, ...extra });
const key = (extra: Partial<KeyboardEvent> = {}) =>
  ({ key: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, keyCode: 9, target: null, ...extra }) as KeyboardEvent;

describe("Ctrl+Tab through a bot's threads", () => {
  it("steps forward on Ctrl+Tab and back on Ctrl+Shift+Tab", () => {
    expect(threadCycleStep(key())).toBe(1);
    expect(threadCycleStep(key({ shiftKey: true }))).toBe(-1);
  });

  it("leaves other chords, a composing input method, a key a field took, and dialogs alone", () => {
    expect(threadCycleStep(key({ ctrlKey: false }))).toBeNull();
    expect(threadCycleStep(key({ metaKey: true }))).toBeNull();
    expect(threadCycleStep(key({ altKey: true }))).toBeNull();
    expect(threadCycleStep(key({ key: "t" }))).toBeNull();
    expect(threadCycleStep(key({ isComposing: true }))).toBeNull();
    expect(threadCycleStep(key({ keyCode: 229 }))).toBeNull();
    expect(threadCycleStep(key({ defaultPrevented: true }))).toBeNull();
  });

  it("goes in the thread list's order, pinned first, skipping archived, snoozed, routine and bot-opened threads", () => {
    const tasks = [thread("main", 1), thread("new", 9), thread("pin", 2, { pinned: true }), thread("mid", 5), thread("gone", 8, { archivedAt: 1 }),
      thread("later", 8, { snoozedUntil: 0 }), thread("run", 8, { routineRunId: "r" }), thread("helper", 8, { openedBy: { botId: "x", name: "X", at: 1 } })];
    expect(threadCycleOrder({ tasks })).toEqual(["pin", "new", "mid", "main"]);
  });

  it("puts the pins in the order the Inbox lists them, most recently active first", () => {
    const tasks = [thread("a", 1), thread("old", 2, { pinned: true, updatedAt: 3 }), thread("fresh", 1, { pinned: true, updatedAt: 9 })];
    expect(threadCycleOrder({ tasks })).toEqual(["fresh", "old", "a"]);
  });

  it("wraps at either end", () => {
    const order = ["a", "b", "c"];
    expect(nextCycleThread(order, "a", 1)).toBe("b");
    expect(nextCycleThread(order, "c", 1)).toBe("a");
    expect(nextCycleThread(order, "a", -1)).toBe("c");
    expect(nextCycleThread(order, "b", -1)).toBe("a");
  });

  it("from a thread outside the order lands on the first or the last, and does nothing with one thread", () => {
    expect(nextCycleThread(["a", "b"], "x", 1)).toBe("a");
    expect(nextCycleThread(["a", "b"], "x", -1)).toBe("b");
    expect(nextCycleThread(["a"], "a", 1)).toBeNull();
    expect(nextCycleThread([], "a", 1)).toBeNull();
  });
});

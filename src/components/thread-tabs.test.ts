import { describe, expect, it } from "vitest";
import type { Task } from "@/state/store";
import { newChatThreadId } from "@/state/new-chat";
import { botShowsTabs, neighbourOf, showsTabs, threadTabs, type TabsBot } from "./thread-tabs";

const task = (threadId: string, at: number, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: at, lastThreadOrderAt: at, ...extra });

const bot = (tasks: Task[], extra: Partial<TabsBot> = {}): TabsBot => ({ id: "kiwi", threadId: tasks[0]?.threadId ?? "", tasks, ...extra });

describe("thread tabs", () => {
  it("lists pinned threads first, then the rest by recent use, as the sidebar does", () => {
    const tabs = threadTabs(bot([task("old", 1), task("launch", 2, { pinned: true }), task("new", 5), task("mid", 3)], { threadId: "mid" }));
    expect(tabs.map((tab) => tab.threadId)).toEqual(["launch", "new", "mid", "old"]);
    expect(tabs[0].pinned).toBe(true);
  });

  it("leaves out archived, snoozed, closed, routine and burst threads, unless one is open", () => {
    const tasks = [
      task("mine", 9), task("gone", 8, { archivedAt: 1 }), task("later", 7, { snoozedUntil: 0 }), task("run", 6, { routineRunId: "r1" }),
      task("burst", 5, { openedBy: { botId: "b", name: "Rio", at: 1, burstId: "x" } }), task("closed", 4, { closedBy: { botId: "b", name: "Rio", at: 1 } }),
    ];
    expect(threadTabs(bot(tasks, { threadId: "mine" })).map((tab) => tab.threadId)).toEqual(["mine"]);
    expect(threadTabs(bot(tasks, { threadId: "gone" })).map((tab) => tab.threadId)).toEqual(["mine", "gone"]);
    expect(threadTabs(bot(tasks, { threadId: "mine", switchingTo: "run" })).map((tab) => tab.threadId)).toEqual(["mine", "run"]);
  });

  it("counts a thread another bot opened while it is still going, so a bot whose work comes from teammates gets its switcher", () => {
    const rio = { botId: "lead", name: "Lead", at: 1 };
    const tasks = [task("main", 1, { openedBy: rio }), task("steer", 3, { openedBy: rio }), task("gemini", 2, { openedBy: rio }), task("done", 4, { openedBy: rio, closedBy: rio })];
    const helper = bot(tasks, { threadId: "main", mainThreadId: "main" });
    expect(threadTabs(helper).map((tab) => tab.threadId)).toEqual(["steer", "gemini", "main"]);
    expect(botShowsTabs(helper, null)).toBe(true);
  });

  it("keeps the main thread whoever opened it, even when another thread is on screen", () => {
    const tasks = [task("main", 1, { routineRunId: "r" }), task("other", 2)];
    expect(threadTabs(bot(tasks, { threadId: "other", mainThreadId: "main" })).map((tab) => tab.threadId)).toEqual(["other", "main"]);
  });

  it("shows the strip only for two threads or more, the blank New thread chat counted", () => {
    const one = bot([task("only", 1)]);
    expect(showsTabs(threadTabs(one))).toBe(false);
    expect(botShowsTabs(one, null)).toBe(false);
    expect(botShowsTabs(one, { session: 1, botId: "kiwi", held: [] })).toBe(true);
    expect(botShowsTabs(one, { session: 1, botId: "other", held: [] })).toBe(false);
  });

  it("puts the blank New thread tab where its thread will land: after the pinned ones", () => {
    const tabs = threadTabs(bot([task("pin", 1, { pinned: true }), task("a", 3), task("b", 2)], { threadId: newChatThreadId("kiwi") }));
    expect(tabs.map((tab) => tab.threadId)).toEqual(["pin", newChatThreadId("kiwi"), "a", "b"]);
    expect(tabs[1]).toMatchObject({ draft: true, closable: true, renamable: false });
  });

  it("has no close on the main thread, a running one, a shared chat or the last one left", () => {
    const tabs = threadTabs(bot([
      task("main", 5), task("busy", 4, { busy: true }), task("shared", 3, { sharedChat: true }), task("plain", 2),
    ], { mainThreadId: "main", threadId: "plain" }));
    expect(Object.fromEntries(tabs.map((tab) => [tab.threadId, tab.closable]))).toEqual({ main: false, busy: false, shared: false, plain: true });
    expect(threadTabs(bot([task("only", 1)], { mainThreadId: "elsewhere" }))[0].closable).toBe(false);
  });

  it("marks the open thread running while its bot is busy", () => {
    const tabs = threadTabs(bot([task("a", 2), task("b", 1)], { threadId: "a", busy: true }));
    expect(tabs.map((tab) => tab.working)).toEqual([true, false]);
  });

  it("moves to the tab after a closed one, else the one before", () => {
    const tabs = threadTabs(bot([task("a", 3), task("b", 2), task("c", 1)]));
    expect(neighbourOf(tabs, "a")).toBe("b");
    expect(neighbourOf(tabs, "c")).toBe("b");
    expect(neighbourOf(tabs, "nope")).toBeUndefined();
  });
});

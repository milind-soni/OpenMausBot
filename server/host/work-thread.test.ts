import { describe, expect, it } from "vitest";

import type { TaskRecord } from "../store.ts";
import { workThreadFor } from "./work-thread.ts";

const by = (botId: string, name: string, threadId: string): TaskRecord["openedBy"] => ({ botId, name, threadId, kind: "work", at: 0 });
const task = (threadId: string, openedBy?: TaskRecord["openedBy"], more: Partial<TaskRecord> = {}): TaskRecord =>
  ({ id: threadId, threadId, title: threadId, ...(openedBy ? { openedBy } : {}), ...more }) as TaskRecord;

// Bugfixer's scheduled run ("run-1") asked Liaison with reply none: Liaison's running assignment answers "run-1".
// An earlier run ("run-0") once handed the same reused "liaison-work" thread work, so its opener is stale.
const tasks: Record<string, TaskRecord[]> = {
  bugfixer: [task("run-0"), task("run-1"), task("archived-run", undefined, { archivedAt: 1 }), task("opened-by-liaison", by("liaison", "Liaison", "liaison-chat"))],
  liaison: [task("liaison-work", by("bugfixer", "Bugfixer", "run-0"))],
};
const run1 = { botId: "bugfixer", threadId: "run-1" };
const store = {
  taskByThread: (botId: string, threadId: string) => (tasks[botId] ?? []).find((t) => t.threadId === threadId),
  workThread: () => undefined,
};
const fromLiaison = (thread: string, notice: boolean, also: (task: TaskRecord) => boolean = () => true,
  answering: { botId: string; threadId: string } | undefined = run1) => workThreadFor(store,
  { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-work", thread, notice, answering, also });

describe("workThreadFor", () => {
  it("keeps a thread the sender opened", () => {
    expect(fromLiaison("opened-by-liaison", false)?.threadId).toBe("opened-by-liaison");
  });

  it("lets a one-way notice answer the thread that handed the sender work, and refuses new work there", () => {
    expect(fromLiaison("run-1", true)?.threadId).toBe("run-1");
    expect(() => fromLiaison("run-1", false)).toThrow(/handed you work: answer it there with reply "none"/);
  });

  it("takes that notice only for the running assignment's requester, not a stale opener of a reused thread", () => {
    expect(() => fromLiaison("run-0", true)).toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => workThreadFor(store, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-work", thread: "run-1",
      notice: true, answering: undefined, also: () => true })).toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => fromLiaison("run-1", true, () => true, { botId: "someone", threadId: "run-1" })).toThrow(/is not a thread you opened on Bugfixer/);
  });

  it("refuses any other thread, an archived one, or one `also` rules out, even for a notice", () => {
    const anyOther = { ...store, taskByThread: () => task("someone-elses") };
    expect(() => workThreadFor(anyOther, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread: "someone-elses", notice: true, answering: run1, also: () => true }))
      .toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => fromLiaison("archived-run", true, () => true, { botId: "bugfixer", threadId: "archived-run" })).toThrow(/is not a thread you opened/);
    expect(() => fromLiaison("run-1", true, () => false)).toThrow(/is not a thread you opened/);
  });
});

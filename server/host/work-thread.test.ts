import { describe, expect, it } from "vitest";

import type { TaskRecord } from "../store.ts";
import { workThreadFor } from "./work-thread.ts";

const by = (botId: string, name: string, threadId: string): TaskRecord["openedBy"] => ({ botId, name, threadId, kind: "work", at: 0 });
const task = (threadId: string, openedBy?: TaskRecord["openedBy"], more: Partial<TaskRecord> = {}): TaskRecord =>
  ({ id: threadId, threadId, title: threadId, ...(openedBy ? { openedBy } : {}), ...more }) as TaskRecord;

// Bugfixer's scheduled run ("run-1") asked Liaison with reply none: that handoff opened Liaison's "liaison-work".
const tasks: Record<string, TaskRecord[]> = {
  bugfixer: [task("run-1"), task("archived-run", undefined, { archivedAt: 1 }), task("opened-by-liaison", by("liaison", "Liaison", "liaison-chat"))],
  liaison: [task("liaison-work", by("bugfixer", "Bugfixer", "run-1")),
    task("archived-ask", by("bugfixer", "Bugfixer", "archived-run"))],
};
const store = {
  taskByThread: (botId: string, threadId: string) => (tasks[botId] ?? []).find((t) => t.threadId === threadId),
  workThread: () => undefined,
};
const fromLiaison = (thread: string, notice: boolean, also: (task: TaskRecord) => boolean = () => true, fromThreadId = "liaison-work") => workThreadFor(store,
  { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId, thread, notice, also });

describe("workThreadFor", () => {
  it("keeps a thread the sender opened", () => {
    expect(fromLiaison("opened-by-liaison", false)?.threadId).toBe("opened-by-liaison");
  });

  it("lets a one-way notice answer the thread that handed the sender work, and refuses new work there", () => {
    expect(fromLiaison("run-1", true)?.threadId).toBe("run-1");
    expect(() => fromLiaison("run-1", false)).toThrow(/handed you work: answer it there with reply "none"/);
  });

  it("takes that notice only from the thread the work was handed to", () => {
    expect(() => fromLiaison("run-1", true, () => true, "liaison-chat")).toThrow(/is not a thread you opened on Bugfixer/);
  });

  it("refuses any other thread, an archived one, or one `also` rules out, even for a notice", () => {
    const anyOther = { ...store, taskByThread: () => task("someone-elses") };
    expect(() => workThreadFor(anyOther, { botId: "bugfixer", botName: "Bugfixer", fromBotId: "liaison", fromThreadId: "liaison-chat", thread: "someone-elses", notice: true, also: () => true }))
      .toThrow(/is not a thread you opened on Bugfixer/);
    expect(() => fromLiaison("archived-run", true)).toThrow(/is not a thread you opened/);
    expect(() => fromLiaison("run-1", true, () => false)).toThrow(/is not a thread you opened/);
  });
});

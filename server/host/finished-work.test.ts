import { describe, expect, it } from "vitest";

import type { TaskRecord } from "../store.ts";
import { archivesOnResult, closesOnResult, finishHandedThread, reopenHandedThread } from "./finished-work.ts";

type Task = Parameters<typeof closesOnResult>[0];
const opened = (more: Partial<NonNullable<TaskRecord["openedBy"]>> = {}): NonNullable<TaskRecord["openedBy"]> =>
  ({ botId: "chief", name: "Clive", threadId: "chief-chat", at: 0, ...more });
const closes = (task: Task, opener = "chief", owner = "lead") => closesOnResult(task, opener, owner);

describe("closesOnResult", () => {
  it("closes the standing work thread", () => {
    expect(closes({ openedBy: opened({ kind: "work" }) })).toBe(true);
  });

  it("closes a thread a teammate opened with thread \"new\"", () => {
    expect(closes({ openedBy: opened() })).toBe(true);
  });

  it("keeps a thread \"new\" opened that was pinned, filed in a folder or written in by a person", () => {
    expect(closes({ openedBy: opened(), pinned: true })).toBe(false);
    expect(closes({ openedBy: opened(), projectId: "folder-1" })).toBe(false);
    expect(closes({ openedBy: opened(), askedAt: 1 })).toBe(false);
  });

  it("closes the standing work thread whether or not it was kept", () => {
    expect(closes({ openedBy: opened({ kind: "work" }), pinned: true, projectId: "folder-1", askedAt: 1 })).toBe(true);
  });

  it("keeps the pair conversation, a burst's part, a room lane and a thread a bot opened on itself", () => {
    expect(closes({ openedBy: opened({ kind: "pair" }) })).toBe(false);
    expect(closes({ openedBy: opened({ burstId: "burst-1" }) })).toBe(false);
    expect(closes({ openedBy: opened({ roomLane: true }) })).toBe(false);
    expect(closes({ openedBy: opened({ botId: "lead" }) }, "lead", "lead")).toBe(false);
  });

  it("leaves a thread another bot opened, one already closed, and one nobody opened", () => {
    expect(closes({ openedBy: opened({ botId: "other" }) })).toBe(false);
    expect(closes({ openedBy: opened({ kind: "work", botId: "other" }) })).toBe(false);
    expect(closes({ openedBy: opened(), closedBy: { botId: "chief", name: "Clive", at: 1 } })).toBe(false);
    expect(closes({})).toBe(false);
    expect(closes(undefined)).toBe(false);
  });
});

describe("archivesOnResult", () => {
  it("archives a thread \"new\" opened, but not the standing work thread", () => {
    expect(archivesOnResult({ openedBy: opened() }, false)).toBe(true);
    expect(archivesOnResult({ openedBy: opened({ kind: "work" }) }, false)).toBe(false);
  });

  it("leaves an unread thread in the sidebar", () => {
    expect(archivesOnResult({ openedBy: opened(), unread: true }, false)).toBe(false);
  });

  it("leaves a thread whose wait is still armed in the sidebar", () => {
    expect(archivesOnResult({ openedBy: opened() }, true)).toBe(false);
  });
});

describe("finishHandedThread", () => {
  const fakeStore = (task: Partial<TaskRecord>) => {
    const record = { threadId: "lead-thread", ...task } as TaskRecord;
    const calls: string[] = [];
    return {
      record, calls,
      taskByThread: (_botId: string, threadId: string) => threadId === record.threadId ? record : undefined,
      bot: (botId: string) => (botId === "chief" ? { name: "Clive" } : undefined) as never,
      setTaskClosedBy: (_botId: string, _threadId: string, closedBy: TaskRecord["closedBy"] | null) => { record.closedBy = closedBy ?? undefined; calls.push("closed"); return record; },
      patchTask: (_botId: string, _threadId: string, patch: Partial<TaskRecord>) => { Object.assign(record, patch); calls.push(`archivedAt=${patch.archivedAt}`); return record; },
    };
  };

  it("closes and archives a thread \"new\" opened at the same moment", () => {
    const store = fakeStore({ openedBy: opened() });
    finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
    expect(store.record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 42 });
    expect(store.record.archivedAt).toBe(42);
  });

  it("only closes the standing work thread and an unread thread", () => {
    for (const task of [{ openedBy: opened({ kind: "work" }) }, { openedBy: opened(), unread: true }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
      expect(store.calls).toEqual(["closed"]);
    }
  });

  it("neither closes nor archives a thread that stays open", () => {
    for (const task of [{ openedBy: opened(), pinned: true }, { openedBy: opened(), askedAt: 1 }, { openedBy: opened({ kind: "pair" as const }) }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
      expect(store.calls).toEqual([]);
    }
  });
});

describe("reopenHandedThread", () => {
  it("unarchives an archived thread and leaves an open one alone", () => {
    const patches: unknown[] = [];
    const store = { patchTask: (_botId: string, _threadId: string, patch: unknown) => { patches.push(patch); return null; } };
    reopenHandedThread(store, "lead", { threadId: "t", archivedAt: 5 });
    reopenHandedThread(store, "lead", { threadId: "t" });
    expect(patches).toEqual([{ archivedAt: undefined }]);
  });
});

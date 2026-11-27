import { describe, expect, it } from "vitest";

import type { TaskRecord } from "../store.ts";
import { archivedOnResult, archivesOnResult, closesOnResult, finishHandedThread, keepHandedThread, reopenHandedThread } from "./finished-work.ts";

type Task = Parameters<typeof closesOnResult>[0];
const opened = (more: Partial<NonNullable<TaskRecord["openedBy"]>> = {}): NonNullable<TaskRecord["openedBy"]> =>
  ({ botId: "chief", name: "Clive", threadId: "chief-chat", at: 0, ...more });
/** A thread coordinate_bots opened with thread "new" for one hand-off. */
const oneShot = (more: Partial<NonNullable<TaskRecord["openedBy"]>> = {}) => opened({ oneShot: true, ...more });
const closes = (task: Task, opener = "chief", owner = "lead") => closesOnResult(task, opener, owner);

describe("closesOnResult", () => {
  it("closes the standing work thread", () => {
    expect(closes({ openedBy: opened({ kind: "work" }) })).toBe(true);
  });

  it("closes a thread a teammate opened with thread \"new\" for one hand-off", () => {
    expect(closes({ openedBy: oneShot() })).toBe(true);
  });

  it("keeps a thread start_thread opened on a teammate, or one a post_to_thread reached", () => {
    expect(closes({ openedBy: opened() })).toBe(false);
  });

  it("keeps a thread \"new\" opened that was pinned, filed in a folder or written in by a person", () => {
    expect(closes({ openedBy: oneShot(), pinned: true })).toBe(false);
    expect(closes({ openedBy: oneShot(), projectId: "folder-1" })).toBe(false);
    expect(closes({ openedBy: oneShot(), askedAt: 1 })).toBe(false);
  });

  it("closes the standing work thread whether or not it was kept", () => {
    expect(closes({ openedBy: opened({ kind: "work" }), pinned: true, projectId: "folder-1", askedAt: 1 })).toBe(true);
  });

  it("keeps the pair conversation, a burst's part, a room lane and a thread a bot opened on itself", () => {
    expect(closes({ openedBy: oneShot({ kind: "pair" }) })).toBe(false);
    expect(closes({ openedBy: oneShot({ burstId: "burst-1" }) })).toBe(false);
    expect(closes({ openedBy: oneShot({ roomLane: true }) })).toBe(false);
    expect(closes({ openedBy: oneShot({ botId: "lead" }) }, "lead", "lead")).toBe(false);
  });

  it("leaves a thread another bot opened, one already closed, and one nobody opened", () => {
    expect(closes({ openedBy: oneShot({ botId: "other" }) })).toBe(false);
    expect(closes({ openedBy: opened({ kind: "work", botId: "other" }) })).toBe(false);
    expect(closes({ openedBy: oneShot(), closedBy: { botId: "chief", name: "Clive", at: 1 } })).toBe(false);
    expect(closes({})).toBe(false);
    expect(closes(undefined)).toBe(false);
  });
});

describe("archivesOnResult", () => {
  it("archives a one-shot thread, but not the standing work thread or a thread start_thread opened", () => {
    expect(archivesOnResult({ openedBy: oneShot() }, false)).toBe(true);
    expect(archivesOnResult({ openedBy: opened({ kind: "work" }) }, false)).toBe(false);
    expect(archivesOnResult({ openedBy: opened() }, false)).toBe(false);
  });

  it("leaves an unread thread in the sidebar", () => {
    expect(archivesOnResult({ openedBy: oneShot(), unread: true }, false)).toBe(false);
  });

  it("leaves a thread whose wait is still armed in the sidebar", () => {
    expect(archivesOnResult({ openedBy: oneShot() }, true)).toBe(false);
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

  it("closes and archives a one-shot thread at the same moment", () => {
    const store = fakeStore({ openedBy: oneShot() });
    finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
    expect(store.record.closedBy).toEqual({ botId: "chief", name: "Clive", at: 42 });
    expect(store.record.archivedAt).toBe(42);
  });

  it("only closes the standing work thread and an unread thread", () => {
    for (const task of [{ openedBy: opened({ kind: "work" }) }, { openedBy: oneShot(), unread: true }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
      expect(store.calls).toEqual(["closed"]);
    }
  });

  it("neither closes nor archives a thread that stays open", () => {
    for (const task of [{ openedBy: oneShot(), pinned: true }, { openedBy: oneShot(), askedAt: 1 }, { openedBy: oneShot({ kind: "pair" as const }) }, { openedBy: opened() }]) {
      const store = fakeStore(task);
      finishHandedThread(store, "lead", "lead-thread", "chief", () => false, 42);
      expect(store.calls).toEqual([]);
    }
  });
});

describe("reopenHandedThread", () => {
  const closedBy = { botId: "chief", name: "Clive", at: 5 };
  it("takes a one-shot thread out of the archive its result put it in", () => {
    const patches: unknown[] = [];
    const store = { patchTask: (_botId: string, _threadId: string, patch: unknown) => { patches.push(patch); return null; } };
    reopenHandedThread(store, "lead", { threadId: "t", openedBy: oneShot(), closedBy, archivedAt: 5 });
    reopenHandedThread(store, "lead", { threadId: "t", openedBy: oneShot() });
    expect(patches).toEqual([{ archivedAt: undefined }]);
  });

  it("leaves a thread the person archived in the archive", () => {
    expect(archivedOnResult({ openedBy: oneShot(), closedBy, archivedAt: 5 })).toBe(true);
    expect(archivedOnResult({ openedBy: oneShot(), closedBy, archivedAt: 8 })).toBe(false);
    expect(archivedOnResult({ openedBy: oneShot(), archivedAt: 5 })).toBe(false);
    expect(archivedOnResult({ openedBy: oneShot(), closedBy: { ...closedBy, botId: "lead" }, archivedAt: 5 })).toBe(false);
    expect(archivedOnResult({ openedBy: opened(), closedBy, archivedAt: 5 })).toBe(false);
  });
});

describe("keepHandedThread", () => {
  it("takes the one-shot mark off a thread a post_to_thread reached, and leaves other threads alone", () => {
    const tasks: Record<string, Partial<TaskRecord>> = { shot: { openedBy: oneShot() }, plain: { openedBy: opened() } };
    const written: unknown[] = [];
    const store = {
      taskByThread: (_botId: string, threadId: string) => tasks[threadId] as TaskRecord | undefined,
      setTaskOpenedBy: (_botId: string, threadId: string, openedBy: TaskRecord["openedBy"]) => { written.push([threadId, openedBy]); return null; },
    };
    keepHandedThread(store, "lead", "shot");
    keepHandedThread(store, "lead", "plain");
    keepHandedThread(store, "lead", "gone");
    expect(written).toEqual([["shot", opened()]]);
  });
});

import { describe, expect, it } from "vitest";

import type { TaskRecord } from "../store.ts";
import { closesOnResult } from "./finished-work.ts";

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

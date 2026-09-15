import { describe, expect, it } from "vitest";
import type { TaskRecord } from "./store.ts";
import { wireTaskFor } from "./wire.ts";

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  threadId: "chief-chat",
  title: "Chief",
  createdAt: 1,
  activity: "idle",
  busy: false,
  resumeCursors: { codex: "cursor-1" },
  lastInstanceId: "codex",
  ...overrides,
});

describe("wireTaskFor", () => {
  // #1223: the parent thread's own turn is done; a teammate is still running.
  it("keeps the handoff busy for wait clients and marks it as a teammate wait", () => {
    const wireTask = wireTaskFor(() => true);
    const wired = wireTask(task());
    expect(wired.busy).toBe(true);
    expect(wired.activity).toBe("working");
    expect(wired.waitingOnTeammate).toBe(true);
  });

  it("keeps a working thread working without the wait flag", () => {
    const wireTask = wireTaskFor(() => true);
    const wired = wireTask(task({ busy: true, activity: "working" }));
    expect(wired.busy).toBe(true);
    expect(wired.activity).toBe("working");
    expect(wired.waitingOnTeammate).toBeUndefined();
  });

  it("leaves a thread outside coordination untouched and strips provider bookkeeping", () => {
    const wireTask = wireTaskFor(() => false);
    const wired = wireTask(task());
    expect(wired).toEqual({ threadId: "chief-chat", title: "Chief", createdAt: 1, activity: "idle", busy: false });
    expect(wired.waitingOnTeammate).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskRecord } from "../store.ts";
import { startUpkeep, taskWorkspaceRetentionOn, THREAD_LOG_RETENTION_SWEEP_MS } from "./start-upkeep.ts";

const task = (threadId: string, extra: Partial<TaskRecord> = {}) => ({ threadId, closedBy: { at: 1 }, archivedAt: null, unread: false, ...extra }) as TaskRecord;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("start-up upkeep", () => {
  it("holds the task workspaces' sweep off unless OMB_TASK_WORKSPACE_RETENTION is on", async () => {
    expect(taskWorkspaceRetentionOn({})).toBe(false);
    expect(taskWorkspaceRetentionOn({ OMB_TASK_WORKSPACE_RETENTION: "0" })).toBe(false);
    expect(taskWorkspaceRetentionOn({ OMB_TASK_WORKSPACE_RETENTION: "off" })).toBe(false);
    expect(taskWorkspaceRetentionOn({ OMB_TASK_WORKSPACE_RETENTION: "remove" })).toBe(false);
    for (const value of ["1", "on", " TRUE ", "yes"]) expect(taskWorkspaceRetentionOn({ OMB_TASK_WORKSPACE_RETENTION: value })).toBe(true);
    vi.useFakeTimers();
    vi.stubEnv("OMB_TASK_WORKSPACE_RETENTION", "");
    const calls: string[] = [];
    startUpkeep({
      bots: () => [{ id: "bot", tasks: [task("idle")] }],
      retentionDays: () => 30,
      busy: () => false,
      openDirectHandoff: () => false,
      cleanupPartials: () => 0,
      sweepLogs: () => { calls.push("logs"); return 0; },
      sweepWorkspaces: () => { calls.push("workspaces"); return []; },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(THREAD_LOG_RETENTION_SWEEP_MS);
    expect(calls).toEqual(["logs", "logs"]);
    vi.unstubAllEnvs();
  });

  it("runs its first pass once the server answers, not before, then the logs' sweep once a day", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    startUpkeep({
      bots: () => [{ id: "bot", tasks: [task("quiet"), task("working"), task("handed", { unread: true })] }],
      retentionDays: () => 30,
      busy: (_botId, threadId) => threadId === "working",
      openDirectHandoff: (threadId) => threadId === "quiet",
      cleanupPartials: () => { calls.push("partials"); return 0; },
      workspaceRetention: () => true,
      sweepWorkspaces: () => { calls.push("workspaces"); return []; },
      sweepLogs: (candidates, days) => {
        calls.push(`logs ${days}: ${[...candidates].map((c) => `${c.threadId}${c.busy ? " busy" : ""}${c.openDirectHandoff ? " handoff" : ""}${c.unread ? " unread" : ""}`).join(", ")}`);
        return 0;
      },
    });
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    const pass = "logs 30: quiet handoff, working busy, handed unread";
    expect(calls).toEqual(["partials", pass, "workspaces"]);
    await vi.advanceTimersByTimeAsync(THREAD_LOG_RETENTION_SWEEP_MS - 1);
    expect(calls).toEqual(["partials", pass, "workspaces"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["partials", pass, "workspaces", pass, "workspaces"]);
  });

  it("still sweeps the logs when the partials fail, and sweeps none without a retention", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const swept: number[] = [];
    let retention: number | null = 7;
    startUpkeep({
      bots: () => [{ id: "bot", tasks: [task("old")] }],
      retentionDays: () => retention,
      busy: () => false,
      openDirectHandoff: () => false,
      cleanupPartials: () => { throw new Error("disk gone"); },
      sweepLogs: (_candidates, days) => { swept.push(days); return 0; },
      workspaceRetention: () => true,
      sweepWorkspaces: () => [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("attachments: startup partial cleanup failed: disk gone");
    expect(swept).toEqual([7]);
    retention = null;
    await vi.advanceTimersByTimeAsync(THREAD_LOG_RETENTION_SWEEP_MS);
    expect(swept).toEqual([7]);
  });

  it("with the switch on, sweeps idle task workspaces even without a log retention, and keeps going when the logs' sweep fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    startUpkeep({
      bots: () => [{ id: "bot", tasks: [task("idle", { createdAt: 5, updatedAt: 10, closedBy: { at: 20 } } as Partial<TaskRecord>), task("working")] }],
      retentionDays: () => 7,
      busy: (_botId, threadId) => threadId === "working",
      openDirectHandoff: () => false,
      cleanupPartials: () => 0,
      sweepLogs: () => { throw new Error("logs gone"); },
      workspaceRetention: () => true,
      sweepWorkspaces: (candidates) => {
        seen.push(...[...candidates].map((c) => `${c.botId}/${c.threadId} ${c.lastActiveAt}${c.busy ? " busy" : ""}`));
        return [];
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("thread event log retention sweep failed: logs gone");
    expect(seen).toEqual(["bot/idle 20", "bot/working 1 busy"]);
  });

  it("starts the cache cap's sweeper, telling it to wait whenever a thread is busy or an engine process lives", () => {
    vi.useFakeTimers();
    let working = "", warm = false;
    let busy: (() => boolean) | null = null;
    startUpkeep({
      bots: () => [{ id: "bot", tasks: [task("a"), task("b")] }], retentionDays: () => null, busy: (_botId, threadId) => threadId === working,
      openDirectHandoff: () => false, cleanupPartials: () => 0, caches: { start: (given) => { busy = given; } }, enginesLive: () => warm,
    });
    expect(busy!()).toBe(false);
    working = "b";
    expect(busy!()).toBe(true);
    working = "";
    warm = true;
    expect(busy!()).toBe(true);
  });
});

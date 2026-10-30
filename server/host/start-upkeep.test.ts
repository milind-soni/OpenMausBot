import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskRecord } from "../store.ts";
import { startUpkeep, THREAD_LOG_RETENTION_SWEEP_MS } from "./start-upkeep.ts";

const task = (threadId: string, extra: Partial<TaskRecord> = {}) => ({ threadId, closedBy: { at: 1 }, archivedAt: null, unread: false, ...extra }) as TaskRecord;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("start-up upkeep", () => {
  it("runs its first pass once the server answers, not before, then the logs' sweep once a day", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    startUpkeep({
      bots: () => [{ id: "bot", tasks: [task("quiet"), task("working"), task("handed", { unread: true })] }],
      retentionDays: () => 30,
      busy: (_botId, threadId) => threadId === "working",
      openDirectHandoff: (threadId) => threadId === "quiet",
      cleanupPartials: () => { calls.push("partials"); return 0; },
      sweepLogs: (candidates, days) => {
        calls.push(`logs ${days}: ${[...candidates].map((c) => `${c.threadId}${c.busy ? " busy" : ""}${c.openDirectHandoff ? " handoff" : ""}${c.unread ? " unread" : ""}`).join(", ")}`);
        return 0;
      },
    });
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    const pass = "logs 30: quiet handoff, working busy, handed unread";
    expect(calls).toEqual(["partials", pass]);
    await vi.advanceTimersByTimeAsync(THREAD_LOG_RETENTION_SWEEP_MS - 1);
    expect(calls).toEqual(["partials", pass]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["partials", pass, pass]);
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
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith("attachments: startup partial cleanup failed: disk gone");
    expect(swept).toEqual([7]);
    retention = null;
    await vi.advanceTimersByTimeAsync(THREAD_LOG_RETENTION_SWEEP_MS);
    expect(swept).toEqual([7]);
  });
});

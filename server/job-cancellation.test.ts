import { describe, expect, it, vi } from "vitest";
import { createJobCancellation, type NativeJobCancellationSnapshot } from "./job-cancellation.ts";

function fixture() {
  let allowed = true;
  let leaf = "leaf-1";
  let receipt: import("../shared/job-cancellation.ts").JobCancellationResult | undefined;
  let native: NativeJobCancellationSnapshot = {
    rootId: "root-1", sourceBotId: "chief", sourceThreadId: "source", generation: "root-1",
    requestMessageId: "request-1", treeVersion: "v1",
    assignments: [
      { id: "root-1", botId: "chief", threadId: "source", status: "waiting", executions: 1 },
      { id: "child-1", botId: "expert", threadId: "work", status: "running", executions: 1, generation: "child-generation" },
    ],
  };
  const stop = vi.fn(async () => {});
  const mark = vi.fn();
  const cancel = vi.fn((id: string, version: string) => {
    if (id !== native.rootId || version !== native.treeVersion) return false;
    native = { ...native, treeVersion: "cancelled", assignments: native.assignments.map(a => ({ ...a, status: "cancelled" })) };
    return true;
  });
  const host = createJobCancellation({
    native: id => id === native.rootId ? structuredClone(native) : undefined,
    authorize: botId => { if (!allowed || botId !== "chief") throw Object.assign(new Error("Chief access required"), { status: 403 }); },
    source: () => ({ activeLeafId: leaf, activeTurnId: "provider-1", executionId: "new-chief-request" }),
    cancelNative: cancel, markCancelled: mark, interruptExact: stop,
    receipt: () => receipt, saveReceipt: (_threadId, _messageId, result) => { receipt = result; },
  });
  return { host, stop, cancel, mark, deny: () => { allowed = false; }, moveLeaf: () => { leaf = "replacement-leaf"; },
    changeTree: () => { native.treeVersion = "replacement"; }, native: () => native,
    markUncertain: () => { native.assignments = native.assignments.map(a => ({ ...a, status: "cancelled", attemptState: "uncertain" })); },
    markCancelledUnfinished: () => { native.assignments = native.assignments.map(a => ({ ...a, status: "cancelled", attemptState: "cancelled", attemptConsumedAt: 1 })); },
    markFailedUncertain: () => { native.assignments = native.assignments.map(a => ({ ...a, status: "failed", attemptState: "uncertain" })); },
    markUnfinished: () => { native.assignments = native.assignments.map(a => ({ ...a, status: "cancelled", attemptState: "consumed" })); } };
}

describe("Chief exact job cancellation", () => {
  it("cancels exactly the owned native tree, including running children, preserving the current Chief command", async () => {
    const f = fixture(), snapshot = f.host.snapshot("chief", "root-1");
    expect(await f.host.cancel("chief", snapshot)).toMatchObject({ state: "cancelled", rootId: "root-1", activeIds: [] });
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith("root-1", "v1", "Cancelled by the person");
    expect(f.mark).toHaveBeenCalledExactlyOnceWith("source", "request-1");
    expect(f.stop.mock.calls).toEqual([
      ["chief", "source", "root-1", "Cancelled by the person"],
      ["expert", "work", "child-generation", "Cancelled by the person"],
    ]);
  });

  it("refuses a replacement tree, a moved branch, and revoked permission without stopping anything", async () => {
    for (const change of ["changeTree", "moveLeaf", "deny"] as const) {
      const f = fixture(), snapshot = f.host.snapshot("chief", "root-1");
      f[change]();
      await expect(f.host.cancel("chief", snapshot)).rejects.toThrow();
      expect(f.cancel).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.mark).not.toHaveBeenCalled();
    }
  });

  it("does not gain ownership by guessing a different Chief or root", () => {
    const f = fixture();
    expect(() => f.host.snapshot("ordinary-bot", "root-1")).toThrow();
    expect(() => f.host.snapshot("chief", "unrelated-root")).toThrow();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("replays cancellation without another stop or report", async () => {
    const f = fixture(), snapshot = f.host.snapshot("chief", "root-1");
    await f.host.cancel("chief", snapshot);
    expect(await f.host.cancel("chief", snapshot)).toMatchObject({ state: "cancelled", alreadyCancelled: true });
    expect(f.cancel).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(2); expect(f.mark).toHaveBeenCalledTimes(1);
  });

  it("reports a local interrupt failure as partial while retaining native results", async () => {
    const f = fixture(), snapshot = f.host.snapshot("chief", "root-1");
    f.stop.mockRejectedValueOnce(new Error("local process stop failed"));
    expect(await f.host.cancel("chief", snapshot)).toMatchObject({ state: "partial", activeIds: ["root-1"], stoppedIds: ["child-1"], errors: ["A local turn could not confirm interruption"] });
    expect(f.native().assignments.every(a => a.status === "cancelled")).toBe(true);
    expect(await f.host.cancel("chief", snapshot)).toMatchObject({ state: "partial", alreadyCancelled: true });
    expect(f.stop).toHaveBeenCalledTimes(2);
  });

  it("never fabricates a stopped job from terminal rows whose process remains uncertain after restart", async () => {
    for (const change of ["markUncertain", "markUnfinished", "markCancelledUnfinished"] as const) {
      const f = fixture(), snapshot = f.host.snapshot("chief", "root-1");
      await f.host.cancel("chief", snapshot);
      f[change]();
      expect(await f.host.cancel("chief", snapshot)).toMatchObject({ state: "partial", activeIds: ["root-1", "child-1"], stoppedIds: [],
        errors: ["A native execution has no confirmed local stop"], alreadyCancelled: true });
      expect(f.stop).toHaveBeenCalledTimes(2);
    }
  });

  it("returns partial uncertainty instead of claiming a failed native job has settled", async () => {
    const f = fixture(), snapshot = f.host.snapshot("chief", "root-1");
    f.markFailedUncertain();
    expect(await f.host.cancel("chief", snapshot)).toMatchObject({ state: "partial", activeIds: ["root-1", "child-1"], stoppedIds: [],
      errors: ["A native execution has no confirmed local stop"] });
    expect(f.stop).not.toHaveBeenCalled();
  });
});

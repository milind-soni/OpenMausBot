import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CaptureLedger, type CaptureReceipt } from "./capture-ledger.ts";
import { CaptureSupervisor, type CaptureSupervisorExecution } from "./capture-supervisor.ts";

const dirs: string[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-capture-supervisor-"));
  dirs.push(dir);
  let now = new Date("2026-08-27T13:00:00.000Z").getTime();
  const ledgerFile = join(dir, "capture.db");
  const supervisorFile = join(dir, "supervisor.db");
  const ledger = new CaptureLedger({ file: ledgerFile, now: () => now });
  return {
    dir,
    ledger,
    supervisorFile,
    setNow: (value: number) => { now = value; },
    now: () => now,
  };
}

function seedCursor(h: ReturnType<typeof harness>, cursor: number): void {
  const run = h.ledger.begin({
    botId: "capture",
    threadId: `seed-${cursor}`,
    kind: "fast",
    scheduledFor: h.now(),
    sources: [{ id: "gmail", required: true }],
  });
  h.ledger.recordSource("capture", run.runId, "gmail", {
    status: "empty",
    cursor: { historyId: String(cursor) },
    itemCount: 0,
  });
  h.ledger.finish("capture", run.runId);
}

function receipt(runId = "run-1"): CaptureReceipt {
  return {
    report: {
      runId,
      kind: "fast",
      scheduledFor: 1,
      status: "completed",
      sourceHealth: [{ sourceId: "gmail", required: true, status: "empty", itemCount: 0 }],
      actionItems: [],
    },
    outbox: null,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CaptureSupervisor", () => {
  it("runs changed work once and suppresses quiet ticks with the same marker", async () => {
    const h = harness();
    seedCursor(h, 1);
    const calls: string[] = [];
    const supervisor = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async ({ strategy }) => {
        calls.push(strategy);
        return { status: "completed", receipt: receipt() };
      },
    });

    await expect(supervisor.reconcileNow()).resolves.toMatchObject({ kind: "completed", changed: true });
    await expect(supervisor.reconcileNow()).resolves.toMatchObject({ kind: "skipped", changed: false });
    expect(calls).toEqual(["normal"]);
    expect(supervisor.health()).toMatchObject({ state: "healthy", pendingWakeups: 0 });
    supervisor.close();
    h.ledger.close();
  });

  it("coalesces push wakeups while one capture is resident", async () => {
    const h = harness();
    seedCursor(h, 1);
    let release: (() => void) | undefined;
    const calls: string[] = [];
    const supervisor = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async ({ strategy }) => {
        calls.push(strategy);
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "completed", receipt: receipt() };
      },
    });

    const first = supervisor.wake("push");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(supervisor.wake("push")).resolves.toMatchObject({ kind: "coalesced" });
    release?.();
    await expect(first).resolves.toMatchObject({ kind: "completed" });
    expect(calls).toEqual(["normal"]);
    expect(supervisor.health().pendingWakeups).toBe(0);
    supervisor.close();
    h.ledger.close();
  });

  it("holds a durable lease so a second resident cannot run concurrently", async () => {
    const h = harness();
    seedCursor(h, 1);
    let release: (() => void) | undefined;
    const options = {
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      leaseMs: 60_000,
      execute: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "completed", receipt: receipt() };
      },
    } satisfies ConstructorParameters<typeof CaptureSupervisor>[0];
    const first = new CaptureSupervisor(options);
    const second = new CaptureSupervisor({ ...options, execute: async () => ({ status: "completed", receipt: receipt("run-2") }) });
    const running = first.reconcileNow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(second.reconcileNow()).resolves.toMatchObject({ kind: "busy" });
    release?.();
    await running;
    first.close();
    second.close();
    h.ledger.close();
  });

  it("permits exactly one explicitly safe changed-strategy retry", async () => {
    const h = harness();
    seedCursor(h, 1);
    const calls: string[] = [];
    const supervisor = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async ({ strategy }): Promise<CaptureSupervisorExecution> => {
        calls.push(strategy);
        return strategy === "normal"
          ? { status: "retryable", reason: "changed strategy is safe" }
          : { status: "completed", receipt: receipt() };
      },
    });

    await expect(supervisor.reconcileNow()).resolves.toMatchObject({ kind: "completed", retried: true });
    expect(calls).toEqual(["normal", "changed"]);
    supervisor.close();
    h.ledger.close();
  });

  it("does not retry a thrown or ambiguous execution", async () => {
    const h = harness();
    seedCursor(h, 1);
    const calls: string[] = [];
    const supervisor = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async ({ strategy }) => {
        calls.push(strategy);
        throw new Error("execution outcome unknown");
      },
    });

    await expect(supervisor.reconcileNow()).resolves.toMatchObject({ kind: "failed" });
    expect(calls).toEqual(["normal"]);
    expect(supervisor.health()).toMatchObject({ state: "degraded", lastError: "execution outcome unknown" });
    supervisor.close();
    h.ledger.close();
  });

  it("recovers an in-flight attempt without replaying it after restart", async () => {
    const h = harness();
    seedCursor(h, 1);
    const first = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async () => new Promise<CaptureSupervisorExecution>(() => undefined),
    });
    const pending = first.reconcileNow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    first.close();

    const calls: string[] = [];
    const restarted = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async ({ strategy }) => {
        calls.push(strategy);
        return { status: "completed", receipt: receipt() };
      },
    });
    await expect(restarted.reconcileNow()).resolves.toMatchObject({ kind: "skipped", changed: false });
    expect(calls).toEqual([]);
    expect(restarted.health()).toMatchObject({ state: "interrupted", interruptedAttempt: true });
    void pending;
    restarted.close();
    h.ledger.close();
  });

  it("runs after a real source marker change following restart", async () => {
    const h = harness();
    seedCursor(h, 1);
    const first = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async () => new Promise<CaptureSupervisorExecution>(() => undefined),
    });
    const pending = first.reconcileNow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    first.close();
    seedCursor(h, 2);

    const calls: string[] = [];
    const restarted = new CaptureSupervisor({
      botId: "capture",
      threadId: "capture-thread",
      sources: [{ id: "gmail", required: true }],
      ledger: h.ledger,
      file: h.supervisorFile,
      now: h.now,
      execute: async ({ strategy }) => {
        calls.push(strategy);
        return { status: "completed", receipt: receipt("run-2") };
      },
    });
    await expect(restarted.reconcileNow()).resolves.toMatchObject({ kind: "completed", changed: true });
    expect(calls).toEqual(["normal"]);
    void pending;
    restarted.close();
    h.ledger.close();
  });
});

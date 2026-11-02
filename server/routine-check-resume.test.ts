import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectedReads } from "./connected-reads.ts";
import { createRoutineChecks } from "./host/routine-checks.ts";
import { createMoveFreeze } from "./move-freeze.ts";
import { RoutineManager, type RoutineCheckResult, type RoutineChecks } from "./routines.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

const MINUTE = 60_000;
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(checks: RoutineChecks) {
  const dir = mkdtempSync(join(tmpdir(), "omb-check-resume-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-29T09:00:00Z");
  let tasks = 0;
  const make = (hook = checks) => {
    const manager = new RoutineManager({
      file: join(dir, "routines.json"), now: () => now, botState: () => "ready", checks: hook,
      createTask: () => ({ threadId: `task-${++tasks}` }), startTurn: async () => {},
    });
    cleanups.push(() => manager.close());
    return manager;
  };
  const manager = make();
  const routine = manager.create({ name: "Mail", prompt: "Check mail", botId: "bot", checks: ["mail"],
    schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 15 * MINUTE, endsAt: now + 16 * MINUTE } });
  return { dir, manager, routine, make, now: () => now, advance: (ms: number) => { now += ms; }, tasks: () => tasks };
}

describe("routine check recovery", () => {
  it.each(["stop", "freeze", "restart"] as const)("rechecks the final due occurrence immediately after %s", async (pause) => {
    const result = deferred<RoutineCheckResult>();
    let calls = 0;
    const hook = { check: () => ++calls === 1 ? result.promise : Promise.resolve({ run: { key: "fresh", prompt: "Fresh mail" } }), release() {}, settled() {} };
    const h = fixture(hook);
    h.advance(15 * MINUTE);
    await h.manager.tick(); await drain();
    const freeze = createMoveFreeze({ dataDir: h.dir });
    freeze.hold(() => h.manager.start(), () => h.manager.stop());
    if (pause === "freeze") freeze.freeze("fixture-cloud");
    else h.manager.stop();
    const before = readFileSync(join(h.dir, "routines.json"), "utf8");
    result.resolve({ run: { key: "stale", prompt: "Old mail" } }); await drain();
    expect(readFileSync(join(h.dir, "routines.json"), "utf8")).toBe(before);
    let resumed = h.manager;
    if (pause === "freeze") freeze.unfreeze();
    else if (pause === "restart") { h.manager.close(); resumed = h.make(); h.advance(2 * MINUTE); resumed.start(); }
    else resumed.start();
    await drain(); await resumed.tick(); await drain();
    expect(h.tasks()).toBe(1);
    expect(calls).toBe(2);
    expect(resumed.listRuns()).toEqual([expect.objectContaining({ status: "running", checkKey: "fresh" })]);
    expect(resumed.listRuns()[0]!.retried).toBeUndefined();
    expect(resumed.listRoutines()[0].nextRunAt).toBeNull();
  });

  it("recovers an orphan ledger release once after a frozen restart before checking mail", async () => {
    const h = fixture({ check: async () => ({}), release() {}, settled() {} });
    h.manager.close();
    const mail = { id: "mail-1", threadId: "mail-thread", at: h.now() - MINUTE, from: "Ada <ada@fixture.test>", subject: "Review", preview: "Please review" };
    const reads: ConnectedReads = {
      connected: async () => ({ gmail: true, googlecalendar: false }),
      session: () => ({ address: async () => "owner@fixture.test", emails: async () => ({ emails: [mail], more: false }),
        events: async () => [], message: async () => null, thread: async () => [] }),
    };
    const options = { dataDir: h.dir, now: h.now, reads, mayRead: () => true, fenced: () => true,
      timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report() {} };
    let ledger = createRoutineChecks(options);
    const gate = deferred<void>();
    const first = h.make({ ...ledger, async check(routine, context) {
      const found = await ledger.check(routine, context); await gate.promise; return found;
    } });
    first.runNow(h.routine.id); await first.tick(); await drain();
    const orphan = ledger.pendingKeys()[0]!;
    expect(orphan).toBeDefined();
    first.stop(); gate.resolve(); await drain(); first.close();
    ledger = createRoutineChecks(options);
    const releases: string[] = [];
    const second = h.make({ ...ledger, release(key) { releases.push(key); ledger.release(key); } });
    const freeze = createMoveFreeze({ dataDir: h.dir });
    second.stop();
    freeze.freeze("fixture-cloud");
    freeze.hold(() => second.start(), () => second.stop());
    const before = readFileSync(join(h.dir, "routine-checks.json"), "utf8");
    await second.tick(); await drain();
    expect(readFileSync(join(h.dir, "routine-checks.json"), "utf8")).toBe(before);
    expect(releases).toEqual([]);
    freeze.unfreeze(); await drain(); await second.tick(); await drain();
    expect(h.tasks()).toBe(1);
    expect(releases).toEqual([orphan]);
    expect(second.listRuns()[0]).toMatchObject({ status: "running", prompt: expect.stringContaining("mail-1") });
    second.stop(); second.start(); await drain(); second.stop(); second.start(); await drain();
    expect(releases).toEqual([orphan]);
    expect(ledger.pendingKeys()).toEqual([second.listRuns()[0]!.checkKey]);
  });

  it.each(["manual", "scheduled"] as const)("bounds a hung %s check and fences its late result during backup", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = deferred<RoutineCheckResult>();
    let signal: AbortSignal | undefined;
    const h = fixture({ check: (_routine, context) => { signal = context.signal; return gate.promise; }, release() {}, settled() {} });
    if (mode === "manual") h.manager.runNow(h.routine.id);
    else h.advance(15 * MINUTE);
    await h.manager.tick(); await drain();
    const backup = new WorkspaceBackupMaintenance();
    const hooks = { idle: () => !h.manager.isTicking, pause: () => h.manager.stop(), resume: () => h.manager.start(), flush: async () => {} };
    await expect(backup.run(async () => "backup", hooks)).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(5 * MINUTE); await drain();
    expect(h.manager.isTicking).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(h.manager.listRoutines()[0].checkTrouble).toMatch(/timed out/i);
    if (mode === "manual") expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/timed out/i) });
    const before = readFileSync(join(h.dir, "routines.json"), "utf8");
    await expect(backup.run(async () => {
      gate.resolve({ run: { key: "late", prompt: "Late result" } }); await drain();
      expect(readFileSync(join(h.dir, "routines.json"), "utf8")).toBe(before);
      expect(h.tasks()).toBe(0);
      return "backup";
    }, hooks)).resolves.toBe("backup");
  });

  it.each(["report", "delivery"] as const)("recovers a hung %s ledger after resuming before the deadline", async (hang) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = fixture({ check: async () => ({}), release() {}, settled() {} }); h.manager.close();
    const gate = deferred<void>();
    let reports = 0;
    const reads: ConnectedReads = { connected: async () => ({ gmail: true, googlecalendar: false }), session: () => ({
      address: async () => "owner@fixture.test", events: async () => [], message: async () => null, thread: async () => [],
      emails: async () => ({ emails: [{ id: "held-mail", threadId: "t", at: h.now() - MINUTE,
        from: "Ada <ada@fixture.test>", subject: "Review", preview: "Please review" }], more: false }),
    }) };
    const checks = createRoutineChecks({ dataDir: h.dir, reads, now: h.now, mayRead: () => true, fenced: () => true,
      timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report: () => hang === "report" && ++reports === 1 ? gate.promise : undefined });
    let calls = 0;
    const released: string[] = [];
    const manager = h.make({ ...checks, async check(routine, context) {
      const result = await checks.check(routine, context);
      if (hang === "delivery" && ++calls === 1) await gate.promise;
      return result;
    }, release(key) { released.push(key); checks.release(key); } });
    manager.update(h.routine.id, { deliver: "brief" }); manager.runNow(h.routine.id);
    await manager.tick(); await drain();
    const orphan = checks.pendingKeys()[0]!;
    expect(orphan).toBeDefined();
    manager.stop(); manager.start(); await drain();
    await vi.advanceTimersByTimeAsync(40 * MINUTE); await drain();
    expect(manager.isTicking).toBe(false);
    await manager.tick(); await drain(); await manager.tick(); await drain();
    expect(released).toEqual([orphan]);
    expect(h.tasks()).toBe(1);
    expect(manager.listRuns()[0]).toMatchObject({ status: "running", prompt: expect.stringContaining("held-mail") });
    const before = readFileSync(join(h.dir, "routine-checks.json"), "utf8");
    gate.resolve(); await drain();
    expect(readFileSync(join(h.dir, "routine-checks.json"), "utf8")).toBe(before);
    expect(released).toEqual([orphan]);
  });

  it("cancels a connected read without late ledger or report writes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = fixture({ check: async () => ({}), release() {}, settled() {} }); h.manager.close();
    const gate = deferred<{ emails: []; more: boolean }>();
    let reports = 0;
    const reads: ConnectedReads = { connected: async () => ({ gmail: true, googlecalendar: false }), session: () => ({
      address: async () => "owner@fixture.test", emails: () => gate.promise, events: async () => [], message: async () => null, thread: async () => [],
    }) };
    const checks = createRoutineChecks({ dataDir: h.dir, reads, now: h.now, mayRead: () => true, fenced: () => true,
      timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report() { reports++; } });
    const manager = h.make(checks);
    manager.update(h.routine.id, { deliver: "brief" }); manager.runNow(h.routine.id);
    await manager.tick(); await drain();
    await vi.advanceTimersByTimeAsync(40 * MINUTE); await drain();
    expect(manager.isTicking).toBe(false);
    const backup = new WorkspaceBackupMaintenance();
    await backup.run(async () => {
      const before = readFileSync(join(h.dir, "routines.json"), "utf8");
      gate.resolve({ emails: [], more: false }); await drain();
      expect(readFileSync(join(h.dir, "routines.json"), "utf8")).toBe(before);
      expect(checks.pendingKeys()).toEqual([]);
      expect(reports).toBe(0);
    }, { idle: () => !manager.isTicking, pause: () => manager.stop(), resume: () => manager.start(), flush: async () => {} });
  });

  it.each(["hung", "completed"] as const)("finishes a %s check while a hung drain stays busy and blocks backup", async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = deferred<RoutineCheckResult>(), writes = deferred<void>();
    let calls = 0;
    const released: string[] = [];
    if (state === "completed") work.resolve({ run: { key: "discarded", prompt: "Mail" } });
    const h = fixture({ check: () => { calls++; return work.promise; }, drain: () => writes.promise, release: (key) => { released.push(key); }, settled() {} });
    h.manager.runNow(h.routine.id); await h.manager.tick(); await drain();
    try {
      await vi.advanceTimersByTimeAsync(5 * MINUTE); await drain();
      expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/still draining/i) });
      expect(h.manager.listRoutines()[0].checkTrouble).toMatch(/still draining/i);
      expect(h.manager.isTicking).toBe(true);
      expect(released).toEqual(state === "completed" ? ["discarded"] : []);
      const backup = new WorkspaceBackupMaintenance();
      const hooks = { idle: () => !h.manager.isTicking, pause: () => h.manager.stop(), resume() {}, flush: async () => {} };
      await expect(backup.run(async () => "backup", hooks)).rejects.toMatchObject({ status: 409 });
      h.advance(15 * MINUTE); await h.manager.tick(); await drain();
      expect(calls).toBe(1);
      writes.resolve(); await drain();
      expect(h.manager.isTicking).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await backup.run(async () => {
        const before = readFileSync(join(h.dir, "routines.json"), "utf8");
        work.resolve({ run: { key: "late", prompt: "Late mail" } }); await drain();
        expect(readFileSync(join(h.dir, "routines.json"), "utf8")).toBe(before);
        expect(h.tasks()).toBe(0);
      }, hooks);
    } finally { work.resolve({}); writes.resolve(); await drain(); }
  });

  it("waits for a normal drain before delivering a check and clears both deadlines", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writes = deferred<void>();
    const h = fixture({ check: async () => ({ run: { key: "kept", prompt: "Mail" } }), drain: () => writes.promise, release() {}, settled() {} });
    try {
      h.manager.runNow(h.routine.id); await h.manager.tick(); await drain();
      expect(h.manager.listRuns()[0].status).toBe("queued");
      expect(h.manager.isTicking).toBe(true);
      expect(h.tasks()).toBe(0);
      writes.resolve(); await drain();
      expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", checkKey: "kept" });
      expect(h.manager.isTicking).toBe(false);
      expect(h.tasks()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { writes.resolve(); await drain(); }
  });

});

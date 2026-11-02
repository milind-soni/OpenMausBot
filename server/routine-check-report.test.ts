import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarEvent, ConnectedReads } from "./connected-reads.ts";
import { CHECKS_FILE, createRoutineChecks } from "./host/routine-checks.ts";
import { createMoveFreeze } from "./move-freeze.ts";
import { RoutineManager } from "./routines.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

const MINUTE = 60_000;
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.useRealTimers(); });

function fixture(report: () => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "omb-check-report-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-10-29T09:00:00Z");
  const mail = { id: "held-mail", threadId: "mail-thread", at: now - MINUTE,
    from: "Ada <ada@fixture.test>", subject: "Review", preview: "Please review" };
  const meeting: CalendarEvent = { id: "held-meeting", title: "Review meeting", start: now + 30 * MINUTE, end: now + 60 * MINUTE,
    allDay: false, status: "confirmed", selfDeclined: false, ownedCalendar: true,
    attendees: [{ email: "owner@fixture.test", self: true, organizer: true }, { email: "ada@fixture.test", self: false, organizer: false }] };
  const reads: ConnectedReads = { connected: async () => ({ gmail: true, googlecalendar: true }), session: () => ({
    address: async () => "owner@fixture.test", emails: async () => ({ emails: [mail], more: false }),
    events: async () => [meeting], message: async () => null, thread: async () => [],
  }) };
  const options = { dataDir: dir, reads, now: () => now, mayRead: () => true, fenced: () => true,
    timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report };
  const checks = createRoutineChecks(options);
  const releases: string[] = [];
  const make = (ledger = checks) => {
    const manager = new RoutineManager({ file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
      checks: { ...ledger, release(key) { releases.push(key); ledger.release(key); } },
      createTask: () => ({ threadId: "fixture-thread" }), startTurn: async () => {},
    });
    cleanups.push(() => manager.close());
    return manager;
  };
  const manager = make();
  const routine = manager.create({ name: "Day", prompt: "Check my day", botId: "bot", checks: ["mail", "calendar"], deliver: "brief",
    schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 15 * MINUTE } });
  const file = join(dir, CHECKS_FILE);
  return { dir, file, checks, releases, manager, routine, make, options,
    async begin() { manager.runNow(routine.id); await manager.tick(); await drain(); },
    assertItems(key: string) { expect(checks.items(key)).toMatchObject({ mail: [{ id: "held-mail" }], prep: [{ event: { title: "Review meeting" } }] }); },
  };
}

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("routine allocations while reporting", () => {
  it.each(["sync", "async"] as const)("releases items immediately when a report fails (%s)", async (mode) => {
    let reports = 0;
    const h = fixture(() => {
      if (++reports !== 1) return;
      if (mode === "sync") throw new Error("fixture report failed");
      return Promise.reject(new Error("fixture report failed"));
    });
    await h.begin();
    expect(h.checks.pendingKeys()).toEqual([]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed" });
    expect(h.releases).toHaveLength(1);
    expect(h.checks.items(h.releases[0]!)).toBeNull();
    const entry = JSON.parse(readFileSync(h.file, "utf8")).routines[h.routine.id];
    expect(Object.values(entry.meetings)).toEqual([expect.not.objectContaining({ prepStartedAt: expect.any(Number) })]);
    h.manager.runNow(h.routine.id); await h.manager.tick(); await drain();
    const run = h.manager.listRuns().find((run) => run.status === "running")!;
    h.assertItems(run.checkKey!);
  });

  it("releases a deadline's hidden allocation before the next scheduler tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const report = gate();
    let reports = 0;
    const h = fixture(() => ++reports === 1 ? report.promise : undefined);
    await h.begin();
    const key = h.checks.pendingKeys()[0]!; h.assertItems(key);
    await vi.advanceTimersByTimeAsync(h.checks.timeoutMs!); await drain();
    expect(h.manager.isTicking).toBe(false);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/timed out/i) });
    expect(h.checks.pendingKeys()).toEqual([]);
    expect(h.releases).toEqual([key]);
    const before = readFileSync(h.file, "utf8");
    report.resolve(); await drain();
    expect(readFileSync(h.file, "utf8")).toBe(before);
    expect(h.releases).toEqual([key]);
  });

  it.each(["report failure", "deadline"] as const)("releases before rechecking a newer definition after %s", async (cause) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const report = gate();
    let reports = 0;
    const h = fixture(() => ++reports === 1 ? report.promise : undefined);
    await h.begin();
    const key = h.checks.pendingKeys()[0]!;
    h.manager.update(h.routine.id, { prompt: "Use the new instructions" });
    if (cause === "deadline") await vi.advanceTimersByTimeAsync(h.checks.timeoutMs!);
    else report.reject(new Error("fixture report failed"));
    await drain(); await h.manager.tick(); await drain();
    const run = h.manager.listRuns()[0]!;
    expect(run).toMatchObject({ status: "running", prompt: expect.stringContaining("Use the new instructions") });
    h.assertItems(run.checkKey!);
    expect(h.releases).toEqual([key]);
    expect(h.checks.pendingKeys()).toEqual([run.checkKey]);
    const before = readFileSync(h.file, "utf8");
    report.resolve(); await drain();
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it.each(["stop", "backup", "move", "close"] as const)("keeps ledger writes fenced through %s and recovers once on start", async (cause) => {
    const report = gate();
    let reports = 0;
    const h = fixture(() => ++reports === 1 ? report.promise : undefined);
    await h.begin();
    const key = h.checks.pendingKeys()[0]!; h.assertItems(key);
    const before = readFileSync(h.file, "utf8");
    const receipts = readFileSync(join(h.dir, "routines.json"), "utf8");
    const whilePaused = async () => {
      await drain();
      expect(h.manager.isTicking).toBe(false);
      expect(h.releases).toEqual([]);
      expect(readFileSync(h.file, "utf8")).toBe(before);
      expect(h.checks.pendingKeys()).toEqual([key]);
      report.resolve(); await drain();
      expect(readFileSync(h.file, "utf8")).toBe(before);
      expect(readFileSync(join(h.dir, "routines.json"), "utf8")).toBe(receipts);
      expect(h.releases).toEqual([]);
    };
    if (cause === "backup") {
      const backup = new WorkspaceBackupMaintenance();
      h.manager.stop(); await drain();
      await backup.run(whilePaused, { idle: () => !h.manager.isTicking, pause: () => h.manager.stop(),
        resume: () => h.manager.start(), flush: async () => {} });
    } else if (cause === "move") {
      const freeze = createMoveFreeze({ dataDir: h.dir });
      freeze.hold(() => h.manager.start(), () => h.manager.stop());
      freeze.freeze("fixture-cloud"); await whilePaused(); freeze.unfreeze();
    } else {
      if (cause === "close") h.manager.close(); else h.manager.stop();
      await whilePaused();
      if (cause === "close") {
        const reloaded = createRoutineChecks(h.options);
        const restarted = h.make(reloaded);
        restarted.start(); await drain(); await restarted.tick(); await drain();
        expect(reloaded.pendingKeys()).toEqual([restarted.listRuns()[0]!.checkKey]);
      } else h.manager.start();
    }
    await drain(); await h.manager.tick(); await drain();
    expect(h.releases).toEqual([key]);
    if (cause !== "close") h.assertItems(h.manager.listRuns()[0]!.checkKey!);
  });
});

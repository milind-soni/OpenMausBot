import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMoveFreeze } from "./move-freeze.ts";
import { RoutineManager, type RoutineCheckResult } from "./routines.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

const MINUTE = 60_000;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(mode: "manual" | "scheduled", result: RoutineCheckResult) {
  const dir = mkdtempSync(join(tmpdir(), "omb-check-pause-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-29T09:00:00Z");
  let resolve!: (result: RoutineCheckResult) => void;
  const pending = new Promise<RoutineCheckResult>((done) => { resolve = done; });
  let checks = 0;
  let tasks = 0;
  const released: string[] = [];
  const gate = new WorkspaceBackupMaintenance();
  const file = join(dir, "routines.json");
  const manager = new RoutineManager({
    file, now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++tasks}` }),
    startTurn: async () => { gate.assertAvailable(); },
    checks: {
      check: () => ++checks === 1 ? pending : Promise.resolve({ run: { key: "fresh", prompt: "Fresh check" } }),
      release: (key) => released.push(key), settled() {},
    },
  });
  cleanup.push(() => manager.close());
  const routine = manager.create({
    name: "Check mail", prompt: "Read mail", botId: "test-bot", checks: ["mail"],
    schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 15 * MINUTE },
  });
  const freeze = createMoveFreeze({ dataDir: dir });
  freeze.hold(() => manager.start(), () => manager.stop());
  return {
    manager, gate, freeze, file, released,
    async begin() {
      if (mode === "manual") manager.runNow(routine.id);
      else now += 15 * MINUTE;
      await manager.tick();
      await drain();
      expect(checks).toBe(1);
    },
    async finish() { resolve(result); await drain(); },
    async next() { if (mode === "scheduled") now += 15 * MINUTE; await manager.tick(); await drain(); },
    tasks: () => tasks,
  };
}

describe("routine checks across scheduler pauses", () => {
  it.each(["manual", "scheduled"] as const)("a pending %s check keeps backup maintenance busy", async (mode) => {
    const h = fixture(mode, {});
    await h.begin();
    const hooks = {
      idle: () => !h.manager.isTicking && h.manager.listRuns().every((run) => !["running", "waiting"].includes(run.status)),
      pause: () => h.manager.stop(), resume: () => h.manager.start(), flush: async () => {},
    };
    try {
      await expect(h.gate.run(async () => "backup", hooks)).rejects.toMatchObject({ status: 409 });
    } finally { await h.finish(); }
    expect(h.manager.isTicking).toBe(false);
    await expect(h.gate.run(async () => "backup", hooks)).resolves.toBe("backup");
  });

  it.each(["manual", "scheduled"] as const)("a stopped %s check cannot mutate a backup or consume its retry", async (mode) => {
    const h = fixture(mode, { run: { key: "late", prompt: "Late check" } });
    await h.begin();
    const before = readFileSync(h.file, "utf8");
    await h.gate.run(async () => {
      await h.finish();
      expect(readFileSync(h.file, "utf8")).toBe(before);
      expect(h.tasks()).toBe(0);
      expect(h.manager.listRuns().every((run) => run.retried === undefined)).toBe(true);
    }, { idle: () => true, pause: () => h.manager.stop(), resume: () => h.manager.start(), flush: async () => {} });
    await h.next();
    expect(h.manager.listRuns()).toEqual([expect.objectContaining({ status: "running", checkKey: "fresh" })]);
  });

  for (const mode of ["manual", "scheduled"] as const) {
    for (const pause of ["stop", "freeze", "resume-before-result"] as const) {
      it.each([
        ["run", { run: { key: "late", prompt: "Late check" } }],
        ["trouble", { trouble: "Late failure", wakeAt: 1 }],
        ["quiet", {}],
      ] as Array<[string, RoutineCheckResult]>)(`drops a late %s ${mode} result after ${pause} without writes or retry consumption`, async (_name, result) => {
        const h = fixture(mode, result);
        await h.begin();
        if (pause === "freeze") h.freeze.freeze("fixture-cloud");
        else h.manager.stop();
        const before = readFileSync(h.file, "utf8");
        const runs = h.manager.listRuns();
        if (pause === "resume-before-result") h.manager.start();
        await h.finish();
        expect(readFileSync(h.file, "utf8")).toBe(before);
        expect(h.manager.listRuns()).toEqual(runs);
        expect(h.tasks()).toBe(0);
        expect(h.released).toEqual(pause === "resume-before-result" && result.run ? ["late"] : []);
        expect(h.manager.isTicking).toBe(false);
        if (pause !== "resume-before-result") {
          await h.manager.tick();
          expect(readFileSync(h.file, "utf8")).toBe(before);
        }
        if (pause === "freeze") h.freeze.unfreeze();
        else h.manager.start();
        await h.next();
        expect(h.released).toEqual(result.run ? ["late"] : []);
        expect(h.manager.listRuns().filter((run) => run.checkKey === "fresh")).toEqual([
          expect.objectContaining({ status: "running" }),
        ]);
        expect(h.manager.listRuns().every((run) => run.retried === undefined)).toBe(true);
      });
    }
  }
});

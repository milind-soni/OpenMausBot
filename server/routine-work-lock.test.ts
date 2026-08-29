import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Routine } from "./routines.ts";
import { synchronizeRoutineWorkLock } from "./routine-work-lock.ts";
import { WorkLockStore } from "./work-lock-store.ts";

const NOW = 1_800_000_000_000;

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    name: "Lock the launch date",
    prompt: "Check the calendar, prepare the exact decision, and ask only if needed.",
    botId: "chief",
    runOn: "maus",
    enabled: true,
    schedule: { type: "once", at: NOW + 60_000 },
    durationMinutes: 30,
    maxChangedStrategyRetries: 1,
    nextRunAt: NOW + 60_000,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function store(): WorkLockStore {
  const directory = mkdtempSync(join(tmpdir(), "routine-work-lock-"));
  return new WorkLockStore({ file: join(directory, "work.db"), now: () => NOW });
}

describe("synchronizeRoutineWorkLock", () => {
  it("links a future one-time routine to one durable obligation", () => {
    const workLocks = store();
    const first = synchronizeRoutineWorkLock(routine(), workLocks, { now: NOW, ownerLabel: "Chief" });
    expect(first.kind).toBe("linked");
    if (first.kind !== "linked") throw new Error("expected a link");

    const linkedRoutine = routine({ workLockId: first.workLockId, updatedAt: NOW });
    const second = synchronizeRoutineWorkLock(linkedRoutine, workLocks, { now: NOW });
    expect(second).toEqual({ kind: "unchanged", workLockId: first.workLockId });

    const obligation = workLocks.getObligation(first.workLockId);
    expect(obligation).toMatchObject({
      title: "Lock the launch date",
      owner: { id: "chief", label: "Chief" },
      status: "open",
      deadlines: [{ key: "scheduled-run", dueAt: NOW + 60_000, status: "active" }],
    });
    workLocks.close();
  });

  it("retires a managed lock when its one-time schedule changes", () => {
    const workLocks = store();
    const first = synchronizeRoutineWorkLock(routine(), workLocks, { now: NOW });
    if (first.kind !== "linked") throw new Error("expected a link");

    const changed = routine({
      schedule: { type: "once", at: NOW + 120_000 },
      nextRunAt: NOW + 120_000,
      updatedAt: NOW + 1,
      workLockId: first.workLockId,
    });
    const second = synchronizeRoutineWorkLock(changed, workLocks, { now: NOW });
    expect(second.kind).toBe("linked");
    if (second.kind !== "linked") throw new Error("expected a replacement link");
    expect(second.workLockId).not.toBe(first.workLockId);
    expect(workLocks.getObligation(first.workLockId)?.status).toBe("cancelled");
    expect(workLocks.getObligation(second.workLockId)?.deadlines[0]?.dueAt).toBe(NOW + 120_000);
    workLocks.close();
  });

  it("clears managed work when a routine is disabled without touching explicit links", () => {
    const workLocks = store();
    const first = synchronizeRoutineWorkLock(routine(), workLocks, { now: NOW });
    if (first.kind !== "linked") throw new Error("expected a link");
    expect(synchronizeRoutineWorkLock(routine({ enabled: false, workLockId: first.workLockId }), workLocks, { now: NOW }))
      .toEqual({ kind: "cleared" });
    expect(workLocks.getObligation(first.workLockId)?.status).toBe("cancelled");

    const explicit = workLocks.createObligation({ title: "User-owned work", source: "user", externalId: "x" });
    const explicitRoutine = routine({ enabled: false, workLockId: explicit.obligation.id });
    expect(synchronizeRoutineWorkLock(explicitRoutine, workLocks, { now: NOW }))
      .toEqual({ kind: "unchanged", workLockId: explicit.obligation.id });
    expect(workLocks.getObligation(explicit.obligation.id)?.status).toBe("open");
    workLocks.close();
  });

  it("does not turn recurring or expired automation into fake obligations", () => {
    const workLocks = store();
    expect(synchronizeRoutineWorkLock(routine({ schedule: { type: "daily", time: "08:00", weekdays: [1] } }), workLocks, { now: NOW }))
      .toEqual({ kind: "unchanged" });
    expect(synchronizeRoutineWorkLock(routine({ schedule: { type: "once", at: NOW - 1 }, nextRunAt: null }), workLocks, { now: NOW }))
      .toEqual({ kind: "unchanged" });
    expect(workLocks.listOpenWork().obligations).toHaveLength(0);
    workLocks.close();
  });
});

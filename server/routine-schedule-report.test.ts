import { describe, expect, it } from "vitest";

import type { Occurrence } from "./routine-ledger.ts";
import { dayCounts, scheduleSection } from "./routine-schedule-report.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-16T08:00:00Z");
const NONE = { ran: 0, failed: 0, missed: 0, late: 0, retried: 0 };
const record = (dueAt: number, state: Occurrence["state"], more: Partial<Occurrence> = {}): Occurrence => ({
  routineId: "routine-1", dueAt, state, attempts: state === "ran" || state === "failed" || state === "running" ? 1 : 0, madeAt: dueAt, runIds: ["run"],
  ...(state === "ran" || state === "failed" || state === "running" ? { startedAt: dueAt + 1_000 } : {}), ...(state === "queued" || state === "running" ? {} : { endedAt: dueAt + MINUTE }), ...more,
});
const section = (records: Occurrence[], next: Array<{ at: number; paused: boolean }> = [], more: Record<string, unknown> = {}) =>
  scheduleSection({ seq: 41, unreadable: false, slowStops: 0, next, records, boot: NONE, now: NOW, ...more });

describe("the schedule section", () => {
  it("is exactly the contract's fields", () => {
    expect(section([record(NOW - HOUR, "ran")], [{ at: NOW + HOUR, paused: false }])).toEqual({
      v: 1, seq: 41, unreadable: false, nextDueAt: NOW + HOUR, oldestUnconfirmed: null,
      lastConfirmed: { dueAt: NOW - HOUR, startedAt: NOW - HOUR + 1_000, state: "ran" },
      due: { boot: NONE, day: { ...NONE, ran: 1 } }, slowStops: 0,
    });
    expect(section([])).toMatchObject({ nextDueAt: null, oldestUnconfirmed: null, lastConfirmed: null });
  });

  it("names the earliest occurrence that has not started, whether or not it has a row, and never hides it behind a run", () => {
    const records = [record(NOW - 3 * HOUR, "running"), record(NOW - 2 * HOUR, "queued", { madeAt: NOW - 2 * HOUR + 300 }), record(NOW - HOUR, "queued")];
    expect(section(records)).toMatchObject({ oldestUnconfirmed: { dueAt: NOW - 2 * HOUR, state: "queued", since: NOW - 2 * HOUR + 300 }, lastConfirmed: { dueAt: NOW - 3 * HOUR, state: "running" } });
    expect(section(records, [{ at: NOW - 4 * HOUR, paused: false }, { at: NOW + HOUR, paused: false }]))
      .toMatchObject({ nextDueAt: NOW - 4 * HOUR, oldestUnconfirmed: { dueAt: NOW - 4 * HOUR, state: "due", since: NOW - 4 * HOUR } });
    expect(section([], [{ at: NOW, paused: false }])).toMatchObject({ nextDueAt: NOW, oldestUnconfirmed: { dueAt: NOW, state: "due" } });
  });

  it("leaves a paused bot's routine out of the next due time, but not out of what has not started", () => {
    expect(section([], [{ at: NOW - HOUR, paused: true }, { at: NOW + HOUR, paused: false }])).toMatchObject({ nextDueAt: NOW + HOUR, oldestUnconfirmed: { dueAt: NOW - HOUR, state: "due" } });
    expect(section([], [{ at: NOW + HOUR, paused: true }]).nextDueAt).toBeNull();
  });

  it("takes the newest decided occurrence by the last time its record stands for, with no start time for one closed unstarted", () => {
    const counted = record(NOW - 5 * HOUR, "skipped", { count: 4, lastAt: NOW - 2 * HOUR });
    expect(section([record(NOW - 3 * HOUR, "ran"), counted]).lastConfirmed).toEqual({ dueAt: NOW - 2 * HOUR, startedAt: null, state: "skipped" });
    expect(section([record(NOW - 3 * HOUR, "missed"), record(NOW - 4 * HOUR, "failed")]).lastConfirmed).toEqual({ dueAt: NOW - 3 * HOUR, startedAt: null, state: "missed" });
    expect(section([record(NOW - HOUR, "failed", { startedAt: undefined })]).lastConfirmed).toEqual({ dueAt: NOW - HOUR, startedAt: NOW - HOUR + MINUTE, state: "failed" });
  });

  it("says nothing is known while the saved routines cannot be read", () => {
    expect(section([record(NOW - HOUR, "ran")], [{ at: NOW - HOUR, paused: false }], { unreadable: true, slowStops: 3, boot: { ...NONE, ran: 2 } })).toEqual({
      v: 1, seq: 41, unreadable: true, nextDueAt: null, oldestUnconfirmed: null, lastConfirmed: null, due: { boot: { ...NONE, ran: 2 }, day: NONE }, slowStops: 3,
    });
  });

  it("keeps every number whole and within the contract's range", () => {
    const wild = section([], [], { seq: 2e15, slowStops: -4, boot: { ran: 5e9, failed: 1.6, missed: Number.NaN, late: -1, retried: Infinity } });
    expect(wild).toMatchObject({ seq: 1e15, slowStops: 0, due: { boot: { ran: 1e9, failed: 2, missed: 0, late: 0, retried: 0 } } });
  });
});

describe("the last day's counts", () => {
  it("come from the records: what ended in the day, what started late in it, and the starts after the first", () => {
    const records = [
      record(NOW - 2 * HOUR, "ran"), record(NOW - 3 * HOUR, "ran", { startedAt: NOW - 3 * HOUR + 6 * MINUTE }), record(NOW - 4 * HOUR, "failed", { attempts: 2 }),
      record(NOW - 5 * HOUR, "missed"), record(NOW - 6 * HOUR, "skipped"), record(NOW - 7 * HOUR, "running", { attempts: 3, startedAt: NOW - 7 * HOUR + 5 * MINUTE }),
      record(NOW - 8 * HOUR, "queued"), record(NOW - 30 * HOUR, "ran"), record(NOW - 30 * HOUR, "failed", { attempts: 2 }), record(NOW - 30 * HOUR, "missed"),
    ];
    expect(dayCounts(records, NOW)).toEqual({ ran: 2, failed: 1, missed: 2, late: 1, retried: 3 });
  });

  it("take from a record that counts a span of occurrences the share that fell in the day", () => {
    expect(dayCounts([record(NOW - 2 * DAY, "skipped", { count: 48, lastAt: NOW, endedAt: NOW })], NOW).missed).toBe(24);
    expect(dayCounts([record(NOW - 3 * HOUR, "missed", { count: 3, lastAt: NOW - HOUR, endedAt: NOW })], NOW).missed).toBe(3);
    expect(dayCounts([record(NOW - 3 * DAY, "missed", { count: 3, lastAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY })], NOW).missed).toBe(0);
  });
});

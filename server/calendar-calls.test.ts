import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CalendarCallManager, type CalendarCallInput } from "./calendar-calls.ts";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-calendar-calls-"));
  dirs.push(dir);
  return join(dir, "calendar-calls.json");
}

function input(overrides: Partial<CalendarCallInput> = {}): CalendarCallInput {
  return {
    name: "Planning call",
    description: "Review the launch plan",
    botIds: ["researcher", "writer"],
    schedule: { type: "once", at: new Date(2026, 8, 1, 10, 30).getTime() },
    durationMinutes: 45,
    attachments: [{
      id: "brief",
      name: "Launch brief.pdf",
      path: "/safe/local/Launch brief.pdf",
      size: 4_096,
      kind: "file",
    }],
    ...overrides,
  };
}

function manager(file = tempFile(), now = 1_700_000_000_000): CalendarCallManager {
  return new CalendarCallManager({
    file,
    now: () => now,
    botExists: (botId) => ["researcher", "writer", "chief"].includes(botId),
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CalendarCallManager", () => {
  it("persists calls and returns defensive copies", () => {
    const file = tempFile();
    const calls = manager(file);
    const created = calls.create(input());
    created.botIds.push("chief");
    created.attachments[0]!.name = "changed";

    expect(calls.list()[0]).toMatchObject({
      name: "Planning call",
      botIds: ["researcher", "writer"],
      attachments: [{ name: "Launch brief.pdf" }],
    });
    expect(manager(file).list()[0]).toMatchObject({
      id: created.id,
      description: "Review the launch plan",
      durationMinutes: 45,
      attachments: [{ path: "/safe/local/Launch brief.pdf", kind: "file" }],
    });
  });

  it("validates participants, schedules, duration, and attachments", () => {
    const calls = manager();
    expect(() => calls.create(input({ botIds: [] }))).toThrow(/at least one bot/i);
    expect(() => calls.create(input({ botIds: ["missing"] }))).toThrow(/no longer exist/i);
    expect(() => calls.create(input({ durationMinutes: 10 }))).toThrow(/15 and 240/);
    expect(() => calls.create(input({
      schedule: { type: "daily", time: "25:00", weekdays: [1] },
    }))).toThrow(/valid call schedule/i);
    expect(() => calls.create(input({
      attachments: [{ id: "bad", name: "Bad", path: "bad\0path", size: 1, kind: "file" }],
    }))).toThrow(/valid attachment/i);
    expect(calls.list()).toEqual([]);
  });

  it("normalizes and preserves selected-weekday recurrence data", () => {
    const file = tempFile();
    const calls = manager(file, 100);
    const created = calls.create(input({
      botIds: ["writer", "researcher", "writer"],
      schedule: { type: "daily", time: "09:15", weekdays: [5, 1, 5, 3] },
    }));
    expect(created.botIds).toEqual(["writer", "researcher"]);
    expect(created.schedule).toEqual({ type: "daily", time: "09:15", weekdays: [1, 3, 5] });

    const updated = calls.update(created.id, {
      schedule: { type: "daily", time: "14:45", weekdays: [2, 4] },
      botIds: ["chief"],
    });
    expect(updated).toMatchObject({
      botIds: ["chief"],
      schedule: { type: "daily", time: "14:45", weekdays: [2, 4] },
      createdAt: 100,
      updatedAt: 100,
    });
    expect(manager(file).list()[0]!.schedule).toEqual({
      type: "daily",
      time: "14:45",
      weekdays: [2, 4],
    });
  });

  it("deletes a call durably and reports missing entries", () => {
    const file = tempFile();
    const calls = manager(file);
    const created = calls.create(input());
    expect(calls.remove("missing")).toBe(false);
    expect(calls.remove(created.id)).toBe(true);
    expect(calls.list()).toEqual([]);
    expect(manager(file).list()).toEqual([]);
  });

  it("removes a deleted bot from calls and drops empty calls durably", () => {
    const file = tempFile();
    const calls = manager(file, 100);
    const shared = calls.create(input());
    calls.create(input({ name: "Researcher solo", botIds: ["researcher"] }));

    expect(calls.removeBot("missing")).toBe(0);
    expect(calls.removeBot("researcher")).toBe(2);
    expect(calls.list()).toEqual([
      expect.objectContaining({ id: shared.id, botIds: ["writer"], updatedAt: 100 }),
    ]);

    const reloaded = manager(file, 200);
    expect(reloaded.list()).toEqual([
      expect.objectContaining({ id: shared.id, botIds: ["writer"] }),
    ]);
    expect(reloaded.removeBot("writer")).toBe(1);
    expect(manager(file).list()).toEqual([]);
  });

  it("keeps valid calls when another persisted record is malformed", () => {
    const file = tempFile();
    const calls = manager(file);
    const valid = calls.create(input());
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { version: 1; calls: unknown[] };
    persisted.calls.unshift({ id: "broken", name: 42, botIds: [] });
    writeFileSync(file, JSON.stringify(persisted));

    expect(manager(file).list()).toEqual([
      expect.objectContaining({ id: valid.id, name: "Planning call" }),
    ]);
  });

  it("rolls back memory if the atomic persistence step fails", () => {
    const file = tempFile();
    const calls = manager(file);
    mkdirSync(file);
    expect(() => calls.create(input())).toThrow();
    expect(calls.list()).toEqual([]);
  });
});

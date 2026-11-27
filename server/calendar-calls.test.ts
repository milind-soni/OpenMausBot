import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    const created = calls.create(input({ durationMinutes: 5 }));
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
      durationMinutes: 5,
      attachments: [{ path: "/safe/local/Launch brief.pdf", kind: "file" }],
    });
  });

  it("fires a due call once and persists the occurrence cursor", async () => {
    const file = tempFile();
    let now = 1_000;
    const due: Array<{ id: string; scheduledFor: number }> = [];
    const calls = new CalendarCallManager({
      file,
      now: () => now,
      botExists: () => true,
      onDue: (call, scheduledFor) => {
        due.push({ id: call.id, scheduledFor });
      },
    });
    const created = calls.create(input({ schedule: { type: "once", at: 2_000 } }));

    await calls.tick();
    expect(due).toEqual([]);
    now = 2_000;
    await calls.tick();
    await calls.tick();

    expect(due).toEqual([{ id: created.id, scheduledFor: 2_000 }]);
    expect(calls.get(created.id)?.nextRunAt).toBeNull();
    expect(manager(file, now).get(created.id)?.nextRunAt).toBeNull();
  });

  it("retries a failed kickoff while the event is current and skips stale events", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 2_000;
    let attempts = 0;
    const calls = new CalendarCallManager({
      file: tempFile(),
      now: () => now,
      botExists: () => true,
      onDue: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
      },
    });
    const current = calls.create(input({ schedule: { type: "once", at: 2_000 }, durationMinutes: 15 }));

    await calls.tick();
    expect(attempts).toBe(1);
    expect(calls.get(current.id)?.nextRunAt).toBe(2_000);
    await calls.tick();
    expect(attempts).toBe(2);
    expect(calls.get(current.id)?.nextRunAt).toBeNull();

    const stale = calls.create(input({ schedule: { type: "once", at: 3_000 }, durationMinutes: 15 }));
    now = 3_000 + 15 * 60_000;
    await calls.tick();
    expect(attempts).toBe(2);
    expect(calls.get(stale.id)?.nextRunAt).toBeNull();
    error.mockRestore();
  });

  it("links a room until the event roster changes", () => {
    const calls = manager();
    const created = calls.create(input());
    expect(calls.linkRoom(created.id, "room-1").roomId).toBe("room-1");
    expect(calls.update(created.id, { name: "Renamed" }).roomId).toBe("room-1");
    expect(calls.update(created.id, { botIds: ["chief"] }).roomId).toBeUndefined();
  });

  it("persists the first schedule cursor when migrating old reminder files", () => {
    const file = tempFile();
    const created = manager(file, 100).create(input({ schedule: { type: "once", at: 2_000 } }));
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { calls: Array<{ nextRunAt?: number | null }> };
    delete persisted.calls[0]!.nextRunAt;
    writeFileSync(file, JSON.stringify(persisted));

    expect(manager(file, 1_000).get(created.id)?.nextRunAt).toBe(2_000);
    expect(JSON.parse(readFileSync(file, "utf8")).calls[0].nextRunAt).toBe(2_000);
    expect(manager(file, 2_100).get(created.id)?.nextRunAt).toBe(2_000);
  });

  it("validates participants, schedules, duration, and attachments", () => {
    const calls = manager();
    expect(() => calls.create(input({ botIds: [] }))).toThrow(/at least one bot/i);
    expect(() => calls.create(input({ botIds: ["missing"] }))).toThrow(/no longer exist/i);
    expect(() => calls.create(input({ durationMinutes: 4 }))).toThrow(
      "Call duration must be between 5 and 240 minutes",
    );
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

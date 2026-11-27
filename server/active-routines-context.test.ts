import { describe, expect, it } from "vitest";
import { activeRoutinesContext, ACTIVE_ROUTINES_MAX_CHARS, ACTIVE_ROUTINES_MAX_COUNT } from "./active-routines-context.ts";
import { mayRead, memberAudience } from "./audience.ts";
import type { Routine } from "./routines.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

const routine = (id: string, patch: Partial<Routine> = {}): Routine => ({
  id, botId: "bot", target: "bot", name: `Monitor ${id}`, prompt: "Check the payment. Pause after delivery.",
  enabled: true, runOn: "maus", durationMinutes: 10, createdAt: 1, updatedAt: 1,
  schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 }, nextRunAt: 3_600_000, ...patch,
});
const context = (routines: Routine[], extra: Partial<Parameters<typeof activeRoutinesContext>[0]> = {}) =>
  activeRoutinesContext({ botId: "bot", routines, ...extra });

describe("activeRoutinesContext", () => {
  it("is absent without enabled schedules for this bot", () => {
    expect(context([])).toBe("");
    expect(context([routine("paused", { enabled: false }), routine("other", { botId: "other" }), routine("room", { target: "room-goal" })])).toBe("");
  });

  it("carries the id, schedule, next run, source title and the stop rule as quoted previews", () => {
    const text = context([routine("stable-id", { sourceThreadId: "work" })], { title: () => "Payment work" });
    expect(text).toContain('"id":"stable-id"');
    expect(text).toContain('"schedule":"interval"');
    expect(text).toContain('"nextRun":"1970-01-01T01:00:00.000Z"');
    expect(text).toContain('"source":"Payment work"');
    expect(text).toContain("Pause after delivery.");
    expect(text).toContain("trigger_info");
    expect(text).toContain("not permission");
  });

  it("puts temporary schedules and interval monitors before standing work, newest first within each kind", () => {
    const text = context([
      routine("standing", { schedule: { type: "daily", time: "09:00", weekdays: [1] }, createdAt: 100 }),
      routine("old-interval"), routine("new-interval", { createdAt: 10 }),
      routine("temporary", { schedule: { type: "interval", everyMinutes: 60, anchorAt: 0, endsAt: 99 } }),
    ]);
    const ids = [...text.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
    expect(ids).toEqual(["temporary", "new-interval", "old-interval", "standing"]);
  });

  it("includes enabled app and webhook monitors but leaves model-free posts and room deliveries alone", () => {
    const text = context([], {
      appTriggers: [routine("app"), routine("off", { enabled: false }), routine("other", { botId: "other" })],
      webhooks: [routine("hook"), { ...routine("post"), delivery: "post" }, { ...routine("room-hook"), groupId: "room" }],
    });
    expect(text).toContain('"schedule":"app_event"');
    expect(text).toContain('"schedule":"webhook"');
    for (const id of ["off", "other", "post", "room-hook"]) expect(text).not.toContain(`"id":"${id}"`);
    expect(context([], { appTriggers: [routine("private", { sourceThreadId: "bob" })], webhooks: [routine("unknown")], include: () => false })).toBe("");
  });

  it("caps count, each preview and the whole part even with escaped text", () => {
    const list = Array.from({ length: 30 }, (_, i) => routine(`id-${i}`, {
      name: '"\\\n'.repeat(200), prompt: '"\\\n'.repeat(20_000), createdAt: i,
    }));
    const text = context(list, { title: () => '"\\\n'.repeat(200) });
    expect(text.length).toBeLessThanOrEqual(ACTIVE_ROUTINES_MAX_CHARS);
    const records = text.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(ACTIVE_ROUTINES_MAX_COUNT);
    expect(records[0].id).toBe("id-29");
    expect(records[0].instructions.length).toBeLessThanOrEqual(500);
    expect(context(Array.from({ length: 30 }, (_, i) => routine(String(i)))).match(/"id":/g)).toHaveLength(ACTIVE_ROUTINES_MAX_COUNT);
  });

  it("uses the conversation audience for source and results and refuses missing provenance when scoped", () => {
    const alice = memberAudience("alice");
    const audiences = new Map([["alice", alice], ["bob", memberAudience("bob")], ["team", "team" as const]]);
    const include = (id: string) => audiences.has(id) && mayRead(audiences.get(id)!, alice);
    const title = (id: string) => `Title ${id}`;
    const text = context([
      routine("own", { sourceThreadId: "alice" }), routine("shared", { sourceThreadId: "team" }),
      routine("private", { sourceThreadId: "bob" }), routine("missing"),
      routine("gone", { sourceThreadId: "deleted" }), routine("private-results", { sourceThreadId: "team", resultsThreadId: "bob" }),
    ], { include, title });
    expect(text).toContain('"id":"own"');
    expect(text).toContain('"id":"shared"');
    for (const id of ["private", "missing", "gone", "private-results"]) expect(text).not.toContain(`"id":"${id}"`);
    expect(text).not.toContain("Title bob");
    expect(context([routine("hidden", { sourceThreadId: "bob" })], { include })).toBe("");
  });

  it("redacts before truncating and keeps changing routines outside the stable prompt", () => {
    const text = context([routine("safe", { prompt: "Use sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 then pause.", name: "Safe monitor" })]);
    expect(text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    const built = buildSystemPrompt("Bot", "", [{ id: "active-routines", label: "Active automations", text }]);
    expect(built.volatile).toContain('"id":"safe"');
    expect(built.stable).not.toContain('"id":"safe"');
  });
});

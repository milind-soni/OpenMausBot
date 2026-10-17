import { describe, expect, it } from "vitest";

import { listTriggers, parseTriggerRequest, triggerTarget } from "./trigger-tools.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { WebhookTrigger } from "./webhooks.ts";

const now = Date.parse("2026-10-17T10:00:00Z");
const routine = (id: string, botId: string, prompt = "Summarize the inbox."): Routine => ({
  id, name: `Routine ${id}`, prompt, target: "bot", botId, runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: now + 3_600_000, createdAt: now, updatedAt: now,
});
const webhook = (id: string, botId: string): WebhookTrigger => ({
  id, endpointId: `wh_${id}`, name: `Hook ${id}`, prompt: "Draft a reply.", botId, runOn: "maus", enabled: true,
  createdAt: now, updatedAt: now, deliveryCount: 2, lastReceivedAt: now - 60_000,
});
const run = (id: string, routineId: string, botId: string, output = "done"): RoutineRun => ({
  id, routineId, routineName: routineId, target: "bot", botId, runOn: "maus", scheduledFor: now, status: "completed", manual: false, output, createdAt: now,
});

describe("listTriggers", () => {
  it("lists only the bot's own schedules and webhooks, each with its kind, and scrubs credentials", () => {
    const listed = listTriggers({
      botId: "bot-a", routines: [routine("r1", "bot-a", "Use token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to check."), routine("r2", "bot-b")],
      webhooks: [webhook("w1", "bot-a"), webhook("w2", "bot-b")], runs: [run("x1", "w1", "bot-a")], timeZone: "Asia/Kolkata", now,
    });
    expect(listed).toMatchObject({ now: "2026-10-17T10:00:00.000Z", timeZone: "Asia/Kolkata" });
    expect(listed.triggers!.map((trigger) => [trigger.id, trigger.kind])).toEqual([["r1", "schedule"], ["w1", "webhook"]]);
    expect(JSON.stringify(listed)).not.toContain("sk-ant-api03");
    expect(listed.triggers![1]).toMatchObject({ calls: 2, latestRun: { id: "x1", status: "completed" } });
    expect(JSON.stringify(listed.triggers![1])).toContain("you never see its secret");
    expect(listed.triggers![0]).toMatchObject({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] } });
  });

  it("gives one trigger with its recent fires, and says plainly when the id is not the bot's", () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index}`, "r1", "bot-a", `report ${index}`));
    const one = listTriggers({ botId: "bot-a", triggerId: "r1", routines: [routine("r1", "bot-a")], webhooks: [], runs, timeZone: "UTC", now });
    expect(one.trigger).toMatchObject({ id: "r1", kind: "schedule" });
    expect(one.trigger!.recentFires).toHaveLength(10);
    expect(listTriggers({ botId: "bot-b", triggerId: "r1", routines: [routine("r1", "bot-a")], webhooks: [], runs, timeZone: "UTC", now }).error)
      .toContain("No trigger with that id belongs to this bot");
  });
});

describe("parseTriggerRequest", () => {
  const source = { fromBotId: "bot-a", fromThreadId: "thread-a" };
  const isSchedule = (id: string) => id.startsWith("r") ? "schedule" as const : id.startsWith("a") ? "app" as const : "webhook" as const;

  it("routes a create by its kind and a change by whose id it is", () => {
    expect(parseTriggerRequest({ ...source, action: "create", kind: "schedule", routine: { name: "x" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "schedule", proposal: { action: "create", routine: { name: "x" } } });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "webhook", webhook: { name: "x" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "webhook", operation: { action: "create", webhook: { name: "x" } } });
    expect(parseTriggerRequest({ ...source, action: "pause", triggerId: "r1" }, isSchedule))
      .toMatchObject({ ok: true, kind: "schedule", proposal: { action: "pause", routineId: "r1" } });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "w1", changes: { name: "y" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "webhook", operation: { action: "update", webhookId: "w1", changes: { name: "y" } } });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "app", trigger: { name: "x" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "app", operation: { action: "create", trigger: { name: "x" } } });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "a1", changes: { filter: { from: "acme" } } }, isSchedule))
      .toMatchObject({ ok: true, kind: "app", operation: { action: "update", triggerId: "a1", changes: { filter: { from: "acme" } } } });
  });

  it("refuses a field the trigger's kind does not have, and unknown shapes", () => {
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "w1", changes: { schedule: {} } }, isSchedule))
      .toMatchObject({ ok: false, error: expect.stringContaining("has no schedule") });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "r1", changes: { eventTypes: ["push"] } }, isSchedule))
      .toMatchObject({ ok: false });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "a1", changes: { event: "SLACK_X" } }, isSchedule))
      .toMatchObject({ ok: false, error: expect.stringContaining("delete it and create a new one") });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "email", routine: {} }, isSchedule)).toMatchObject({ ok: false });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "schedule", routine: {}, extra: 1 }, isSchedule)).toMatchObject({ ok: false });
  });
});

describe("triggerTarget", () => {
  const bots = {
    a: { id: "bot-a", name: "A", section: "Ops" },
    b: { id: "bot-b", name: "B", section: "Ops" },
    c: { id: "bot-c", name: "C", section: "Sales" },
  };
  const lookup = (id: string) => Object.values(bots).find((bot) => bot.id === id);
  it("needs no target for the sender, names a teammate, and refuses one outside the section", () => {
    expect(triggerTarget(bots.a, undefined, lookup)).toEqual({});
    expect(triggerTarget(bots.a, "bot-a", lookup)).toEqual({});
    expect(triggerTarget(bots.a, "bot-b", lookup)).toEqual({ forBot: { botId: "bot-b", name: "B" } });
    expect(triggerTarget(bots.a, "bot-c", lookup)).toMatchObject({ status: 403 });
    expect(triggerTarget(bots.a, "bot-zzz", lookup)).toMatchObject({ status: 404 });
    expect(triggerTarget(bots.a, "  ", lookup)).toMatchObject({ status: 400 });
  });
});

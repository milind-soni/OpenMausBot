import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CalendarEvent } from "../connected-reads.ts";
import type { RoutineRun } from "../routines.ts";
import { Store } from "../store.ts";
import { createBrief, MORNING_WAKE_EARLY_MS } from "./brief.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const clock = (ms: number, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

function setup(options: { zone: string; start: string; morning?: string; overnight?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "omb-brief-morning-"));
  dirs.push(dir);
  let now = Date.parse(options.start);
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "MausBot" });
  store.setChiefOfStaff(chief.id);
  const pushed: string[] = [];
  const hooks: { pushed?: () => void } = {};
  const sinces: number[] = [];
  const runs: RoutineRun[] = [];
  let first = true;
  const brief = createBrief({
    store, dataDir: dir, now: () => now, hosted: false, watching: () => true, mainThread: () => store.bot(chief.id)!.threadId, threadBusy: () => false,
    notify: (_bot, _thread, detail) => { pushed.push(detail); hooks.pushed?.(); }, runs: () => runs, needsYou: () => [], engineName: () => "Claude",
    hostTimeZone: () => undefined, language: () => undefined, session: () => null, address: () => "me@x.test",
    failRun: () => {}, keep: () => {}, items: () => null,
    morning: {
      at: () => options.morning ?? "08:00",
      push: (summary) => (first ? ((first = false), "Your first brief is ready") : summary),
      overnight: (since) => { sinces.push(since); return options.overnight; },
    },
  });
  const cards = () => store.messagesFor(store.bot(chief.id)!.threadId).filter((message) => message.serverCard && message.widget?.root.title === "Your brief");
  const meeting = (at: number): CalendarEvent => ({
    id: `m-${at}`, title: "Standup", start: at, end: at + 30 * MINUTE, allDay: false, status: "confirmed", selfDeclined: false,
    attendees: [{ email: "me@x.test", self: true, organizer: true }, { email: "ada@x.test", name: "Ada", self: false, organizer: false }],
  });
  const tick = async () => { brief.tick(); await settle(); await settle(); };
  return { brief, store, chief, pushed, hooks, sinces, runs, cards, meeting, tick, now: () => now, set: (iso: string) => { now = Date.parse(iso); }, advance: (ms: number) => { now += ms; } };
}

describe("the morning brief", () => {
  it.each([
    ["America/New_York", "2026-10-29T04:00:00.001Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T10:59:59.999Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T11:14:21.643Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T11:35:03.123Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T11:49:59.999Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T11:50:21.643Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T12:19:59.999Z", "2026-10-29T11:50:00Z"],
    ["America/New_York", "2026-10-29T12:20:00.001Z", "2026-10-30T11:50:00Z"],
    ["America/New_York", "2026-10-29T22:35:21.643Z", "2026-10-30T11:50:00Z"],
    ["Europe/Berlin", "2026-10-24T18:35:21.643Z", "2026-10-25T06:50:00Z"],
    ["America/New_York", "2026-10-31T22:35:21.643Z", "2026-11-01T12:50:00Z"],
    ["America/New_York", "2026-03-07T23:35:21.643Z", "2026-03-08T11:50:00Z"],
    ["Asia/Kolkata", "2026-10-29T01:44:21.643Z", "2026-10-29T02:20:00Z"],
  ])("sets an exact morning wake boundary in %s at %s", async (zone, start, wake) => {
    const s = setup({ zone, start });
    await s.brief.active("desktop", zone, "en");
    expect(s.brief.nextWakeAt()).toBe(Date.parse(wake));
  });

  it("is posted and pushed at 8:00 in the person's own zone, not a minute before, and once a day", async () => {
    // 07:59 in New York is 11:59 UTC in October.
    const s = setup({ zone: "America/New_York", start: "2026-10-22T11:59:00Z" });
    await s.brief.active("desktop", "America/New_York", "en");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [s.meeting(Date.parse("2026-10-22T14:00:00Z"))], clashes: [] });
    const before = s.cards().length;
    await s.tick();
    expect(s.pushed).toEqual([]);
    s.advance(MINUTE);
    await s.tick();
    expect(clock(s.now(), "America/New_York")).toBe("08:00");
    expect(s.pushed).toEqual(["Your first brief is ready"]);
    expect(s.cards().length).toBeGreaterThanOrEqual(Math.max(1, before));
    await s.tick();
    s.advance(2 * HOUR);
    await s.tick();
    expect(s.pushed).toHaveLength(1);
    // The next morning's push says what is in it.
    s.set("2026-10-23T12:00:00Z");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [s.meeting(Date.parse("2026-10-23T15:00:00Z"))], clashes: [] });
    await s.tick();
    expect(s.pushed).toHaveLength(2);
    expect(s.pushed[1]).toMatch(/^Your brief: .*1 meeting/);
  });

  it("is pushed once even when another edit of the brief comes while it is being posted", async () => {
    const s = setup({ zone: "UTC", start: "2026-10-22T07:59:00Z" });
    await s.brief.active("desktop", "UTC", "en");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [s.meeting(Date.parse("2026-10-22T10:00:00Z"))], clashes: [] });
    s.hooks.pushed = () => { s.hooks.pushed = undefined; void s.brief.refresh(); };
    s.advance(MINUTE);
    await s.tick();
    await s.tick();
    await s.tick();
    expect(s.pushed).toEqual(["Your first brief is ready"]);
  });

  it("leads with what was done while the person was away, from the counts since they were last here", async () => {
    const s = setup({ zone: "Europe/Berlin", start: "2026-10-21T20:00:00Z", overnight: "While you slept, I sorted 23 emails, drafted 2 replies and prepped 1 meeting." });
    await s.brief.active("desktop", "Europe/Berlin", "en");
    const away = s.now();
    s.set("2026-10-22T06:00:00Z");
    await s.tick();
    expect(clock(s.now(), "Europe/Berlin")).toBe("08:00");
    expect(s.sinces).toEqual([away]);
    const root = JSON.stringify(s.cards().at(-1)!.widget!.root);
    expect(root.indexOf("While you slept, I sorted 23 emails")).toBeGreaterThan(-1);
    expect(root.indexOf("While you slept")).toBeLessThan(root.indexOf("Needs you"));
    expect(s.pushed).toEqual(["Your first brief is ready"]);
  });

  it("has nothing to say about the night when the person was just here", async () => {
    const s = setup({ zone: "UTC", start: "2026-10-22T07:45:00Z", overnight: "While you slept, I sorted 3 emails." });
    await s.brief.active("desktop", "UTC", "en");
    s.set("2026-10-22T08:00:00Z");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [s.meeting(Date.parse("2026-10-22T10:00:00Z"))], clashes: [] });
    await s.tick();
    expect(s.sinces).toEqual([]);
    expect(JSON.stringify(s.cards().at(-1)!.widget!.root)).not.toContain("While you slept");
  });

  it("gives a watch run still sorting the night's mail up to 20 minutes, then goes without it", async () => {
    const s = setup({ zone: "UTC", start: "2026-10-22T08:00:00Z", overnight: "While you slept, I sorted 3 emails." });
    await s.brief.active("desktop", "UTC", "en");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [s.meeting(Date.parse("2026-10-22T10:00:00Z"))], clashes: [] });
    s.runs.push({ id: "w1", routineId: "watch", routineName: "Keep an eye on my day", target: "bot", botId: s.chief.id, runOn: "maus", scheduledFor: s.now(), status: "running", manual: false, createdAt: s.now(), deliver: "brief" });
    await s.tick();
    expect(s.pushed).toEqual([]);
    s.advance(19 * MINUTE);
    await s.tick();
    expect(s.pushed).toEqual([]);
    s.advance(MINUTE);
    await s.tick();
    expect(s.pushed).toEqual(["Your first brief is ready"]);
  });

  it("wakes a sleeping Cloud ten minutes early, for today's 8:00 until it is out and then tomorrow's, through a clock change", () => {
    // Berlin leaves summer time at 03:00 on Sunday 25 October 2026.
    const s = setup({ zone: "Europe/Berlin", start: "2026-10-24T18:00:00Z" });
    void s.brief.active("desktop", "Europe/Berlin", "en");
    const wake = s.brief.nextWakeAt()!;
    expect(wake + MORNING_WAKE_EARLY_MS).toBe(Date.parse("2026-10-25T07:00:00Z"));
    expect(clock(wake, "Europe/Berlin")).toBe("07:50");
    s.set("2026-10-25T05:00:00Z");
    expect(s.brief.nextWakeAt()).toBe(Date.parse("2026-10-25T06:50:00Z"));
  });

  it("is never pushed where no morning time is set", async () => {
    const s = setup({ zone: "UTC", start: "2026-10-22T08:05:00Z", morning: "" });
    await s.brief.active("desktop", "UTC", "en");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [s.meeting(Date.parse("2026-10-22T10:00:00Z"))], clashes: [] });
    await s.tick();
    expect(s.pushed).toEqual([]);
    expect(s.brief.nextWakeAt()).toBeNull();
  });
});

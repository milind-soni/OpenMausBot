import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SourceError, type CalendarEvent, type ConnectedReads, type EmailHeader, type ReadApp } from "../connected-reads.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { CHECKS_FILE, createRoutineChecks, type CheckReport } from "./routine-checks.ts";

const MINUTE = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { fenced?: boolean; may?: (app: ReadApp) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-checks-"));
  dirs.push(dir);
  let now = Date.parse("2026-10-22T08:00:00Z");
  const inbox: EmailHeader[] = [];
  const events: CalendarEvent[] = [];
  const failing: Partial<Record<ReadApp, string>> = {};
  const calls: string[] = [];
  const runs: RoutineRun[] = [];
  const reports: CheckReport[] = [];
  const reads: ConnectedReads = {
    connected: async () => ({ gmail: true, googlecalendar: true }),
    session: () => ({
      async address() { calls.push("address"); if (failing.gmail) throw new SourceError("gmail", failing.gmail); return "me@x.test"; },
      async events() { calls.push("events"); if (failing.googlecalendar) throw new SourceError("googlecalendar", failing.googlecalendar); return events; },
      async emails(since, limit) {
        calls.push("emails");
        if (failing.gmail) throw new SourceError("gmail", failing.gmail);
        const found = inbox.filter((email) => email.at >= since).sort((a, b) => b.at - a.at);
        return { emails: found.slice(0, limit), more: found.length > limit };
      },
      async message() { return null; },
      async thread() { return []; },
    }),
  };
  const sorted: Array<[string, number]> = [];
  const checks = createRoutineChecks({
    dataDir: dir, reads, now: () => now, mayRead: (_bot, app) => options.may?.(app) ?? true, fenced: () => options.fenced ?? true,
    timeZone: () => "UTC", runs: () => runs, dismissedFrom: () => [], report: (report) => { reports.push(report); },
    sorted: (routineId, count) => sorted.push([routineId, count]),
  });
  const routine = (extra: Partial<Routine> = {}): Routine => ({
    id: "watch", name: "Keep an eye on my day", prompt: "Check my day.", target: "bot", botId: "chief", runOn: "maus", enabled: true,
    schedule: { type: "interval", everyMinutes: 15, anchorAt: 0 }, durationMinutes: 30, nextRunAt: null, createdAt: now - 60 * MINUTE, updatedAt: 0,
    checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief", ...extra,
  });
  const mail = (id: string, agoMinutes: number): EmailHeader => {
    const email = { id, threadId: `t-${id}`, at: now - agoMinutes * MINUTE, from: `Sender ${id} <${id}@x.test>`, subject: `Subject ${id}`, preview: "hi" };
    inbox.push(email);
    return email;
  };
  const meeting = (id: string, startsInMinutes: number): CalendarEvent => {
    const event: CalendarEvent = { id, title: id, start: now + startsInMinutes * MINUTE, end: now + (startsInMinutes + 30) * MINUTE, allDay: false, status: "confirmed", selfDeclined: false,
      attendees: [{ email: "me@x.test", self: true, organizer: true }, { email: "ada@x.test", self: false, organizer: false }], ownedCalendar: true };
    events.push(event);
    return event;
  };
  return { checks, routine, mail, meeting, failing, calls, runs, reports, inbox, sorted, advance: (ms: number) => { now += ms; }, now: () => now, file: join(dir, CHECKS_FILE) };
}

const run = (key: string, status: RoutineRun["status"], deliver?: "brief"): RoutineRun => ({
  id: `run-${key}`, routineId: "watch", routineName: "Keep an eye on my day", target: "bot", botId: "chief", runOn: "maus", scheduledFor: 0,
  status, manual: false, checkKey: key, createdAt: 0, ...(deliver ? { deliver } : {}),
});

describe("a routine's checks", () => {
  it("nothing new means no run, and the brief still hears what needs no AI", async () => {
    const s = setup();
    const result = await s.checks.check(s.routine(), { manual: false });
    expect(result).toEqual({});
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({ meetings: [], clashes: [], remind: [], runs: [] });
  });

  it("new mail and a meeting to prepare become one run; its answer being kept moves the cursor", async () => {
    const s = setup();
    s.mail("a", 5);
    s.mail("b", 3);
    s.meeting("planning", 120);
    const result = await s.checks.check(s.routine(), { manual: false });
    expect(result.run?.key).toMatch(/^chk-/);
    expect(result.run!.prompt).toContain("id a · from Sender a <a@x.test>");
    expect(result.run!.prompt).toContain("title planning");
    expect(s.checks.items(result.run!.key)?.mail.map((email) => email.id)).toEqual(["b", "a"]);
    expect(await s.checks.check(s.routine(), { manual: false, hold: "running" })).toEqual({ wakeAt: expect.any(Number) });
    s.checks.commit(result.run!.key);
    s.advance(15 * MINUTE);
    expect((await s.checks.check(s.routine(), { manual: false })).run).toBeUndefined();
    const saved = JSON.parse(readFileSync(s.file, "utf8")).routines.watch;
    expect(saved.judged).toEqual(["b", "a"]);
    expect(Object.values(saved.meetings as Record<string, { preppedAt?: number }>).map((one) => one.preppedAt)).toEqual([expect.any(Number)]);
    expect(JSON.stringify(saved)).not.toContain("Subject a");
  });

  it("a meeting its run's answer did not prepare is settled too, never handed out every tick", async () => {
    const s = setup();
    s.meeting("review", 150);
    const first = await s.checks.check(s.routine({ checks: ["calendar"] }), { manual: false });
    s.checks.commit(first.run!.key);
    s.advance(15 * MINUTE);
    expect((await s.checks.check(s.routine({ checks: ["calendar"] }), { manual: false })).run).toBeUndefined();
  });

  it("a run that fails gives its items back for the next check", async () => {
    const s = setup();
    s.mail("a", 5);
    const first = await s.checks.check(s.routine(), { manual: false });
    s.checks.settled(run(first.run!.key, "failed"));
    s.advance(15 * MINUTE);
    const again = await s.checks.check(s.routine(), { manual: false });
    expect(s.checks.items(again.run!.key)?.mail.map((email) => email.id)).toEqual(["a"]);
  });

  it("a read that fails is trouble, never nothing new; it keeps the cursor and is not retried every tick", async () => {
    const s = setup();
    await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false });
    s.advance(15 * 60_000);
    s.mail("a", 5);
    s.failing.gmail = "Connected account is not ACTIVE";
    const result = await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false });
    expect(result).toEqual({ trouble: "Couldn't read Gmail. Reconnect it in Connected apps." });
    expect(s.reports.at(-1)!.trouble).toEqual([{ app: "gmail", signedOut: true }]);
    const reads = s.calls.length;
    s.advance(5 * MINUTE);
    await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false });
    expect(s.calls.length).toBe(reads);
    delete s.failing.gmail;
    s.advance(15 * MINUTE);
    expect((await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false })).run).toBeDefined();
  });

  it("reads nothing from an app the bot may not use", async () => {
    const s = setup({ may: (app) => app !== "gmail" });
    s.mail("a", 5);
    await s.checks.check(s.routine(), { manual: false });
    expect(s.calls).toEqual(["events"]);
  });

  it("on an engine that cannot fence a read-and-draft run, sorts nothing but keeps the no-AI parts", async () => {
    const s = setup({ fenced: false });
    s.mail("a", 5);
    s.meeting("standup", 8);
    const result = await s.checks.check(s.routine(), { manual: false });
    expect(result.run).toBeUndefined();
    expect(s.reports[0]).toMatchObject({ unfenced: true });
    expect(s.reports[0]!.remind!.map((event) => event.title)).toEqual(["standup"]);
  });

  it("reports each reminder once, and names the next time a meeting needs it", async () => {
    const s = setup();
    s.meeting("soon", 8);
    const later = s.meeting("later", 6 * 60);
    const result = await s.checks.check(s.routine({ checks: ["calendar"] }), { manual: false, hold: "capped" });
    expect(s.reports[0]!.remind!.map((event) => event.title)).toEqual(["soon"]);
    expect(result.wakeAt).toBe(later.start - 4 * 60 * MINUTE);
    await s.checks.check(s.routine({ checks: ["calendar"] }), { manual: false, hold: "capped" });
    expect(s.reports[1]!.remind).toEqual([]);
  });

  it("other routines' finished runs go to the brief, once", async () => {
    const s = setup();
    s.runs.push({ ...run("x", "completed"), routineId: "other", checkKey: undefined, finishedAt: s.now() - MINUTE, output: "Done." });
    await s.checks.check(s.routine({ checks: ["runs"] }), { manual: false });
    expect(s.reports[0]!.runs!.map((one) => one.routineId)).toEqual(["other"]);
    s.advance(MINUTE);
    await s.checks.check(s.routine({ checks: ["runs"] }), { manual: false });
    expect(s.reports[1]!.runs).toEqual([]);
  });

  it("counts the emails a run sorted only once its answer is kept, and never a run that failed", async () => {
    const s = setup();
    s.mail("a", 5);
    s.mail("b", 6);
    const { run: first } = await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false });
    expect(s.sorted).toEqual([]);
    s.checks.release(first!.key);
    expect(s.sorted).toEqual([]);
    s.advance(MINUTE);
    const { run: second } = await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false });
    s.checks.commit(second!.key);
    expect(s.sorted).toEqual([["watch", 2]]);
  });

  it("a draft may answer only one of its run's threads, to that thread's sender, once", async () => {
    const s = setup();
    s.mail("a", 5);
    const { run: handed } = await s.checks.check(s.routine({ checks: ["mail"] }), { manual: false });
    const key = handed!.key;
    expect(s.checks.mayDraft(key, "t-a", "a@x.test")).toBe(true);
    expect(s.checks.mayDraft(key, "t-a", "attacker@evil.test")).toBe(false);
    expect(s.checks.mayDraft(key, "t-other", "a@x.test")).toBe(false);
    s.checks.drafted(key, "t-a");
    expect(s.checks.mayDraft(key, "t-a", "a@x.test")).toBe(false);
    expect(s.checks.mayDraft("chk-unknown", "t-a", undefined)).toBe(false);
  });

  it("a routine of the person's own with checks keeps its items once its run completes", async () => {
    const s = setup();
    s.mail("a", 5);
    const own = s.routine({ deliver: undefined, access: undefined, checks: ["mail"] });
    const { run: handed } = await s.checks.check(own, { manual: false });
    expect(handed!.prompt).toContain("Since the last check");
    s.checks.settled(run(handed!.key, "completed"));
    s.advance(15 * MINUTE);
    expect((await s.checks.check(own, { manual: false })).run).toBeUndefined();
    expect(s.reports).toEqual([]);
  });
});

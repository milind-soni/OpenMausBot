import { describe, expect, it } from "vitest";

import type { Routine, RoutineRun } from "@/lib/routines";
import type { WebhookTrigger } from "@/lib/webhooks";
import {
  automationSentence, automationsFrom, automationStatus, doesPhrase, lastReceived, lastWhen, nextWhen, orderAutomations, plainWhen, runLine, sourcePhrase, statusLine,
  webhookCalls, type Automation,
} from "./automations";
import type { WebhookAttempt } from "@/lib/webhooks";

const NOW = new Date(2026, 9, 17, 12, 0).getTime(); // Saturday Oct 17 2026, noon local
const at = (days: number, hours: number, minutes = 0) => { const day = new Date(NOW); day.setDate(day.getDate() + days); day.setHours(hours, minutes, 0, 0); return day.getTime(); };
const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "brief", name: "Morning summary", prompt: "Send me a summary of my inbox: who wrote and what they need.", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: at(2, 9), createdAt: 0, updatedAt: 0, ...overrides,
});
const webhook = (overrides: Partial<WebhookTrigger> = {}): WebhookTrigger => ({
  id: "hook", endpointId: "wh_x", name: "Sales form leads", prompt: "Draft a short follow-up email for the lead.", botId: "scout", runOn: "maus", enabled: true,
  createdAt: 0, updatedAt: 0, deliveryCount: 0, ...overrides,
});
let sequence = 0;
const run = (status: RoutineRun["status"], startedAt: number, extra: Partial<RoutineRun> = {}): RoutineRun => ({
  id: `run-${++sequence}`, routineId: "brief", routineName: "Morning summary", target: "bot", botId: "scout", runOn: "maus", scheduledFor: startedAt, startedAt,
  createdAt: startedAt, status, manual: false, ...extra,
});
const automation = (runs: RoutineRun[], overrides: Partial<Routine> = {}): Automation => automationsFrom({ routines: [routine(overrides)], webhooks: [], runs })[0]!;

describe("the plain sentence", () => {
  it("says when, who and what for a schedule, turning the instructions into a short phrase addressed to the person", () => {
    expect(automationSentence(automation([]), "Scout")).toBe("Every weekday at 9 AM, Scout sends you a summary of your inbox");
  });

  it("says who sends and what the bot does for something another app sends", () => {
    const [hook] = automationsFrom({ routines: [], webhooks: [webhook()], runs: [] });
    expect(automationSentence(hook!, "Scout")).toBe("When your sales form sends something, Scout drafts a short follow-up email for the lead");
    const [unnamed] = automationsFrom({ routines: [], webhooks: [webhook({ name: "Webhook 2", prompt: "" })], runs: [] });
    expect(automationSentence(unnamed!, "Scout")).toBe("When another app sends something, Scout does what it's asked");
  });

  it("names sources plainly and shortens long instructions at a word", () => {
    expect(sourcePhrase("Typeform")).toBe("your Typeform");
    expect(sourcePhrase("GitHub push events")).toBe("your GitHub push");
    expect(sourcePhrase("webhook")).toBe("another app");
    expect(doesPhrase("Check every open support ticket across all of the shared inboxes and reply to the urgent ones first")).toMatch(/^checks every open support ticket across all of the shared…$/);
    expect(doesPhrase("Reply to each new lead")).toBe("replies to each new lead");
    expect(doesPhrase("Watch the build")).toBe("watches the build");
    expect(doesPhrase("Summarize the inbox and post the three priorities")).toBe("summarizes the inbox and posts the three priorities");
  });

  it("keeps a first word that is a name or an acronym as it is: no lowercase letter put in, no verb made of it", () => {
    expect(doesPhrase("SMS the team when a deal closes")).toBe("SMS the team when a deal closes");
    expect(doesPhrase("HubSpot deals over $10k go to Ana")).toBe("HubSpot deals over $10k go to Ana");
    expect(doesPhrase("E2E-WEBHOOK-RUN check")).toBe("E2E-WEBHOOK-RUN check");
    expect(doesPhrase("PDF des factures à envoyer", false)).toBe("PDF des factures à envoyer");
    expect(doesPhrase("Envoyer le résumé", false)).toBe("envoyer le résumé");
    expect(doesPhrase("If it is urgent, call me")).toBe("if it is urgent, call you");
  });

  it("says how often a step cron runs, as the bot writes one for every 2 minutes", () => {
    expect(plainWhen({ type: "cron", expression: "*/2 * * * *", timeZone: "UTC" })).toBe("Every 2 minutes");
    expect(plainWhen({ type: "cron", expression: "*/15 * * * *", timeZone: "Asia/Kolkata" })).toBe("Every 15 minutes");
    expect(plainWhen({ type: "cron", expression: "*/2 9-17 * * 1-5", timeZone: "UTC" })).not.toBe("Every 2 minutes");
  });

  it("puts schedules in everyday words", () => {
    expect(plainWhen({ type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day at 9 AM");
    expect(plainWhen({ type: "daily", time: "17:30", weekdays: [5] })).toBe("Every Friday at 5:30 PM");
    expect(plainWhen({ type: "interval", everyMinutes: 30, anchorAt: 0 })).toBe("Every 30 minutes");
    expect(plainWhen({ type: "interval", everyMinutes: 120, anchorAt: 0, weekdays: [1, 2, 3, 4, 5] })).toBe("Every 2 hours on weekdays");
  });
});

describe("times in plain words", () => {
  it("says today, yesterday, a short weekday, or a date for what happened", () => {
    expect(lastWhen(at(0, 9, 2), NOW)).toBe("today 9:02 AM");
    expect(lastWhen(at(-1, 9), NOW)).toBe("yesterday");
    expect(lastWhen(at(-3, 9), NOW)).toBe("Wed 9:00 AM");
    expect(lastWhen(at(-20, 9), NOW)).toBe("Sep 27");
  });
  it("says today, tomorrow, the weekday, or a date for what comes next", () => {
    expect(nextWhen(at(0, 15), NOW)).toBe("today 3:00 PM");
    expect(nextWhen(at(1, 9), NOW)).toBe("tomorrow 9:00 AM");
    expect(nextWhen(at(2, 9), NOW)).toBe("Monday 9:00 AM");
  });
});

describe("status: Working, Paused, Needs you", () => {
  it("is Working with no runs, after a success, and after a failure that recovered", () => {
    expect(automationStatus(automation([])).state).toBe("working");
    expect(automationStatus(automation([run("completed", at(0, 9))])).state).toBe("working");
    expect(automationStatus(automation([run("completed", at(0, 9)), run("failed", at(-1, 9), { error: "Provider crashed" }), run("failed", at(-2, 9))])).state).toBe("working");
  });

  it("stays Working after one failure the person can't fix, counting only failures in a row", () => {
    expect(automationStatus(automation([run("failed", at(0, 9), { error: "Provider crashed" }), run("completed", at(-1, 9))])).state).toBe("working");
    expect(automationStatus(automation([run("failed", at(0, 9), { error: "Provider crashed" }), run("completed", at(-1, 9)), run("failed", at(-2, 9))])).state).toBe("working");
  });

  it("is Paused when switched off, whatever its runs", () => {
    expect(automationStatus(automation([run("failed", at(0, 9)), run("failed", at(-1, 9))], { enabled: false })).state).toBe("paused");
  });

  it("is Done, not Paused, once a one-time automation's time has passed, and is listed last", () => {
    const once = (when: number, enabled = false) => automation([], { id: `once-${when}`, enabled, schedule: { type: "once", at: when }, nextRunAt: enabled ? when : null });
    expect(automationStatus(once(at(-1, 9)), NOW).state).toBe("done");
    expect(automationStatus(once(at(1, 9)), NOW).state).toBe("paused");
    expect(automationStatus(once(at(1, 9), true), NOW).state).toBe("working");
    expect(statusLine(automation([run("completed", at(0, 9))], { enabled: false, schedule: { type: "once", at: at(0, 9) }, nextRunAt: null }), NOW)).toBe("Done · last ran today 9:00 AM");
    expect(orderAutomations([once(at(-1, 9)), automation([], { id: "p", enabled: false })]).map((item) => item.id)).toEqual(["p", `once-${at(-1, 9)}`]);
  });

  it("needs you when signed out, out of credit, out of time, waiting on an answer, or failing again and again", () => {
    expect(automationStatus(automation([run("failed", at(0, 9), { error: "Claude is signed out. Run claude auth login." })]))).toMatchObject({ state: "needs-you", fix: "sign-in", reason: "It's signed out. Sign in again so it can run." });
    expect(automationStatus(automation([run("failed", at(0, 9), { error: "Out of credit: quota exceeded" })]))).toMatchObject({ state: "needs-you", fix: "usage" });
    expect(automationStatus(automation([run("failed", at(0, 9), { error: "Stopped after reaching the 15-minute run limit" })]))).toMatchObject({ state: "needs-you", fix: "edit" });
    expect(automationStatus(automation([run("waiting", at(0, 9), { attention: "Approve the reply?" })]))).toMatchObject({ state: "needs-you", fix: "answer" });
    expect(automationStatus(automation([run("failed", at(0, 9), { error: "Provider crashed" }), run("missed", at(-1, 9)), run("completed", at(-2, 9))])))
      .toMatchObject({ state: "needs-you", fix: "run", reason: "It didn't finish the last 2 times." });
  });

  it("ignores runs still waiting to start and runs a person stopped when judging the last run", () => {
    expect(automationStatus(automation([run("queued", at(0, 11)), run("cancelled", at(0, 10)), run("completed", at(0, 9))])).state).toBe("working");
    expect(automationStatus(automation([run("queued", at(0, 11)), run("cancelled", at(0, 10)), run("failed", at(0, 9)), run("failed", at(-1, 9))])).state).toBe("needs-you");
  });
});

describe("a bot that no longer exists", () => {
  it("has none of its automations listed, of either kind", () => {
    const sources = { routines: [routine(), routine({ id: "orphan", botId: "deleted" })], webhooks: [webhook(), webhook({ id: "orphan-hook", botId: "deleted" })], runs: [] };
    expect(automationsFrom({ ...sources, bots: [{ id: "scout" }] }).map((item) => item.id)).toEqual(["brief", "hook"]);
    expect(automationsFrom(sources)).toHaveLength(4);
  });
});

describe("what another app sent, under More", () => {
  let id = 0;
  const attempt = (outcome: WebhookAttempt["outcome"], receivedAt: number, extra: Partial<WebhookAttempt> = {}): WebhookAttempt =>
    ({ id: `attempt-${++id}`, webhookId: "hook", receivedAt, outcome, statusCode: outcome === "rejected" ? 401 : 202, ...extra });

  it("lists the last calls newest first, with ✓ or ✗ and a plain reason, including the ones turned away", () => {
    const calls = webhookCalls("hook", [
      attempt("accepted", at(0, 9), { preview: `{ "lead": "Ada", "note": "${"x".repeat(400)}" }` }),
      attempt("rejected", at(0, 10), { reason: "Invalid webhook URL or secret" }),
      attempt("rejected", at(0, 11), { reason: "Invalid webhook URL or secret (3 requests)" }),
      attempt("ignored", at(0, 12), { eventName: "push", reason: "Event type “push” is not enabled" }),
      attempt("duplicate", at(0, 13)),
      attempt("rejected", at(0, 14), { statusCode: 429, reason: "This webhook already has 3 unfinished tasks" }),
      attempt("captured", at(0, 15)),
      attempt("accepted", at(0, 16), { webhookId: "other" }),
    ]);
    expect(calls.map((call) => [call.ok ? "✓" : "✗", call.reason])).toEqual([
      ["✓", "Received as a test"], ["✗", "Turned away: too many still waiting"], ["✗", "Already received, so it was skipped"],
      ["✗", "Skipped: it doesn't accept “push”"], ["✗", "Wrong secret (3 times)"], ["✗", "Wrong secret"], ["✓", "Received"],
    ]);
    expect(calls.at(-1)!.preview).toHaveLength(240);
    expect(webhookCalls("hook", Array.from({ length: 40 }, (_, index) => attempt("accepted", index)))).toHaveLength(30);
  });

  it("shows the last thing it accepted, never a turned-away call, falling back to a captured sample", () => {
    const attempts = [attempt("accepted", at(0, 9), { preview: '{ "lead": "Ada" }' }), attempt("rejected", at(0, 10), { preview: "forged" })];
    expect(lastReceived({ id: "hook" }, attempts)).toEqual({ at: at(0, 9), preview: '{ "lead": "Ada" }' });
    expect(lastReceived({ id: "hook", verificationSample: { receivedAt: 5, preview: "{}" } }, [])).toEqual({ at: 5, preview: "{}" });
    expect(lastReceived({ id: "hook" }, [])).toBeNull();
  });
});

describe("order and the grey line", () => {
  it("lists Needs you first, then Working by the soonest next run, then Paused", () => {
    const working = automationsFrom({ routines: [routine({ id: "a", name: "A", nextRunAt: at(3, 9) }), routine({ id: "b", name: "B", nextRunAt: at(1, 9) })], webhooks: [], runs: [] });
    const paused = automationsFrom({ routines: [routine({ id: "p", name: "P", enabled: false })], webhooks: [], runs: [] });
    const failing = automationsFrom({ routines: [routine({ id: "f", name: "F", nextRunAt: at(5, 9) })], webhooks: [], runs: [run("failed", at(0, 9), { routineId: "f", error: "signed out" })] });
    expect(orderAutomations([...paused, ...working, ...failing]).map((item) => item.id)).toEqual(["f", "b", "a", "p"]);
  });

  it("reads Working · last ran · next, and says when it hasn't run yet", () => {
    expect(statusLine(automation([run("completed", at(0, 9, 2))]), NOW)).toBe("Working · last ran today 9:02 AM · next: Monday 9:00 AM");
    expect(statusLine(automation([]), NOW)).toBe("Working · hasn't run yet · next: Monday 9:00 AM");
    expect(statusLine(automation([run("completed", at(-1, 9))], { enabled: false }), NOW)).toBe("Paused · last ran yesterday");
  });

  it("a routine with checks says when it last checked and found nothing new, that it reads and drafts only, and a failed read needs you", () => {
    const watch = { checks: ["calendar", "mail"] as Routine["checks"], access: "read-and-draft" as const, nextRunAt: at(0, 12, 15) };
    expect(statusLine(automation([run("completed", at(0, 9, 2))], { ...watch, checkedAt: at(0, 11, 45) }), NOW)).toBe("Working · checked today 11:45 AM, nothing new · next: today 12:15 PM · reads and drafts only");
    expect(statusLine(automation([run("completed", at(0, 11, 50))], { ...watch, checkedAt: at(0, 11, 45) }), NOW)).toBe("Working · last ran today 11:50 AM · next: today 12:15 PM · reads and drafts only");
    const trouble = automation([], { ...watch, checkTrouble: "Couldn't read Gmail. Reconnect it in Connected apps." });
    expect(automationStatus(trouble, NOW)).toEqual({ state: "needs-you", reason: "Couldn't read Gmail. Reconnect it in Connected apps.", fix: "reconnect" });
  });

  it("writes recent runs as a time, a mark and one line", () => {
    expect(runLine(run("completed", at(0, 9, 2), { output: "3 emails overnight.\nMore detail." }), NOW)).toEqual({ when: "Today 9:02 AM", mark: "✓", text: "3 emails overnight." });
    expect(runLine(run("failed", at(-1, 9), { error: "token expired, sign in again" }), NOW)).toMatchObject({ mark: "✗", text: "It's signed out. Sign in again so it can run." });
  });

  it("says a run that found nothing to tell found nothing new, whatever its last words were", () => {
    expect(runLine(run("completed", at(0, 9, 2), { output: "Checked 14 emails.\nNOTHING NEW", report: { state: "quiet" } }), NOW)).toEqual({ when: "Today 9:02 AM", mark: "✓", text: "Nothing new" });
  });
});

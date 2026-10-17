import { describe, expect, it } from "vitest";

import type { AppTrigger } from "@/lib/app-triggers";
import type { OptionCardData } from "@/state/store";
import type { RoutineRun } from "@/lib/routines";
import { attemptLine, skippedToday } from "./app-automations";
import { applyAppTriggerFrame, applyAppTriggerSnapshot } from "./app-triggers";
import { automationFor, automationSentence, automationsFrom, automationStatus, cardAutomation, statusLine } from "./automations";

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const today = new Date(NOW).toISOString().slice(0, 10);
const trigger = (overrides: Partial<AppTrigger> = {}): AppTrigger => ({
  id: "acme", name: "Acme replies", prompt: "Draft a reply with the order status.", botId: "scout", runOn: "maus", enabled: true,
  app: "gmail", appName: "Gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", eventName: "New Gmail message", delivery: "poll", accountId: "ca_1",
  config: { query: "from:acme.com" }, filter: { from: "Acme" }, remote: { triggerId: "ti_1", state: "active" }, received: 0, filtered: 0,
  createdAt: 0, updatedAt: 0, ...overrides,
});
const run = (status: RoutineRun["status"], at: number): RoutineRun => ({
  id: `run-${at}`, routineId: "acme", routineName: "Acme replies", target: "bot", botId: "scout", runOn: "maus", scheduledFor: at, startedAt: at, createdAt: at,
  status, manual: false, triggerSource: "webhook", eventSource: "app", output: "Drafted a reply to Ada.",
});
const automation = (overrides: Partial<AppTrigger> = {}, runs: RoutineRun[] = []) => automationsFrom({ routines: [], webhooks: [], appTriggers: [trigger(overrides)], runs })[0]!;

describe("an app-event automation in plain words", () => {
  it("reads as one sentence: who it is from and what the bot does", () => {
    expect(automationSentence(automation(), "Scout")).toBe("When you get an email from Acme, Scout drafts a reply with the order status");
    expect(automationSentence(automation({ filter: { from: "Acme", subject: "order" } }), "Scout")).toBe("When you get an email from Acme about “order”, Scout drafts a reply with the order status");
    expect(automationSentence(automation({ app: "slack", appName: "Slack", event: "SLACK_CHANNEL_MESSAGE_RECEIVED", eventName: "New message", filter: undefined, config: { channel_id: "sales" }, prompt: "Log the lead in the CRM." }), "Ledger"))
      .toBe("When a new Slack message arrives in #sales, Ledger logs the lead in the CRM");
    expect(automationSentence(automation({ app: "hubspot", appName: "Hubspot", event: "HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER", eventName: "Deal stage updated", filter: undefined, prompt: "Post a kickoff note." }), "Ops"))
      .toBe("When “Deal stage updated” happens in Hubspot, Ops posts a kickoff note");
  });

  it("leaves technical words a bot put at the end of its instructions out of the sentence", () => {
    expect(automationSentence(automation({ prompt: "Draft a reply to the email in the event data. Do not send it." }), "Scout"))
      .toBe("When you get an email from Acme, Scout drafts a reply to the email");
    expect(automationSentence(automation({ prompt: "Add the lead from the webhook payload" }), "Scout")).toBe("When you get an email from Acme, Scout adds the lead");
    expect(automationSentence(automation({ prompt: "Log the order in the payload" }), "Scout")).toBe("When you get an email from Acme, Scout logs the order");
    expect(automationSentence(automation({ prompt: "Summarize the event for me" }), "Scout")).toBe("When you get an email from Acme, Scout summarizes the event for you");
    const [hook] = automationsFrom({ routines: [], webhooks: [{ id: "h", endpointId: "wh_1", name: "Sales form", prompt: "Draft a follow-up from the webhook data.", botId: "scout", runOn: "maus", enabled: true, createdAt: 0, updatedAt: 0, deliveryCount: 0 }], runs: [] });
    expect(automationSentence(hook!, "Scout")).toBe("When your sales form sends something, Scout drafts a follow-up");
  });

  it("says it checks every 15 minutes and waits for the first email, then shows the last run", () => {
    expect(statusLine(automation(), NOW)).toBe("Working · checks every 15 minutes · waiting for the first email");
    expect(statusLine(automation({ lastEventAt: NOW - 60_000 }, [run("completed", NOW - 60_000)]), NOW)).toMatch(/^Working · last ran today .+ · checks every 15 minutes$/);
    expect(statusLine(automation({ delivery: "instant", event: "SLACK_X" }), NOW)).toBe("Working · waiting for the first one");
  });

  it("needs the person when the app connection expired, with Reconnect as the fix", () => {
    expect(automationStatus(automation({ problem: { kind: "reconnect", at: NOW } }))).toEqual({ state: "needs-you", reason: "Gmail needs to be reconnected.", fix: "reconnect" });
    expect(automationStatus(automation({ problem: { kind: "reconnect", at: NOW }, enabled: false }))).toEqual({ state: "paused" });
    expect(automationStatus(automation({ problem: { kind: "error", text: "bad channel", at: NOW } }))).toMatchObject({ state: "needs-you", fix: "edit" });
  });

  it("shows what was skipped today and why", () => {
    expect(skippedToday(trigger({ skipped: { day: today, dailyLimit: 12, queueFull: 0, expired: 0, tooMany: 1 } }), NOW)).toBe("13 skipped today: daily limit");
    expect(skippedToday(trigger({ skipped: { day: "2026-10-17", dailyLimit: 12, queueFull: 0, expired: 0, tooMany: 0 } }), NOW)).toBeNull();
    expect(statusLine(automation({ skipped: { day: today, dailyLimit: 3, queueFull: 0, expired: 0, tooMany: 0 } }), NOW)).toContain("3 skipped today: daily limit");
    expect(attemptLine({ id: "a", triggerId: "acme", eventId: "m", at: NOW, outcome: "started", preview: "From Ada · Order #1042" })).toEqual({ mark: "✓", text: "Started a run · From Ada · Order #1042" });
    expect(attemptLine({ id: "b", triggerId: "acme", eventId: "n", at: NOW, outcome: "filtered" }).mark).toBe("·");
  });

  it("follows the chat card a bot's create left, and the live frames that change it", () => {
    const card = { autoApplied: true, answered: "allow", appTriggerRequest: { version: 1, requestId: "r", botId: "scout", threadId: "t", createdAt: 0, resultId: "acme", operation: { action: "create", trigger: {} } } } as unknown as OptionCardData;
    expect(cardAutomation(card)).toEqual({ kind: "app", id: "acme" });
    applyAppTriggerSnapshot({ triggers: [trigger()], attempts: [], service: { available: true } });
    applyAppTriggerFrame({ kind: "app-trigger", botId: "scout", trigger: trigger({ enabled: false }) });
    expect(automationFor({ kind: "app", id: "acme" }, { routines: [], webhooks: [], appTriggers: [trigger({ enabled: false })], runs: [] })?.enabled).toBe(false);
  });
});

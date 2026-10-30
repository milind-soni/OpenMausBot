import { describe, expect, it } from "vitest";

import { callTool, type ToolCallContext } from "./agents-call.ts";

function context(answers: { api?: unknown; response?: { ok: boolean; status: number; body: Record<string, unknown> } } = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = {
    api: async (path: string) => { calls.push({ path }); return answers.api ?? {}; },
    apiResponse: async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return answers.response ?? { ok: true, status: 201, body: { resultId: "t-1", summary: "When an email arrives in Gmail from acme.com, Scout follows: Draft." } };
    },
  };
  return { calls, context: { botId: "scout", threadId: "thread-1", depth: 0, externalRuntime: false, sharedComputers: false, client } as unknown as ToolCallContext };
}

describe("app events in the trigger tools", () => {
  it("sends an app_event with its filter in stored words, and says it applied", async () => {
    const { calls, context: ctx } = context();
    const result = await callTool("create_trigger", {
      when: "app_event", name: "Acme", instructions: "Draft.", app: "Gmail", event: "GMAIL_NEW_GMAIL_MESSAGE",
      filter: { from: "acme.com", subject_contains: "order", label: "" }, event_config: { interval: 15 },
    }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Created the app-event trigger “Acme” (trigger id t-1). It applied at once");
    expect(calls[0]).toEqual({ path: "/api/internal/trigger-requests", body: {
      fromBotId: "scout", fromThreadId: "thread-1", action: "create", kind: "app",
      trigger: { name: "Acme", instructions: "Draft.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { from: "acme.com", subject: "order" }, config: { interval: 15 } },
    } });
  });

  it("refuses fields of the other kinds and a missing app or event, before anything is sent", async () => {
    const { calls, context: ctx } = context();
    expect((await callTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", schedule: { type: "daily", time: "09:00" } }, ctx)).text)
      .toContain("takes no schedule");
    expect((await callTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail" }, ctx)).text).toContain("Call trigger_info action=events first");
    expect((await callTool("create_trigger", { when: "schedule", name: "A", instructions: "B", app: "gmail", schedule: { type: "daily", time: "09:00" } }, ctx)).text)
      .toBe("app applies only to when=app_event.");
    expect((await callTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", filter: { cc: "x" } }, ctx)).text)
      .toContain("filter takes from, subject_contains, label and contains");
    expect(calls).toEqual([]);
  });

  it("lists events and names apps to connect, or says why there are none", async () => {
    const listed = await callTool("list_trigger_events", { app: "Gmail" }, context({ api: {
      apps: [{ app: "gmail", name: "Gmail", accounts: [], events: [{ event: "GMAIL_NEW_GMAIL_MESSAGE", delivery: "poll" }] }],
      notConnected: [{ app: "slack", name: "Slack" }],
    } }).context);
    expect(listed.text).toContain("GMAIL_NEW_GMAIL_MESSAGE");
    expect(listed.text).toContain("Not connected yet: Slack.");
    const none = context({ api: { apps: [], notConnected: [], unavailable: "App events need OpenMausBot's connected apps." } });
    expect((await callTool("list_trigger_events", {}, none.context)).text).toBe("App events need OpenMausBot's connected apps.");
    expect(none.calls[0]!.path).toBe("/api/internal/trigger-events?fromBotId=scout&fromThreadId=thread-1");
  });

  it("updates an app event's filter and settings through manage_trigger", async () => {
    const { calls, context: ctx } = context();
    await callTool("manage_trigger", { trigger_id: "t-1", action: "update", changes: { filter: { contains: "urgent" }, event_config: { channel_id: "C1" } } }, ctx);
    expect(calls[0]!.body).toMatchObject({ action: "update", triggerId: "t-1", changes: { filter: { text: "urgent" }, config: { channel_id: "C1" } } });
  });
});

describe("a schedule's confirmation, in the person's words", () => {
  // tomorrow at 9:00 in India, from today's date there
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(Date.now());
  const nextRunAt = Date.parse(`${today}T03:30:00Z`) + 86_400_000;
  const applied = (action: string) => context({ response: { ok: true, status: 201, body: {
    result: { resultId: "r-1" }, nextRunAt, timeZone: "Asia/Calcutta",
    summary: `${action === "create" ? "Create routine" : "Update routine"} “AI news” · weekdays at 9:00 India time · Bot’s current model, where it usually works · no run limit`,
  } } });
  const schedule = { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] };

  it("asks for what was assumed, with the time zone as people say it and the first run in words", async () => {
    const result = await callTool("create_trigger", { when: "schedule", name: "AI news", instructions: "Send five bullets of AI news.", schedule }, applied("create").context);
    expect(result.isError).toBeUndefined();
    expect(result.text).not.toContain("Asia/Calcutta");
    expect(result.text).toMatch(/tell the person what you set up and what you assumed: when it runs, saying the time zone as "India time", never as a zone id; where its results will appear \(here in this chat\); what each run covers; and that the first run is tomorrow \(\w+, \w+ \d+\) at 9:00 AM India time\.$/);
  });

  it("says what changed and the next run for an update, and one sentence for the rest", async () => {
    const update = await callTool("manage_trigger", { trigger_id: "r-1", action: "update", changes: { schedule } }, applied("update").context);
    expect(update.text).toMatch(/Tell the person in one plain sentence what changed, saying the time zone as "India time", and that the next run is tomorrow/);
    const paused = await callTool("manage_trigger", { trigger_id: "r-1", action: "pause" }, context({ response: { ok: true, status: 201, body: { result: { resultId: "r-1" }, nextRunAt: null, timeZone: "Asia/Calcutta" } } }).context);
    expect(paused.text).toMatch(/Tell the person in one sentence what will happen\.$/);
  });
});

describe("the trigger tool's actions", () => {
  it("updates with the fields to change at the top level, and refuses what an action cannot take, before anything is sent", async () => {
    const { calls, context: ctx } = context();
    await callTool("trigger", { action: "update", trigger_id: "t-1", name: "Inbox", run_on: null, filter: { contains: "urgent" } }, ctx);
    expect(calls[0]!.body).toEqual({ fromBotId: "scout", fromThreadId: "thread-1", action: "update", triggerId: "t-1", changes: { name: "Inbox", filter: { text: "urgent" } } });
    const refused = context();
    const text = async (args: Record<string, unknown>) => (await callTool("trigger", args, refused.context)).text;
    expect(await text({ action: "update", trigger_id: "t-1" })).toBe("The update action needs at least one supported field to change.");
    expect(await text({ action: "update", trigger_id: "t-1", when: "schedule", name: "A" })).toBe("when applies only to action=create.");
    expect(await text({ action: "pause", trigger_id: "t-1", name: "A" })).toBe("The pause action changes no fields; send them with action=update.");
    expect(await text({ action: "delete", trigger_id: "t-1" })).toBe("trigger does not delete: call delete_trigger with the trigger_id.");
    expect(await text({ action: "pause" })).toBe("trigger action=pause needs the trigger_id from trigger_info.");
    expect(await text({ action: "create", trigger_id: "t-1", when: "webhook", name: "A", instructions: "B" })).toBe("trigger_id is for a trigger that exists; leave it out to create one.");
    expect(await text({ trigger_id: "t-1" })).toContain("trigger needs action: create, or update, pause, resume or run_now");
    const deletes = async (args: Record<string, unknown>) => (await callTool("delete_trigger", args, refused.context)).text;
    expect(await deletes({})).toBe("delete_trigger needs the trigger_id from trigger_info.");
    expect(await deletes({ trigger_id: "t-1", schedule: { type: "daily", time: "09:00" } })).toBe("delete_trigger takes only trigger_id and for_bot_id.");
    expect((await callTool("trigger_info", { action: "delete" }, refused.context)).text).toBe("trigger_info action is list or events.");
    expect(refused.calls).toEqual([]);
  });

  it("lists triggers or events by action", async () => {
    const listed = context({ api: { now: "2026-10-29T09:00:00Z", timeZone: "UTC", triggers: [] } });
    expect((await callTool("trigger_info", { action: "list", for_bot_id: "helper" }, listed.context)).text).toContain("This bot has no triggers.");
    expect(listed.calls[0]!.path).toBe("/api/internal/triggers?fromBotId=scout&fromThreadId=thread-1&forBotId=helper");
    const events = context({ api: { apps: [], notConnected: [] } });
    await callTool("trigger_info", { action: "events", app: "Gmail" }, events.context);
    expect(events.calls[0]!.path).toBe("/api/internal/trigger-events?fromBotId=scout&fromThreadId=thread-1&app=gmail");
  });
});

describe("delete_trigger", () => {
  it("deletes one trigger, its own or another bot's in the section, and nothing else", async () => {
    const { calls, context: ctx } = context();
    const result = await callTool("delete_trigger", { trigger_id: " t-1 ", for_bot_id: "helper" }, ctx);
    expect(result.text).toContain("Applied delete to trigger t-1 (trigger id t-1). It applied at once");
    expect(calls).toEqual([{ path: "/api/internal/trigger-requests", body: { fromBotId: "scout", fromThreadId: "thread-1", action: "delete", triggerId: "t-1", forBotId: "helper" } }]);
  });
});

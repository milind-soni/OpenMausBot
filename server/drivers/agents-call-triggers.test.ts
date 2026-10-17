import { describe, expect, it } from "vitest";

import { callTriggerTool } from "./agents-call-triggers.ts";
import type { ToolCallContext } from "./agents-call.ts";

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
    const result = await callTriggerTool("create_trigger", {
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
    expect((await callTriggerTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", schedule: { type: "daily", time: "09:00" } }, ctx)).text)
      .toContain("takes no schedule");
    expect((await callTriggerTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail" }, ctx)).text).toContain("Call list_trigger_events first");
    expect((await callTriggerTool("create_trigger", { when: "schedule", name: "A", instructions: "B", app: "gmail", schedule: { type: "daily", time: "09:00" } }, ctx)).text)
      .toBe("app applies only to when=app_event.");
    expect((await callTriggerTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", filter: { cc: "x" } }, ctx)).text)
      .toContain("filter takes from, subject_contains, label and contains");
    expect(calls).toEqual([]);
  });

  it("lists events and names apps to connect, or says why there are none", async () => {
    const listed = await callTriggerTool("list_trigger_events", { app: "Gmail" }, context({ api: {
      apps: [{ app: "gmail", name: "Gmail", accounts: [], events: [{ event: "GMAIL_NEW_GMAIL_MESSAGE", delivery: "poll" }] }],
      notConnected: [{ app: "slack", name: "Slack" }],
    } }).context);
    expect(listed.text).toContain("GMAIL_NEW_GMAIL_MESSAGE");
    expect(listed.text).toContain("Not connected yet: Slack.");
    const none = context({ api: { apps: [], notConnected: [], unavailable: "App events need OpenMausBot's connected apps." } });
    expect((await callTriggerTool("list_trigger_events", {}, none.context)).text).toBe("App events need OpenMausBot's connected apps.");
    expect(none.calls[0]!.path).toBe("/api/internal/trigger-events?fromBotId=scout&fromThreadId=thread-1");
  });

  it("updates an app event's filter and settings through manage_trigger", async () => {
    const { calls, context: ctx } = context();
    await callTriggerTool("manage_trigger", { trigger_id: "t-1", action: "update", changes: { filter: { contains: "urgent" }, event_config: { channel_id: "C1" } } }, ctx);
    expect(calls[0]!.body).toMatchObject({ action: "update", triggerId: "t-1", changes: { filter: { text: "urgent" }, config: { channel_id: "C1" } } });
  });
});

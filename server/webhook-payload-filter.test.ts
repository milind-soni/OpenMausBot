import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { callTool, type ToolCallContext } from "./drivers/agents-call.ts";
import { fullInputSchema } from "./drivers/agents-catalog.ts";
import { parseTriggerRequest } from "./trigger-tools.ts";
import { unmatchedPayloadField, WebhookManager, type WebhookManagerOptions } from "./webhooks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-webhook-filter-"));
  dirs.push(dir);
  const queued: Array<Record<string, unknown>> = [];
  let run = 0;
  const options: WebhookManagerOptions = {
    file: join(dir, "webhooks.json"),
    botState: () => "ready",
    enqueue: (input) => {
      queued.push(input);
      return { id: `run-${++run}` };
    },
  };
  return { manager: new WebhookManager(options), options, queued };
}

describe("webhook payload filter", () => {
  it("matches dotted fields case-insensitively, searches lists, and names the first field that misses", () => {
    const payload = { action: "Opened", pull_request: { base: { ref: "main" }, draft: false, number: 7 }, labels: [{ name: "bug" }, { name: "ui" }], tags: ["a", "b"] };
    expect(unmatchedPayloadField(undefined, payload)).toBeNull();
    expect(unmatchedPayloadField({ action: "opened", "pull_request.base.ref": "MAIN" }, payload)).toBeNull();
    expect(unmatchedPayloadField({ "pull_request.draft": "false", "pull_request.number": "7" }, payload)).toBeNull();
    expect(unmatchedPayloadField({ "labels.name": "ui", tags: "b", "labels.0.name": "bug" }, payload)).toBeNull();
    expect(unmatchedPayloadField({ action: "opened", "labels.1.name": "bug" }, payload)).toBe("labels.1.name");
    expect(unmatchedPayloadField({ "pull_request.base": "main" }, payload)).toBe("pull_request.base");
    expect(unmatchedPayloadField({ missing: "x" }, payload)).toBe("missing");
    expect(unmatchedPayloadField({ action: "opened" }, "action=opened")).toBe("action");
    expect(unmatchedPayloadField({ toString: "x" }, {})).toBe("toString");
  });

  it("records a call that does not match as ignored and starts no run; a matching call runs", () => {
    const h = harness();
    const { webhook, secret } = h.manager.create({ name: "Doorbell", prompt: "Answer it", botId: "maus-1", payloadFilter: { " status ": " ring ", "visitor.known": "" } });
    expect(webhook.payloadFilter).toEqual({ status: "ring" });

    expect(h.manager.receive(webhook.endpointId, secret, { payload: { status: "idle" }, deliveryId: "d-1" })).toMatchObject({ ignored: true });
    expect(h.queued).toHaveLength(0);
    expect(h.manager.listAttempts().find((attempt) => attempt.outcome === "ignored")).toMatchObject({ outcome: "ignored", reason: "Field “status” does not match the payload filter" });

    expect(h.manager.receive(webhook.endpointId, secret, { payload: { status: "RING" }, deliveryId: "d-2" })).toMatchObject({ duplicate: false });
    expect(h.queued).toHaveLength(1);
  });

  it("keeps the filter across a restart and an unrelated edit, removes it with null or {}, and lets Run now through", () => {
    const h = harness();
    const { webhook, secret } = h.manager.create({ name: "Doorbell", prompt: "Answer it", botId: "maus-1", payloadFilter: { status: "ring" } });
    const reloaded = new WebhookManager(h.options);
    expect(reloaded.list()[0]!.payloadFilter).toEqual({ status: "ring" });
    expect(reloaded.update(webhook.id, { name: "Front door" })!.payloadFilter).toEqual({ status: "ring" });

    expect(reloaded.test(webhook.id)).toMatchObject({ duplicate: false });
    expect(h.queued).toHaveLength(1);

    expect(reloaded.update(webhook.id, { payloadFilter: {} })!.payloadFilter).toBeUndefined();
    expect(reloaded.receive(webhook.endpointId, secret, { payload: { status: "idle" }, deliveryId: "d-3" })).not.toMatchObject({ ignored: true });
    expect(reloaded.update(webhook.id, { payloadFilter: { status: "ring" } })!.payloadFilter).toEqual({ status: "ring" });
    expect(reloaded.update(webhook.id, { payloadFilter: null })!.payloadFilter).toBeUndefined();
  });

  it("refuses more than 10 fields", () => {
    const h = harness();
    const payloadFilter = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`f${index}`, "x"]));
    expect(() => h.manager.create({ name: "Too many", prompt: "x", botId: "maus-1", payloadFilter })).toThrow();
  });
});

describe("webhook_payload_filter in the trigger tool", () => {
  function context() {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const client = {
      api: async (path: string) => { calls.push({ path }); return {}; },
      apiResponse: async (path: string, init: RequestInit) => {
        calls.push({ path, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, body: { resultId: "t-1", summary: "When another app sends something, Scout follows: Answer." } };
      },
    };
    return { calls, context: { botId: "scout", threadId: "thread-1", externalRuntime: false, sharedComputers: false, client } as unknown as ToolCallContext };
  }

  it("sends the filter on a webhook create and update", async () => {
    const { calls, context: ctx } = context();
    const created = await callTool("trigger", { action: "create", when: "webhook", name: "Doorbell", instructions: "Answer.", webhook_payload_filter: { " status ": "ring", count: 2 } }, ctx);
    expect(created.isError).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ action: "create", kind: "webhook", webhook: { name: "Doorbell", payloadFilter: { status: "ring", count: "2" } } });
    await callTool("trigger", { action: "update", trigger_id: "t-1", webhook_payload_filter: {} }, ctx);
    expect(calls[1]!.body).toMatchObject({ action: "update", triggerId: "t-1", changes: { payloadFilter: {} } });
    await callTool("trigger", { action: "update", trigger_id: "t-1", webhook_payload_filter: null }, ctx);
    expect(calls[2]!.body).toMatchObject({ action: "update", triggerId: "t-1", changes: { payloadFilter: null } });
  });

  it("reads a null filter on another kind's update as nothing to change", () => {
    const update = (kind: "schedule" | "app") => parseTriggerRequest({ fromBotId: "b", fromThreadId: "t", action: "update", triggerId: "r-1", changes: { name: "N", payloadFilter: null } }, () => kind);
    expect(update("schedule")).toMatchObject({ ok: true, proposal: { changes: { name: "N" } } });
    expect(update("app")).toMatchObject({ ok: true, operation: { changes: { name: "N" } } });
    expect(JSON.stringify([update("schedule"), update("app")])).not.toContain("payloadFilter");
  });

  it("refuses it on other kinds and refuses a malformed filter before anything is sent", async () => {
    const { calls, context: ctx } = context();
    expect((await callTool("trigger", { action: "create", when: "schedule", name: "A", instructions: "B", schedule: { type: "daily", time: "09:00" }, webhook_payload_filter: { a: "b" } }, ctx)).text)
      .toBe("webhook_payload_filter applies only to when=webhook.");
    expect((await callTool("trigger", { action: "create", when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", webhook_payload_filter: { a: "b" } }, ctx)).text)
      .toContain("takes no webhook_payload_filter");
    expect((await callTool("trigger", { action: "create", when: "webhook", name: "A", instructions: "B", webhook_payload_filter: ["a"] }, ctx)).text)
      .toContain("webhook_payload_filter must be an object");
    expect((await callTool("trigger", { action: "create", when: "webhook", name: "A", instructions: "B", webhook_payload_filter: { a: { b: 1 } } }, ctx)).text)
      .toContain("webhook_payload_filter must be an object");
    expect(calls).toEqual([]);
    expect(parseTriggerRequest({ fromBotId: "b", fromThreadId: "t", action: "update", triggerId: "r-1", changes: { payloadFilter: { a: "b" } } }, () => "schedule"))
      .toEqual({ ok: false, error: "webhook_payload_filter applies only to webhook triggers" });
  });
});

describe("webhook_payload_filter in the tool schema", () => {
  it("advertises {} (a plain object) to clear the filter, never a null the schema would refuse", () => {
    const schema = fullInputSchema("trigger") as { properties: Record<string, { type: unknown; description: string }> };
    const field = schema.properties.webhook_payload_filter!;
    expect(field.type).toBe("object");
    expect(field.description).toContain("{} in an update removes it");
    expect(field.description).not.toMatch(/\bnull\b/);
  });
});

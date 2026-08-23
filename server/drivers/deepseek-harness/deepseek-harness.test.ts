import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DeepSeekHarnessDriver } from "./index.ts";
import { encodeDshModelId } from "./models.ts";
import { dshClientRequestSchema, dshClientResponseSchema, dshJsonValueSchema, type DshClientRequest, type DshJsonValue } from "./protocol.ts";
import { FakeDshHost } from "../../testing/fake-dsh-host.ts";
import { recordEvents } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";

const hosts: FakeDshHost[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

async function host(): Promise<FakeDshHost> {
  const fake = new FakeDshHost();
  hosts.push(fake);
  await fake.start();
  return fake;
}

function response(rpcId: string, value: DshJsonValue): DshJsonValue {
  return dshJsonValueSchema.parse({ type: "server-response", rpcId, result: { ok: true, value } });
}

function officialResponse(request: DshClientRequest, sessionId = "fixture-session"): DshJsonValue {
  switch (request.method) {
    case "session.create": return response(request.rpcId, { sessionId });
    case "session.selectModel": {
      const selected = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).parse(request.payload);
      return response(request.rpcId, { selected });
    }
    case "session.prompt":
    case "session.cancel": return response(request.rpcId, { accepted: true });
    case "host.describe": return response(request.rpcId, { version: "fixture", cwd: "/fixture", attachedSessions: 0, home: "/fixture", canOpenPath: false });
    case "llm.models": return response(request.rpcId, { groups: [], failures: [] });
    case "agentPreset.list": return response(request.rpcId, { presets: [], authorable: false, hasDocument: false });
    default: throw new Error(`unsupported fixture method ${request.method}`);
  }
}

const accepted = (): DshJsonValue => dshJsonValueSchema.parse({ accepted: true });

describe("DeepSeek Harness provider configuration", () => {
  it("is registered as a built-in provider", () => {
    expect(BUILT_IN_DRIVERS).toContain(DeepSeekHarnessDriver);
  });

  it("uses the direct loopback defaults and rejects malformed or unsafe config", () => {
    expect(DeepSeekHarnessDriver.defaultConfig()).toEqual({
      baseUrl: "http://127.0.0.1:3080",
      transport: "direct",
    });
    expect(DeepSeekHarnessDriver.decodeConfig({
      baseUrl: "https://dsh.example.test",
      transport: "paired",
      deviceCookie: "dsh_device=fixture-value",
      agentPreset: "coding",
    })).toEqual({
      baseUrl: "https://dsh.example.test",
      transport: "paired",
      deviceCookie: "dsh_device=fixture-value",
      agentPreset: "coding",
    });
    expect(() => DeepSeekHarnessDriver.decodeConfig({ baseUrl: "https://dsh.example.test/path" })).toThrow();
    expect(() => DeepSeekHarnessDriver.decodeConfig({ baseUrl: "https://dsh.example.test?token=fixture" })).toThrow();
    expect(() => DeepSeekHarnessDriver.decodeConfig({ transport: "paired" })).toThrow();
    expect(() => DeepSeekHarnessDriver.decodeConfig({ baseUrl: "ftp://dsh.example.test" })).toThrow();
    expect(() => DeepSeekHarnessDriver.decodeConfig({ unexpected: true })).toThrow();
  });
});

describe("DeepSeek Harness availability and catalog", () => {
  it("probes host.describe and refreshes the live DSH model catalog", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      const value: DshJsonValue = request.method === "host.describe"
        ? { version: "fixture-host-1", cwd: "/fixture", attachedSessions: 0, home: "/fixture", canOpenPath: false }
        : {
            groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "chat", name: "Chat" }] }],
            failures: [],
          };
      return response(request.rpcId, value);
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });

    await expect(instance.snapshot()).resolves.toEqual({
      state: "available",
      authenticated: true,
      version: "fixture-host-1",
    });
    await instance.refreshModels?.();
    expect(instance.models.options).toEqual([
      expect.objectContaining({ label: "DeepSeek: Chat" }),
    ]);
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/host.describe",
      "/api/llm.models",
      "/api/llm.models",
    ]);
    await instance.dispose();
  });

  it("clears a stale catalog when every later host catalog is invalid", async () => {
    const fake = await host();
    let healthy = true;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      if (request.method === "host.describe") return officialResponse(request);
      return response(request.rpcId, healthy
        ? { groups: [{ id: "d", name: "D", models: [{ id: "m", name: "M" }] }], failures: [] }
        : { groups: [], failures: [{ id: "d", name: "D", message: "fixture-secret" }] });
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    await instance.refreshModels?.();
    expect(instance.models.options).toHaveLength(1);
    healthy = false;
    await instance.refreshModels?.();
    expect(instance.models.options).toEqual([]);
    await expect(instance.snapshot()).resolves.toEqual({ state: "unavailable", reason: "DeepSeek Harness model catalog is unavailable" });
    await instance.dispose();
  });
});

describe("DeepSeek Harness stream readiness", () => {
  it.each(["mux", "host"] as const)("fails before unary startup when the physical %s stream never opens", async (kind) => {
    const fake = await host();
    fake.setStreamBlocked(kind, true);
    fake.onRequest = ({ body }) => officialResponse(dshClientRequestSchema.parse(body), "never-open-session");
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);

    await expect(instance.adapter.sendTurn({ threadId: `never-open-${kind}`, text: "x", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("event streams did not open");

    expect(fake.requests).toEqual([]);
    expect(events.events.filter((event) => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ ok: false, stopReason: "start_failed" }),
    ]);
    fake.setStreamBlocked(kind, false);
    await instance.dispose();
    events.stop();
  });

  it("waits through a half-open generation and starts only after both streams recover", async () => {
    const fake = await host();
    fake.setStreamBlocked("host", true);
    fake.onRequest = ({ body }) => officialResponse(dshClientRequestSchema.parse(body), "half-open-session");
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });

    const start = instance.adapter.sendTurn({ threadId: "half-open", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.requests).toEqual([]);

    fake.setStreamBlocked("host", false);
    await fake.waitForStream("host");
    await expect(start).resolves.toEqual({ turnId: expect.any(String) });
    expect(fake.requests.map((entry) => dshClientRequestSchema.parse(entry.body).method)).toEqual([
      "session.create",
      "session.selectModel",
      "session.prompt",
    ]);
    await instance.dispose();
  });
});

describe("DeepSeek Harness turns", () => {
  it("creates a configured session, selects the exact model, and queues a persona-wrapped first prompt", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "dsh-session-1");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct", agentPreset: "coding" },
    });
    const events: unknown[] = [];
    instance.adapter.onEvent((event) => events.push(event));

    const start = await instance.adapter.sendTurn({
      threadId: "thread-1",
      text: "Fix the fixture",
      system: "You are the release engineer.",
      cwd: "/workspace/project",
      model: encodeDshModelId("openrouter", "deepseek/chat"),
      effort: "high",
    });

    expect(start.turnId).toEqual(expect.any(String));
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body))).toEqual([
      expect.objectContaining({ method: "session.create", payload: { cwd: "/workspace/project", agentPreset: "coding" } }),
      expect.objectContaining({
        method: "session.selectModel",
        payload: { sessionId: "dsh-session-1", provider: "openrouter", model: "deepseek/chat", reasoningEffort: "high" },
      }),
      expect.objectContaining({
        method: "session.prompt",
        payload: {
          sessionId: "dsh-session-1",
          mode: "queue",
          content: [{ type: "text", text: "<openmausbot-persona>\nYou are the release engineer.\n</openmausbot-persona>\n\nFix the fixture" }],
        },
      }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn.started", threadId: "thread-1" }),
      expect.objectContaining({ type: "session.started", sessionId: "dsh-session-1" }),
    ]));
    await instance.dispose();
  });

  it("resumes an existing session, steers a live turn, and cancels it", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "dsh-existing-session");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });
    const model = encodeDshModelId("deepseek", "reasoner");
    const start = await instance.adapter.sendTurn({
      threadId: "thread-resume",
      text: "Continue from the checkpoint",
      system: "This must not be sent again.",
      resumeCursor: "dsh-existing-session",
      model,
    });

    await expect(instance.adapter.steer?.("thread-resume", "Use the narrow fix.")).resolves.toBe(true);
    await instance.adapter.interruptTurn("thread-resume", start.turnId);
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body))).toEqual([
      expect.objectContaining({ method: "session.create", payload: { sessionId: "dsh-existing-session", cwd: expect.any(String) } }),
      expect.objectContaining({ method: "session.selectModel", payload: { sessionId: "dsh-existing-session", provider: "deepseek", model: "reasoner" } }),
      expect.objectContaining({ method: "session.prompt", payload: { sessionId: "dsh-existing-session", mode: "queue", content: [{ type: "text", text: "<openmausbot-persona>\nThis must not be sent again.\n</openmausbot-persona>\n\nContinue from the checkpoint" }] } }),
      expect.objectContaining({ method: "session.prompt", payload: { sessionId: "dsh-existing-session", mode: "steer", content: [{ type: "text", text: "Use the narrow fix." }] } }),
      expect.objectContaining({ method: "session.cancel", payload: { sessionId: "dsh-existing-session" } }),
    ]);
    await instance.dispose();
  });

  it("maps the canonical none effort back to DSH off for exact model selection", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "effort-session");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });

    await instance.adapter.sendTurn({
      threadId: "effort-thread",
      text: "No reasoning",
      model: encodeDshModelId("deepseek", "chat"),
      effort: "none",
    });
    const select = fake.requests.map((request) => dshClientRequestSchema.parse(request.body)).find((request) => request.method === "session.selectModel");
    expect(select?.payload).toEqual({ sessionId: "effort-session", provider: "deepseek", model: "chat", reasoningEffort: "off" });
    await instance.dispose();
  });

  it("accepts the Host materializing its model default when no effort was requested", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      if (request.method === "session.selectModel") {
        const selected = z.object({ provider: z.string(), model: z.string() }).parse(request.payload);
        return response(request.rpcId, { selected: { ...selected, reasoningEffort: "high" } });
      }
      return officialResponse(request, "default-effort-session");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });

    await expect(instance.adapter.sendTurn({
      threadId: "default-effort-thread",
      text: "Use the model default",
      model: encodeDshModelId("deepseek", "chat"),
    })).resolves.toEqual({ turnId: expect.any(String) });
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method)).toEqual([
      "session.create",
      "session.selectModel",
      "session.prompt",
    ]);
    await instance.dispose();
  });

  it.each([
    ["provider", { provider: "wrong-provider", model: "requested", reasoningEffort: "high" }, "wrong-provider"],
    ["model", { provider: "openrouter", model: "wrong/model", reasoningEffort: "high" }, "wrong/model"],
    ["effort", { provider: "openrouter", model: "requested", reasoningEffort: "xhigh" }, "xhigh"],
  ] as const)("fails closed when DSH acknowledges a different %s before prompting", async (_field, selected, leakMarker) => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      if (request.method === "session.selectModel") {
        return response(request.rpcId, { selected });
      }
      return officialResponse(request, "selection-changed-session");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });
    const events = recordEvents(instance.adapter);

    await expect(instance.adapter.sendTurn({
      threadId: "selection-changed",
      text: "Never send this prompt to a fallback model",
      model: encodeDshModelId("openrouter", "requested"),
      effort: "high",
    })).rejects.toThrow("did not preserve the requested model and effort");

    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method)).toEqual([
      "session.create",
      "session.selectModel",
    ]);
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "runtime.error", message: "DeepSeek Harness turn could not start" }),
      expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "start_failed" }),
    ]));
    expect(JSON.stringify(events.events)).not.toContain(leakMarker);

    events.stop();
    await instance.dispose();
  });

  it("normalizes streamed events once and brokers approvals plus batched questions", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "event-session");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });
    const events = recordEvents(instance.adapter);
    const start = await instance.adapter.sendTurn({
      threadId: "event-thread",
      text: "Run the task",
      model: encodeDshModelId("deepseek", "chat"),
    });
    await fake.waitForStream("mux");

    const event = (rpcId: string, type: string, data: DshJsonValue) => ({ type: "server-request", rpcId, method: "session/event", payload: { type: "session/event", sessionId: "event-session", event: { type, seq: 1, time: 1, data } } });
    fake.send("mux", event("turn-start", "turn/start", { turn: 1 }));
    fake.send("mux", event("text-1", "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hello" } }));
    fake.send("mux", event("text-1", "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hello" } }));
    fake.send("mux", event("reasoning-1", "assistant/chunk", { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "think" } }));
    fake.send("mux", event("tool-start", "tool/call", { turn: 1, step: 1, callId: "tool-1", name: "shell", arguments: {} }));
    fake.send("mux", event("tool-end", "tool/result", { turn: 1, step: 1, message: { source: { callId: "tool-1" } } }));
    fake.send("mux", event("assistant-done", "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, usage: { inputTokens: 3, outputTokens: 5 } }));
    fake.send("mux", { type: "server-request", rpcId: "approval-frame", method: "approval/requested", payload: { type: "approval/requested", sessionId: "event-session", approvalId: "approval-1", toolName: "shell", reason: "run fixture" } });
    fake.send("mux", { type: "server-request", rpcId: "questions-frame", method: "question/requested", payload: { type: "question/requested", sessionId: "event-session", questions: [{ id: "question-1", question: "Which option?", options: [{ label: "A" }, { label: "B" }] }, { id: "question-2", question: "Proceed?" }] } });

    await events.until((event) => event.type === "request.opened" && event.summary === "Proceed?");
    expect(events.events.filter((event) => event.type === "content.delta" && event.streamKind === "assistant_text")).toHaveLength(1);
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn.started", turnId: start.turnId }),
      expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "think" }),
      expect.objectContaining({ type: "item.started", itemType: "tool", itemId: "tool-1", title: "shell" }),
      expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "tool-1", ok: true }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "hello" }),
      expect.objectContaining({ type: "thread.token-usage.updated", input: 3, output: 5 }),
    ]));

    const opened = events.events.filter((event) => event.type === "request.opened");
    const approvalId = opened.find((event) => event.type === "request.opened" && event.requestType === "permission")!.requestId!;
    const firstQuestionId = opened.find((event) => event.type === "request.opened" && event.summary === "Which option?")!.requestId!;
    const secondQuestionId = opened.find((event) => event.type === "request.opened" && event.summary === "Proceed?")!.requestId!;
    await expect(instance.adapter.respondToRequest("event-thread", approvalId, { behavior: "allow" })).resolves.toBe("allowed-once");
    await expect(instance.adapter.respondToRequest("event-thread", firstQuestionId, { behavior: "answer", message: "A" })).resolves.toBe("answered");
    expect(fake.requests.filter((request) => request.path.endsWith("/respond"))).toHaveLength(1);
    await expect(instance.adapter.respondToRequest("event-thread", secondQuestionId, { behavior: "answer", message: "yes" })).resolves.toBe("answered");
    expect(fake.requests.filter((request) => request.path.endsWith("/respond"))).toHaveLength(2);

    fake.send("mux", event("turn-end", "turn/end", { turn: 1, reason: { kind: "completed" }, usage: { inputTokens: 3, outputTokens: 5 } }));
    await events.until((event) => event.type === "turn.completed" && event.turnId === start.turnId);
    expect(events.events.filter((event) => event.type === "turn.completed" && event.turnId === start.turnId)).toHaveLength(1);
    expect(instance.adapter.hasSession("event-thread")).toBe(true);
    events.stop();
    await instance.dispose();
  });

  it("recovers its event stream and makes outstanding requests unavailable during stopAll and dispose", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "reconnect-session");
    };
    const instance = await DeepSeekHarnessDriver.create({
      instanceId: "deepseekHarness",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { baseUrl: fake.baseUrl, transport: "direct" },
    });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "reconnect-thread",
      text: "Keep working",
      model: encodeDshModelId("deepseek", "chat"),
    });
    await fake.waitForStream("mux");
    const closed = fake.waitForNoStreams("mux");
    fake.closeStreams("mux");
    await closed;
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "after-reconnect", method: "session/event", payload: { type: "session/event", sessionId: "reconnect-session", event: { type: "assistant/chunk", seq: 1, time: 1, data: { chunk: { type: "text-delta", text: "recovered" } } } } });
    await events.until((event) => event.type === "content.delta" && event.delta === "recovered");
    fake.send("mux", { type: "server-request", rpcId: "pending-approval", method: "approval/requested", payload: { type: "approval/requested", sessionId: "reconnect-session", approvalId: "pending-1", toolName: "shell", reason: "wait" } });
    const pending = await events.until((event) => event.type === "request.opened" && event.summary === "wait");
    const pendingId = pending.type === "request.opened" ? pending.requestId! : "";

    await instance.adapter.stopAll();
    await events.until((event) => event.type === "request.resolved" && event.requestId === pendingId && event.source === "unavailable");
    await expect(instance.adapter.respondToRequest("reconnect-thread", pendingId, { behavior: "allow" })).resolves.toBe("unavailable");
    expect(instance.adapter.hasSession("reconnect-thread")).toBe(false);
    const streamsClosed = Promise.all([fake.waitForNoStreams("mux"), fake.waitForNoStreams("host")]);
    await instance.dispose();
    await streamsClosed;
    events.stop();
  });

  it("fails once on asymmetric host-stream loss and accepts a new turn after recovery", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "asymmetric-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const model = encodeDshModelId("deepseek", "chat");
    await instance.adapter.sendTurn({ threadId: "asymmetric", text: "first", model });
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);

    fake.setStreamBlocked("host", true);
    const hostClosed = fake.waitForNoStreams("host");
    fake.closeStreams("host");
    await hostClosed;
    const failed = await events.until((event) => event.type === "turn.completed" && event.stopReason === "stream_lost", 2_000);
    expect(failed.threadId).toBe("asymmetric");
    expect(events.events.filter((event) => event.type === "turn.completed" && event.threadId === "asymmetric")).toHaveLength(1);
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method).filter((method) => method === "session.cancel")).toHaveLength(1);

    fake.setStreamBlocked("host", false);
    await fake.waitForStream("host");
    const second = await instance.adapter.sendTurn({ threadId: "asymmetric", text: "second", model });
    fake.send("mux", { type: "server-request", rpcId: "asymmetric-end", method: "session/event", payload: { type: "session/event", sessionId: "asymmetric-session", event: { type: "turn/end", seq: 2, time: 2, data: { reason: { kind: "completed" } } } } });
    await events.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    expect(events.events.filter((event) => event.type === "turn.completed" && event.threadId === "asymmetric")).toHaveLength(2);
    await instance.dispose();
    events.stop();
  });

  it("fails an accepted held prompt within stream grace when mux recovery never opens", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.prompt";
    fake.onRequest = ({ body }) => officialResponse(dshClientRequestSchema.parse(body), "held-prompt-loss-session");
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);

    const start = instance.adapter.sendTurn({ threadId: "held-prompt-loss", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();
    fake.setStreamHandshakeHung("mux", true);
    const closed = fake.waitForNoStreams("mux");
    fake.closeStreams("mux");
    await closed;
    await fake.waitForHungStreamHandshake("mux");
    fake.releaseRawResponses();

    await expect(start).resolves.toEqual({ turnId: expect.any(String) });
    const terminal = await events.until((event) => event.type === "turn.completed" && event.threadId === "held-prompt-loss", 2_000);
    expect(terminal).toMatchObject({ ok: false, stopReason: "stream_lost" });
    expect(events.events.filter((event) => event.type === "runtime.error" && event.threadId === "held-prompt-loss")).toHaveLength(1);
    expect(events.events.filter((event) => event.type === "turn.completed" && event.threadId === "held-prompt-loss")).toHaveLength(1);
    expect(fake.requests.map((entry) => dshClientRequestSchema.safeParse(entry.body).data?.method).filter((method) => method === "session.cancel")).toHaveLength(1);

    fake.setStreamHandshakeHung("mux", false);
    await instance.dispose();
    events.stop();
  });

  it("replays a fast terminal frame received while the queue prompt response is held", async () => {
    const fake = await host();
    let holdPrompt = true;
    fake.onRawRequest = (request) => holdPrompt && dshClientRequestSchema.safeParse(request.body).data?.method === "session.prompt";
    fake.onRequest = ({ body }) => officialResponse(dshClientRequestSchema.parse(body), "fast-terminal-session");
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const model = encodeDshModelId("deepseek", "chat");

    const start = instance.adapter.sendTurn({ threadId: "fast-terminal", text: "x", model });
    await fake.waitForRawResponse();
    const event = (rpcId: string, type: string, seq: number, data: DshJsonValue) => ({ type: "server-request", rpcId, method: "session/event", payload: { type: "session/event", sessionId: "fast-terminal-session", event: { type, seq, time: seq, data } } });
    fake.send("mux", event("fast-start", "turn/start", 1, {}));
    fake.send("mux", event("fast-output", "assistant/chunk.text-delta", 2, { delta: "fast output" }));
    fake.send("mux", event("fast-end", "turn/end", 3, { reason: { kind: "completed" } }));
    await fake.waitForStreamRoundTrip("mux");
    expect(events.events.some((item) => item.type === "turn.completed")).toBe(false);

    holdPrompt = false;
    fake.releaseRawResponses();
    const started = await start;
    const completed = await events.until((item) => item.type === "turn.completed" && item.turnId === started.turnId, 500);
    expect(completed).toMatchObject({ ok: true, stopReason: "completed" });
    expect(events.events.filter((item) => item.type === "session.started" || item.type === "content.delta" || item.type === "turn.completed").map((item) => item.type)).toEqual([
      "session.started",
      "content.delta",
      "turn.completed",
    ]);
    expect(events.events).toContainEqual(expect.objectContaining({ type: "content.delta", delta: "fast output" }));
    await expect(instance.adapter.sendTurn({ threadId: "fast-terminal", text: "next", model })).resolves.toEqual({ turnId: expect.any(String) });
    await instance.dispose();
    events.stop();
  });

  it("keeps negative and ambiguous approval/question receipts retryable with the stable rpc id", async () => {
    const fake = await host();
    let receipts = 0;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (request.success) return officialResponse(request.data, "receipt-session");
      receipts++;
      return receipts === 1 || receipts === 3 ? { accepted: false, reason: "bad-response" } : accepted();
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "receipt-thread", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "approval-rpc", method: "approval/requested", payload: { type: "approval/requested", sessionId: "receipt-session", approvalId: "approval-1", toolName: "shell" } });
    fake.send("mux", { type: "server-request", rpcId: "question-rpc", method: "question/requested", payload: { type: "question/requested", sessionId: "receipt-session", questions: [{ id: "question-1", question: "Pick", options: [{ label: "A" }] }] } });
    await events.until((event) => event.type === "request.opened" && event.requestType === "question");
    const approvalId = events.events.find((event) => event.type === "request.opened" && event.requestType === "permission")!.requestId!;
    const questionId = events.events.find((event) => event.type === "request.opened" && event.requestType === "question")!.requestId!;
    await expect(instance.adapter.respondToRequest("receipt-thread", approvalId, { behavior: "allow" })).resolves.toBe("retryable");
    await expect(instance.adapter.respondToRequest("receipt-thread", approvalId, { behavior: "allow" })).resolves.toBe("allowed-once");
    await expect(instance.adapter.respondToRequest("receipt-thread", questionId, { behavior: "answer", message: "custom text" })).resolves.toBe("retryable");
    await expect(instance.adapter.respondToRequest("receipt-thread", questionId, { behavior: "answer", message: "changed text" })).resolves.toBe("answered");
    const replies = fake.requests.filter((request) => request.path.endsWith("/respond")).map((request) => dshClientResponseSchema.parse(request.body));
    expect(replies.map((reply) => reply.rpcId)).toEqual(["approval-rpc", "approval-rpc", "question-rpc", "question-rpc"]);
    expect(replies[2].result).toMatchObject({ value: { answer: { answers: [{ id: "question-1", selected: [], custom: "custom text" }] } } });
    expect(replies[3].result).toMatchObject({ value: { answer: { answers: [{ id: "question-1", selected: [], custom: "custom text" }] } } });
    expect(events.events.filter((event) => event.type === "request.resolved" && event.requestId === approvalId)).toHaveLength(1);
    await instance.dispose();
  });

  it("drops pre-registration frames and scopes identical request ids by session owner", async () => {
    const fake = await host();
    let created = 0;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      if (request.data.method === "session.create") return response(request.data.rpcId, { sessionId: created++ ? "session-b" : "resume-a" });
      return officialResponse(request.data, "resume-a");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "preclaim", method: "session/event", payload: { type: "session/event", sessionId: "resume-a", event: { type: "assistant/chunk", seq: 1, time: 1, data: { chunk: { type: "text-delta", text: "replayed" } } } } });
    await instance.adapter.sendTurn({ threadId: "thread-a", text: "resume", resumeCursor: "resume-a", model: encodeDshModelId("deepseek", "chat") });
    await instance.adapter.sendTurn({ threadId: "thread-b", text: "new", model: encodeDshModelId("deepseek", "chat") });
    expect(events.events.some((event) => event.type === "content.delta" && event.delta === "replayed")).toBe(false);
    fake.send("mux", { type: "server-request", rpcId: "ask-a", method: "approval/requested", payload: { type: "approval/requested", sessionId: "resume-a", approvalId: "same-id", toolName: "a" } });
    fake.send("mux", { type: "server-request", rpcId: "ask-b", method: "approval/requested", payload: { type: "approval/requested", sessionId: "session-b", approvalId: "same-id", toolName: "b" } });
    await events.until((event) => event.type === "request.opened" && event.threadId === "thread-b");
    const threadAId = events.events.find((event) => event.type === "request.opened" && event.threadId === "thread-a")!.requestId!;
    const threadBId = events.events.find((event) => event.type === "request.opened" && event.threadId === "thread-b")!.requestId!;
    await expect(instance.adapter.respondToRequest("thread-a", threadAId, { behavior: "allow" })).resolves.toBe("allowed-once");
    await expect(instance.adapter.respondToRequest("thread-b", threadBId, { behavior: "deny" })).resolves.toBe("rejected");
    await instance.dispose();
  });

  it("does not send empty or late startup calls when stopAll cancels creation", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.create";
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const start = instance.adapter.sendTurn({ threadId: "cancel-start", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();
    await instance.adapter.stopAll();
    await expect(start).rejects.toThrow();
    expect(fake.requests.map((request) => dshClientRequestSchema.safeParse(request.body).data?.method)).toEqual(["session.create"]);
    await instance.dispose();
  });

  it("compensates a session created after an interrupt without selecting or queueing it", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.create";
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "interrupted-create");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const start = instance.adapter.sendTurn({ threadId: "interrupt-create", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();

    const interrupted = instance.adapter.interruptTurn("interrupt-create");
    fake.releaseRawResponses();

    await expect(start).rejects.toThrow("cancelled during startup");
    await interrupted;
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method)).toEqual([
      "session.create",
      "session.cancel",
    ]);
    await instance.dispose();
  });

  it.each(["session.selectModel", "session.prompt"] as const)("interrupts a held %s with one cancellation and no later startup call", async (heldMethod) => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === heldMethod;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, `interrupt-${heldMethod}`);
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const start = instance.adapter.sendTurn({ threadId: `interrupt-${heldMethod}`, text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();

    const interrupted = instance.adapter.interruptTurn(`interrupt-${heldMethod}`);
    fake.releaseRawResponses();
    await Promise.all([expect(start).rejects.toThrow("cancelled during startup"), interrupted]);

    const methods = fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method);
    const heldIndex = methods.indexOf(heldMethod);
    expect(methods.slice(heldIndex + 1).filter((method) => method !== "session.cancel")).toEqual([]);
    expect(methods.filter((method) => method === "session.cancel")).toHaveLength(1);
    await instance.dispose();
  });

  it("locally settles an interrupted queued turn when Host never emits turn/end", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      return request.success ? officialResponse(request.data, "interrupt-settle-session") : accepted();
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const model = encodeDshModelId("deepseek", "chat");
    const first = await instance.adapter.sendTurn({ threadId: "interrupt-settle", text: "first", model });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "interrupt-approval", method: "approval/requested", payload: { type: "approval/requested", sessionId: "interrupt-settle-session", approvalId: "approval", toolName: "shell" } });
    const opened = await events.until((event) => event.type === "request.opened");
    const requestId = opened.type === "request.opened" ? opened.requestId! : "";

    await instance.adapter.interruptTurn("interrupt-settle", "different-turn");
    expect(fake.requests.filter((request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.cancel")).toHaveLength(0);
    await instance.adapter.interruptTurn("interrupt-settle", first.turnId);

    const completed = await events.until((event) => event.type === "turn.completed" && event.turnId === first.turnId, 500);
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(events.events).toContainEqual(expect.objectContaining({ type: "request.resolved", requestId, behavior: "deny", source: "unavailable" }));
    await expect(instance.adapter.respondToRequest("interrupt-settle", requestId, { behavior: "allow" })).resolves.toBe("unavailable");
    expect(events.events.filter((event) => event.type === "turn.completed" && event.turnId === first.turnId)).toHaveLength(1);

    fake.send("mux", { type: "server-request", rpcId: "late-interrupt-end", method: "session/event", payload: { type: "session/event", sessionId: "interrupt-settle-session", event: { type: "turn/end", seq: 1, time: 1, data: { reason: { kind: "cancelled" } } } } });
    await fake.waitForStreamRoundTrip("mux");
    expect(events.events.filter((event) => event.type === "turn.completed" && event.turnId === first.turnId)).toHaveLength(1);
    expect(fake.requests.filter((request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.cancel")).toHaveLength(1);

    await expect(instance.adapter.sendTurn({ threadId: "interrupt-settle", text: "second", model })).resolves.toEqual({ turnId: expect.any(String) });
    await instance.dispose();
    events.stop();
  });

  it.each([
    ["stopAll", "session.create"],
    ["stopAll", "session.selectModel"],
    ["stopAll", "session.prompt"],
    ["dispose", "session.create"],
    ["dispose", "session.selectModel"],
    ["dispose", "session.prompt"],
  ] as const)("bounds %s while %s is held without late startup work", async (action, heldMethod) => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === heldMethod;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, `${action}-${heldMethod}`);
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const start = instance.adapter.sendTurn({ threadId: `${action}-${heldMethod}`, text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();

    const teardown = action === "stopAll" ? instance.adapter.stopAll() : instance.dispose();
    await Promise.all([expect(start).rejects.toThrow(), teardown]);

    const methods = fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method);
    const heldIndex = methods.indexOf(heldMethod);
    expect(heldIndex).toBeGreaterThanOrEqual(0);
    expect(methods.slice(heldIndex + 1).filter((method) => method !== "session.cancel")).toEqual([]);
    expect(methods.filter((method) => method === "session.cancel")).toHaveLength(heldMethod === "session.create" ? 0 : 1);
    if (action === "stopAll") await instance.dispose();
  });

  it("shares concurrent stopAll cleanup and sends one cancellation per active session", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "stop-once");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    await instance.adapter.sendTurn({ threadId: "stop-once", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await Promise.all([instance.adapter.stopAll(), instance.adapter.stopAll()]);
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method).filter((method) => method === "session.cancel")).toHaveLength(1);
    await instance.dispose();
  });

  it("maps secret-bearing host errors and permanent stream failure to fixed terminal events", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "lost-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "lost-thread", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("host", { type: "server-request", rpcId: "secret-error", method: "host/agent-error", payload: { type: "host/agent-error", sessionId: "lost-session", message: "cookie=fixture-secret" } });
    await events.until((event) => event.type === "runtime.error" && event.message === "DeepSeek Harness agent failed");
    expect(events.events.some((event) => JSON.stringify(event).includes("fixture-secret"))).toBe(false);
    fake.send("mux", { type: "server-request", rpcId: "stream-error", method: "stream/error", payload: { type: "stream/error", error: { code: "internal", message: "cookie=fixture-secret", details: {} } } });
    await events.until((event) => event.type === "turn.completed" && event.stopReason === "stream_lost", 2_000);
    expect(events.events.filter((event) => event.type === "turn.completed" && event.threadId === "lost-thread")).toHaveLength(1);
    await instance.dispose();
  });

  it("reuses a created session and only marks its persona delivered after an accepted first queue", async () => {
    const fake = await host();
    let prompts = 0;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      if (request.method === "session.create") return officialResponse(request, "persona-session");
      if (request.method === "session.prompt" && ++prompts === 1) return { type: "server-response", rpcId: request.rpcId, result: { ok: false, error: { code: "internal", message: "fixture", details: {} } } };
      return officialResponse(request, "persona-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const first = { threadId: "persona-thread", text: "first", system: "persona", model: encodeDshModelId("deepseek", "chat") };
    await expect(instance.adapter.sendTurn(first)).rejects.toThrow();
    await instance.adapter.sendTurn({ ...first, text: "retry" });
    const calls = fake.requests.map((request) => dshClientRequestSchema.parse(request.body));
    expect(calls.filter((request) => request.method === "session.create")).toHaveLength(1);
    // SAFETY: FakeDshHost's strict session.prompt schema has already accepted these payloads.
    expect(calls.filter((request) => request.method === "session.prompt").map((request) => (request.payload as { content: Array<{ text: string }> }).content[0].text)).toEqual([
      "<openmausbot-persona>\npersona\n</openmausbot-persona>\n\nfirst",
      "<openmausbot-persona>\npersona\n</openmausbot-persona>\n\nretry",
    ]);
    await instance.dispose();
  });

  it("rejects malformed resume cursors and invalid resume results without creating a fallback session", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return response(request.rpcId, request.method === "session.create" ? {} : {});
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    await expect(instance.adapter.sendTurn({ threadId: "bad-cursor", text: "x", resumeCursor: { bad: true }, model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("resume cursor is invalid");
    await expect(instance.adapter.sendTurn({ threadId: "bad-result", text: "x", resumeCursor: "known", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("DSH request failed with HTTP 500");
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method)).toEqual(["session.create"]);
    await instance.dispose();
  });

  it("serializes an early steer behind the first queue and rejects a competing active turn", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "serial-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const initial = instance.adapter.sendTurn({ threadId: "serial", text: "initial", model: encodeDshModelId("deepseek", "chat") });
    const earlySteer = instance.adapter.steer?.("serial", "steer");
    await expect(instance.adapter.sendTurn({ threadId: "serial", text: "competing", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("already running");
    await initial;
    await expect(earlySteer).resolves.toBe(true);
    expect(fake.requests.map((request) => dshClientRequestSchema.parse(request.body).method)).toEqual(["session.create", "session.selectModel", "session.prompt", "session.prompt"]);
    await instance.dispose();
  });

  it("rejects duplicate active ownership of the same resumed DSH session", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "one-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    await instance.adapter.sendTurn({ threadId: "owner-a", text: "x", resumeCursor: "one-session", model: encodeDshModelId("deepseek", "chat") });
    await expect(instance.adapter.sendTurn({ threadId: "owner-b", text: "x", resumeCursor: "one-session", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("already active on another thread");
    await instance.dispose();
  });

  it("accumulates assistant usage but gives the official terminal total precedence", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "usage-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const start = await instance.adapter.sendTurn({ threadId: "usage-thread", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    const event = (rpcId: string, type: string, data: DshJsonValue) => ({ type: "server-request", rpcId, method: "session/event", payload: { type: "session/event", sessionId: "usage-session", event: { type, seq: 1, time: 1, data } } });
    fake.send("mux", event("u1", "assistant/message", { message: { content: [] }, usage: { inputTokens: 2, outputTokens: 3 } }));
    fake.send("mux", event("u2", "assistant/message", { message: { content: [] }, usage: { inputTokens: 5, outputTokens: 7 } }));
    fake.send("mux", event("end", "turn/end", { reason: { kind: "completed" }, usage: { inputTokens: 20, outputTokens: 30 } }));
    const completed = await events.until((event) => event.type === "turn.completed" && event.turnId === start.turnId);
    expect(completed).toMatchObject({ usage: { input: 20, output: 30 } });
    await instance.dispose();
  });

  it("settles official approval/question resolved frames after a lost receipt without stale cards", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return { accepted: false, reason: "not-pending" };
      return officialResponse(request.data, "resolved-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "resolved-thread", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "a", method: "approval/requested", payload: { type: "approval/requested", sessionId: "resolved-session", approvalId: "a1", toolName: "shell" } });
    fake.send("mux", { type: "server-request", rpcId: "q", method: "question/requested", payload: { type: "question/requested", sessionId: "resolved-session", questions: [{ id: "q1", question: "q" }] } });
    await events.until((event) => event.type === "request.opened" && event.requestType === "question");
    const approvalId = events.events.find((event) => event.type === "request.opened" && event.requestType === "permission")!.requestId!;
    const questionId = events.events.find((event) => event.type === "request.opened" && event.requestType === "question")!.requestId!;
    await expect(instance.adapter.respondToRequest("resolved-thread", approvalId, { behavior: "allow" })).resolves.toBe("retryable");
    fake.send("mux", { type: "server-request", rpcId: "ar", method: "approval/resolved", payload: { type: "approval/resolved", sessionId: "resolved-session", approvalId: "a1", outcome: "allowed-once" } });
    fake.send("mux", { type: "server-request", rpcId: "qr", method: "question/resolved", payload: { type: "question/resolved", sessionId: "resolved-session", questionRpcId: "q", outcome: "answered" } });
    await events.until((event) => event.type === "request.resolved" && event.requestId === questionId);
    await expect(instance.adapter.respondToRequest("resolved-thread", approvalId, { behavior: "allow" })).resolves.toBe("unavailable");
    await instance.dispose();
  });

  it.each(["accepted", "negative", "exception", "aborted", "disposed", "interrupted"] as const)("converges a resolved-before-%s approval receipt without fallback", async (mode) => {
    const fake = await host();
    fake.onRawRequest = (request) => request.path.endsWith("/respond");
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (request.success) return officialResponse(request.data, `held-${mode}`);
      return mode === "negative" ? { accepted: false, reason: "not-pending" } : accepted();
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: `held-${mode}`, text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: `held-rpc-${mode}`, method: "approval/requested", payload: { type: "approval/requested", sessionId: `held-${mode}`, approvalId: "held-approval", toolName: "shell" } });
    const opened = await events.until((event) => event.type === "request.opened");
    const requestId = opened.type === "request.opened" ? opened.requestId! : "";
    const delivery = instance.adapter.respondToRequest(`held-${mode}`, requestId, { behavior: "allow" });
    await fake.waitForRawResponse();
    fake.send("mux", { type: "server-request", rpcId: `held-resolved-${mode}`, method: "approval/resolved", payload: { type: "approval/resolved", sessionId: `held-${mode}`, approvalId: "held-approval", outcome: "allowed-once" } });
    await events.until((event) => event.type === "request.resolved" && event.requestId === requestId);
    let stopped: Promise<void> | undefined;
    if (mode === "exception") fake.abortRawResponses();
    else if (mode === "aborted") stopped = instance.adapter.stopAll();
    else if (mode === "disposed") stopped = instance.dispose();
    else if (mode === "interrupted") {
      stopped = instance.adapter.interruptTurn(`held-${mode}`);
      await stopped;
      fake.releaseRawResponses();
    }
    else fake.releaseRawResponses();
    await expect(delivery).resolves.toBe("already-resolved");
    await stopped;
    expect(events.events.filter((event) => event.type === "request.resolved" && event.requestId === requestId)).toHaveLength(1);
    if (mode !== "disposed") await instance.dispose();
    events.stop();
  });

  it("correlates a resolved question by its exact rpc id before a negative receipt", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => request.path.endsWith("/respond");
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      return request.success
        ? officialResponse(request.data, "held-question")
        : { accepted: false, reason: "not-pending" };
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "held-question", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "question-exact", method: "question/requested", payload: { type: "question/requested", sessionId: "held-question", questions: [{ id: "q", question: "Continue?" }] } });
    const opened = await events.until((event) => event.type === "request.opened");
    const requestId = opened.type === "request.opened" ? opened.requestId! : "";
    const delivery = instance.adapter.respondToRequest("held-question", requestId, { behavior: "answer", custom: "yes" });
    await fake.waitForRawResponse();
    // A different rpc id is not authoritative for this batch.
    fake.send("mux", { type: "server-request", rpcId: "wrong-push", method: "question/resolved", payload: { type: "question/resolved", sessionId: "held-question", questionRpcId: "other", outcome: "answered" } });
    expect(events.events.some((event) => event.type === "request.resolved" && event.requestId === requestId)).toBe(false);
    fake.send("mux", { type: "server-request", rpcId: "right-push", method: "question/resolved", payload: { type: "question/resolved", sessionId: "held-question", questionRpcId: "question-exact", outcome: "answered" } });
    await events.until((event) => event.type === "request.resolved" && event.requestId === requestId);
    fake.releaseRawResponses();
    await expect(delivery).resolves.toBe("already-resolved");
    expect(events.events.filter((event) => event.type === "request.resolved" && event.requestId === requestId)).toHaveLength(1);
    await instance.dispose();
    events.stop();
  });

  it("marks a tool result failed from official content isError and ignores fractional usage", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "error-tool-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "error-tool", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    const event = (rpcId: string, type: string, data: DshJsonValue) => ({ type: "server-request", rpcId, method: "session/event", payload: { type: "session/event", sessionId: "error-tool-session", event: { type, seq: 1, time: 1, data } } });
    fake.send("mux", event("usage", "assistant/message", { message: { content: [] }, usage: { inputTokens: 1.5, outputTokens: 2 } }));
    fake.send("mux", event("tool", "tool/result", { message: { source: { callId: "call" }, content: [{ isError: true }] } }));
    await events.until((item) => item.type === "item.completed" && item.itemId === "call");
    await fake.waitForStreamRoundTrip("mux");
    expect(events.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemId: "call", ok: false }));
    expect(events.events.some((item) => item.type === "thread.token-usage.updated")).toBe(false);
    await instance.dispose();
  });

  it("preserves official multi-select, custom, and blank question answers in positional order", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "multi-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "multi-thread", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "multi-rpc", method: "question/requested", payload: { type: "question/requested", sessionId: "multi-session", questions: [
      { id: "one", question: "pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
      { id: "two", question: "custom", options: [{ label: "C" }] },
      { id: "three", question: "skip" },
    ] } });
    await events.until((event) => event.type === "request.opened" && event.summary === "skip");
    const questions = events.events.filter((event) => event.type === "request.opened" && event.requestType === "question");
    await instance.adapter.respondToRequest("multi-thread", questions.find((event) => event.type === "request.opened" && event.summary === "pick")!.requestId!, { behavior: "answer", selected: ["B", "A", "bad"] });
    await instance.adapter.respondToRequest("multi-thread", questions.find((event) => event.type === "request.opened" && event.summary === "custom")!.requestId!, { behavior: "answer", custom: "other" });
    await instance.adapter.respondToRequest("multi-thread", questions.find((event) => event.type === "request.opened" && event.summary === "skip")!.requestId!, { behavior: "answer" });
    const reply = dshClientResponseSchema.parse(fake.requests.find((request) => request.path.endsWith("/respond"))!.body);
    expect(reply).toMatchObject({ rpcId: "multi-rpc", result: { value: { answer: { answers: [
      { id: "one", selected: ["B", "A"] }, { id: "two", selected: [], custom: "other" }, { id: "three", selected: [] },
    ] } } } });
    await instance.dispose();
  });

  it("cancels a partially answered question batch exactly once with official rpcError", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "partial-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "partial", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "partial-rpc", method: "question/requested", payload: { type: "question/requested", sessionId: "partial-session", questions: [{ id: "first", question: "First?" }, { id: "second", question: "Second?" }] } });
    await events.until((event) => event.type === "request.opened" && event.summary === "Second?");
    const opened = events.events.filter((event) => event.type === "request.opened" && event.requestType === "question");
    await expect(instance.adapter.respondToRequest("partial", opened[0]!.requestId!, { behavior: "answer", custom: "one" })).resolves.toBe("answered");
    await instance.adapter.stopAll();
    await instance.adapter.stopAll();
    const resolved = events.events.filter((event) => event.type === "request.resolved" && opened.some((ask) => ask.type === "request.opened" && ask.requestId === event.requestId));
    expect(resolved).toHaveLength(2);
    expect(new Set(resolved.map((event) => event.requestId)).size).toBe(2);
    const cancellation = fake.requests.filter((request) => request.path.endsWith("/respond")).map((request) => dshClientResponseSchema.parse(request.body));
    expect(cancellation).toEqual([expect.objectContaining({ rpcId: "partial-rpc", result: { ok: false, error: { code: "cancelled", message: "OpenMausBot request cleanup", details: {} } } })]);
    await instance.dispose();
    events.stop();
  });

  it("keeps duplicate host question ids as separate positional cards and response rows", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "duplicate-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "duplicate-thread", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "dup-rpc", method: "question/requested", payload: { type: "question/requested", sessionId: "duplicate-session", questions: [{ id: "same", question: "first" }, { id: "same", question: "second" }] } });
    await events.until((event) => event.type === "request.opened" && event.summary === "second");
    const opened = events.events.filter((event) => event.type === "request.opened" && event.requestType === "question");
    expect(opened).toHaveLength(2);
    await instance.adapter.respondToRequest("duplicate-thread", opened[0].requestId!, { behavior: "answer", custom: "one" });
    await instance.adapter.respondToRequest("duplicate-thread", opened[1].requestId!, { behavior: "answer", custom: "two" });
    const reply = dshClientResponseSchema.parse(fake.requests.find((request) => request.path.endsWith("/respond"))!.body);
    expect(reply).toMatchObject({ result: { value: { answer: { answers: [{ id: "same", custom: "one" }, { id: "same", custom: "two" }] } } } });
    await instance.dispose();
  });

  it("replays the bounded official pending baseline after a resume claim", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.create";
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "baseline-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const start = instance.adapter.sendTurn({ threadId: "baseline", text: "x", resumeCursor: "baseline-session", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();
    fake.send("mux", { type: "server-request", rpcId: "baseline-ask", method: "approval/requested", payload: { type: "approval/requested", sessionId: "baseline-session", approvalId: "before-claim", toolName: "shell" } });
    fake.releaseRawResponses();
    const opened = await events.until((event) => event.type === "request.opened" && event.summary === "Approval requested");
    await instance.adapter.respondToRequest("baseline", opened.requestId!, { behavior: "allow" });
    fake.send("mux", { type: "server-request", rpcId: "baseline-old-end", method: "session/event", payload: { type: "session/event", sessionId: "baseline-session", event: { type: "turn/end", seq: 2, time: 1, data: { reason: { kind: "completed" } } } } });
    await start;
    await instance.dispose();
  });

  it.each(["session.create", "session.selectModel"] as const)("keeps a claimed pending ask durable while %s is held across TTL, cap pressure, and a mux generation change", async (heldMethod) => {
    const fake = await host();
    let muxConnections = 0;
    const initialNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    fake.onStreamOpen = (kind, socket) => {
      if (kind !== "mux" || ++muxConnections !== 1) return;
      socket.send(JSON.stringify({
        type: "server-request",
        rpcId: `durable-${heldMethod}`,
        method: "approval/requested",
        payload: { type: "approval/requested", sessionId: `durable-${heldMethod}`, approvalId: "durable", toolName: "shell" },
      }));
    };
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === heldMethod;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, `durable-${heldMethod}`);
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);

    try {
      await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);
      const start = instance.adapter.sendTurn({ threadId: `durable-${heldMethod}`, text: "resume", resumeCursor: `durable-${heldMethod}`, model: encodeDshModelId("deepseek", "chat") });
      await fake.waitForRawResponse();

      clock.mockReturnValue(initialNow + 11_000);
      for (let index = 0; index < 70; index++) {
        fake.send("mux", {
          type: "server-request",
          rpcId: `poison-${heldMethod}-${index}`,
          method: "approval/requested",
          payload: { type: "approval/requested", sessionId: `poison-${index}`, approvalId: `poison-${index}`, toolName: "shell", reason: "x".repeat(5_000) },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const closed = fake.waitForNoStreams("mux");
      fake.closeStreams("mux");
      await closed;
      await fake.waitForStream("mux");
      fake.releaseRawResponses();

      const opened = await events.until((event) => event.type === "request.opened" && event.summary === "Approval requested", 2_000);
      await expect(instance.adapter.respondToRequest(`durable-${heldMethod}`, opened.requestId!, { behavior: "allow" })).resolves.toBe("allowed-once");
      fake.send("mux", { type: "server-request", rpcId: `old-end-${heldMethod}`, method: "session/event", payload: { type: "session/event", sessionId: `durable-${heldMethod}`, event: { type: "turn/end", seq: 9, time: 1, data: { reason: { kind: "completed" } } } } });
      await expect(start).resolves.toEqual({ turnId: expect.any(String) });
      expect(events.events.filter((event) => event.type === "request.opened" && event.summary === "Approval requested")).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await instance.dispose();
      events.stop();
    }
  });

  it("settles a resumed Host ask before a held prompt survives TTL, cap pressure, and generation recovery", async () => {
    const fake = await host();
    const initialNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    let muxConnections = 0;
    fake.onStreamOpen = (kind, socket) => {
      if (kind !== "mux" || ++muxConnections !== 1) return;
      socket.send(JSON.stringify({
        type: "server-request",
        rpcId: "resume-blocked-ask",
        method: "approval/requested",
        payload: { type: "approval/requested", sessionId: "resume-blocked", approvalId: "old-ask", toolName: "shell", reason: "finish the old turn" },
      }));
    };
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.prompt";
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "resume-blocked");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);

    const start = instance.adapter.sendTurn({ threadId: "resume-blocked", text: "new prompt", resumeCursor: "resume-blocked", model: encodeDshModelId("deepseek", "chat") });
    const ask = await events.until((event) => event.type === "request.opened" && event.summary === "finish the old turn", 2_000);
    expect(fake.requests.some((entry) => dshClientRequestSchema.safeParse(entry.body).data?.method === "session.prompt")).toBe(false);

    await expect(instance.adapter.respondToRequest("resume-blocked", ask.requestId!, { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(fake.requests.some((entry) => dshClientRequestSchema.safeParse(entry.body).data?.method === "session.prompt")).toBe(false);
    fake.send("mux", { type: "server-request", rpcId: "resume-old-end", method: "session/event", payload: { type: "session/event", sessionId: "resume-blocked", event: { type: "turn/end", seq: 8, time: 1, data: { reason: { kind: "completed" } } } } });

    await fake.waitForRawResponse();
    clock.mockReturnValue(initialNow + 11_000);
    for (let index = 0; index < 70; index++) {
      fake.send("mux", {
        type: "server-request",
        rpcId: `prompt-poison-${index}`,
        method: "approval/requested",
        payload: { type: "approval/requested", sessionId: `prompt-poison-${index}`, approvalId: `prompt-poison-${index}`, toolName: "shell", reason: "x".repeat(5_000) },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.requests.map((entry) => entry.path)).toEqual([
      "/api/session.create",
      "/api/session.selectModel",
      "/api/respond",
      "/api/session.prompt",
    ]);
    const closed = fake.waitForNoStreams("mux");
    fake.closeStreams("mux");
    await closed;
    await fake.waitForStream("mux");
    fake.releaseRawResponses();
    await expect(start).resolves.toEqual({ turnId: expect.any(String) });

    fake.send("mux", { type: "server-request", rpcId: "resume-new-start", method: "session/event", payload: { type: "session/event", sessionId: "resume-blocked", event: { type: "turn/start", seq: 9, time: 2, data: {} } } });
    fake.send("mux", { type: "server-request", rpcId: "resume-new-output", method: "session/event", payload: { type: "session/event", sessionId: "resume-blocked", event: { type: "assistant/chunk.text-delta", seq: 10, time: 3, data: { delta: "new generation" } } } });
    fake.send("mux", { type: "server-request", rpcId: "resume-new-end", method: "session/event", payload: { type: "session/event", sessionId: "resume-blocked", event: { type: "turn/end", seq: 11, time: 4, data: { reason: { kind: "completed" } } } } });
    await events.until((event) => event.type === "turn.completed");
    expect(events.events.filter((event) => event.type === "content.delta")).toEqual([
      expect.objectContaining({ delta: "new generation" }),
    ]);
    expect(events.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    clock.mockRestore();
    await instance.dispose();
    events.stop();
  });

  it("does not deduplicate a pending ask before a held model selection can replay it", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.selectModel";
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "select-baseline");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const start = instance.adapter.sendTurn({ threadId: "select-baseline", text: "resume", resumeCursor: "select-baseline", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();

    fake.send("mux", { type: "server-request", rpcId: "select-ask", method: "approval/requested", payload: { type: "approval/requested", sessionId: "select-baseline", approvalId: "while-selecting", toolName: "shell" } });
    fake.releaseRawResponses();

    const opened = await events.until((event) => event.type === "request.opened" && event.requestType === "permission");
    await instance.adapter.respondToRequest("select-baseline", opened.requestId!, { behavior: "allow" });
    fake.send("mux", { type: "server-request", rpcId: "select-old-end", method: "session/event", payload: { type: "session/event", sessionId: "select-baseline", event: { type: "turn/end", seq: 2, time: 1, data: { reason: { kind: "completed" } } } } });
    await start;
    expect(events.events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    await instance.dispose();
    events.stop();
  });

  it("captures the socket-open pending baseline before sendTurn and bounds stale poison", async () => {
    const fake = await host();
    const envelope = (rpcId: string, approvalId: string, reason: string) => ({
      type: "server-request", rpcId, method: "approval/requested",
      payload: { type: "approval/requested", sessionId: "open-baseline", approvalId, toolName: "shell", reason },
    });
    fake.onStreamOpen = (kind, socket) => {
      if (kind !== "mux") return;
      socket.send(JSON.stringify({ type: "server-request", rpcId: "old-terminal", method: "session/event", payload: { type: "session/event", sessionId: "open-baseline", event: { type: "turn/end", seq: 9, time: 1, data: { reason: { kind: "completed" } } } } }));
      socket.send(JSON.stringify(envelope("obsolete-rpc", "obsolete", "obsolete")));
      socket.send(JSON.stringify({ type: "server-request", rpcId: "obsolete-resolved", method: "approval/resolved", payload: { type: "approval/resolved", sessionId: "open-baseline", approvalId: "obsolete", outcome: "cancelled" } }));
      for (let index = 0; index < 17; index++) socket.send(JSON.stringify(envelope(`live-rpc-${index}`, `live-${index}`, `live-${index}`)));
    };
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "open-baseline");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = instance.adapter.sendTurn({ threadId: "open-order", text: "resume", resumeCursor: "open-baseline", model: encodeDshModelId("deepseek", "chat") });
    await events.until((event) => event.type === "request.opened" && event.summary === "live-15");
    const opened = events.events.filter((event) => event.type === "request.opened");
    expect(opened).toHaveLength(16);
    expect(opened.some((event) => event.type === "request.opened" && (event.summary === "obsolete" || event.summary === "live-16"))).toBe(false);
    expect(events.events.some((event) => event.type === "turn.completed")).toBe(false);
    for (const request of opened) await instance.adapter.respondToRequest("open-order", request.requestId!, { behavior: "allow" });
    fake.send("mux", { type: "server-request", rpcId: "open-baseline-old-end", method: "session/event", payload: { type: "session/event", sessionId: "open-baseline", event: { type: "turn/end", seq: 10, time: 2, data: { reason: { kind: "completed" } } } } });
    await start;
    await instance.dispose();
    events.stop();
  });

  it("expires each unclaimed socket-open baseline frame before a later resume", async () => {
    const fake = await host();
    const initialNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    fake.onStreamOpen = (kind, socket) => {
      if (kind === "mux") socket.send(JSON.stringify({ type: "server-request", rpcId: "expired-rpc", method: "approval/requested", payload: { type: "approval/requested", sessionId: "expired-session", approvalId: "expired", toolName: "shell" } }));
    };
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "expired-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    try {
      await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);
      await fake.waitForStreamRoundTrip("mux");
      clock.mockReturnValue(initialNow + 11_000);
      await instance.adapter.sendTurn({ threadId: "expired", text: "resume", resumeCursor: "expired-session", model: encodeDshModelId("deepseek", "chat") });
      expect(events.events.some((event) => event.type === "request.opened")).toBe(false);
    } finally {
      clock.mockRestore();
      await instance.dispose();
      events.stop();
    }
  });

  it("clears an unclaimed pending baseline when the mux connection generation changes", async () => {
    const fake = await host();
    let muxConnections = 0;
    fake.onStreamOpen = (kind, socket) => {
      if (kind !== "mux" || ++muxConnections !== 1) return;
      socket.send(JSON.stringify({ type: "server-request", rpcId: "old-generation-rpc", method: "approval/requested", payload: { type: "approval/requested", sessionId: "generation-session", approvalId: "old-generation", toolName: "shell" } }));
    };
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "generation-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);
    const closed = fake.waitForNoStreams("mux");
    fake.closeStreams("mux");
    await closed;
    await fake.waitForStream("mux");

    await instance.adapter.sendTurn({ threadId: "generation", text: "resume", resumeCursor: "generation-session", model: encodeDshModelId("deepseek", "chat") });
    expect(muxConnections).toBe(2);
    expect(events.events.some((event) => event.type === "request.opened")).toBe(false);
    await instance.dispose();
    events.stop();
  });

  it("preserves the baseline owner through a competing resume claim", async () => {
    const fake = await host();
    fake.onStreamOpen = (kind, socket) => {
      if (kind === "mux") socket.send(JSON.stringify({ type: "server-request", rpcId: "claim-rpc", method: "approval/requested", payload: { type: "approval/requested", sessionId: "claim-session", approvalId: "claim", toolName: "shell" } }));
    };
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.create";
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "claim-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);

    const first = instance.adapter.sendTurn({ threadId: "claim-thread", text: "first", resumeCursor: "claim-session", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForRawResponse();
    await expect(instance.adapter.sendTurn({ threadId: "competing-thread", text: "compete", resumeCursor: "claim-session", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("already being claimed");
    fake.releaseRawResponses();
    const opened = await events.until((event) => event.type === "request.opened" && event.requestType === "permission");
    await instance.adapter.respondToRequest("claim-thread", opened.requestId!, { behavior: "allow" });
    fake.send("mux", { type: "server-request", rpcId: "claim-old-end", method: "session/event", payload: { type: "session/event", sessionId: "claim-session", event: { type: "turn/end", seq: 2, time: 1, data: { reason: { kind: "completed" } } } } });
    await first;
    expect(events.events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    await instance.dispose();
    events.stop();
  });

  it("drops a claimed baseline after startup fails so a retry cannot inherit stale work", async () => {
    const fake = await host();
    let selects = 0;
    fake.onStreamOpen = (kind, socket) => {
      if (kind === "mux") socket.send(JSON.stringify({ type: "server-request", rpcId: "failed-claim-rpc", method: "approval/requested", payload: { type: "approval/requested", sessionId: "failed-claim-session", approvalId: "failed-claim", toolName: "shell" } }));
    };
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      if (request.method === "session.create") return officialResponse(request, "failed-claim-session");
      if (request.method === "session.selectModel" && ++selects === 1) {
        return { type: "server-response", rpcId: request.rpcId, result: { ok: false, error: { code: "internal", message: "fixture", details: {} } } };
      }
      return officialResponse(request, "failed-claim-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);

    await expect(instance.adapter.sendTurn({ threadId: "failed-claim", text: "first", resumeCursor: "failed-claim-session", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("internal");
    await instance.adapter.sendTurn({ threadId: "failed-claim", text: "retry", resumeCursor: "failed-claim-session", model: encodeDshModelId("deepseek", "chat") });
    expect(events.events.some((event) => event.type === "request.opened")).toBe(false);
    await instance.dispose();
    events.stop();
  });

  it("persists persona delivery only after queue acceptance across a restart", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "restart-session");
    };
    const first = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(first.adapter);
    await first.adapter.sendTurn({ threadId: "restart", text: "first", system: "persona", model: encodeDshModelId("deepseek", "chat") });
    const started = await events.until((event) => event.type === "session.started");
    const cursor = started.type === "session.started" ? started.resumeCursor : undefined;
    expect(cursor).toMatch(/^dsh1:/);
    events.stop();
    await first.dispose();
    const second = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    await second.adapter.sendTurn({ threadId: "restart", text: "second", system: "persona", resumeCursor: cursor, model: encodeDshModelId("deepseek", "chat") });
    const prompts = fake.requests.map((item) => dshClientRequestSchema.parse(item.body)).filter((item) => item.method === "session.prompt");
    // SAFETY: the fake Host strictly validated session.prompt's official text-block payload.
    expect((prompts.at(-1)!.payload as { content: Array<{ text: string }> }).content[0]!.text).toBe("second");
    await second.dispose();
  });

  it("keeps room-member sessions and one-time personas independent across restart", async () => {
    const fake = await host();
    let created = 0;
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      if (request.data.method === "session.create") {
        const payload = z.object({ sessionId: z.string().optional() }).parse(request.data.payload);
        return officialResponse(request.data, payload.sessionId ?? `room-session-${++created}`);
      }
      return officialResponse(request.data);
    };
    const createInstance = () => DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const model = encodeDshModelId("deepseek", "chat");
    const instance = await createInstance();
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "room", sessionKey: "room:alpha", text: "first", system: "Persona Alpha", model });
    expect(instance.adapter.hasSession("room")).toBe(true);
    const alphaCursor = events.events.find((event) => event.type === "session.started")?.resumeCursor;
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "alpha-end", method: "session/event", payload: { type: "session/event", sessionId: "room-session-1", event: { type: "turn/end", seq: 1, time: 1, data: { reason: { kind: "completed" } } } } });
    await events.until((event) => event.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "room", sessionKey: "room:beta", text: "second", system: "Persona Beta", model });
    const betaCursor = events.events.filter((event) => event.type === "session.started").at(-1)?.resumeCursor;

    expect(alphaCursor).toEqual(expect.any(String));
    expect(betaCursor).toEqual(expect.any(String));
    expect(alphaCursor).not.toBe(betaCursor);
    const firstPrompts = fake.requests
      .map((request) => dshClientRequestSchema.safeParse(request.body).data)
      .filter((request) => request?.method === "session.prompt");
    expect(firstPrompts.map((request) => request!.payload)).toEqual([
      expect.objectContaining({ sessionId: "room-session-1", content: [{ type: "text", text: expect.stringContaining("Persona Alpha") }] }),
      expect.objectContaining({ sessionId: "room-session-2", content: [{ type: "text", text: expect.stringContaining("Persona Beta") }] }),
    ]);
    await instance.dispose();

    const resumed = await createInstance();
    await resumed.adapter.sendTurn({ threadId: "room", sessionKey: "room:alpha", text: "after restart", system: "Persona Alpha", resumeCursor: alphaCursor, model });
    const lastPrompt = fake.requests.map((request) => dshClientRequestSchema.safeParse(request.body).data).filter((request) => request?.method === "session.prompt").at(-1);
    expect(lastPrompt?.payload).toMatchObject({ sessionId: "room-session-1", content: [{ type: "text", text: "after restart" }] });
    await resumed.dispose();
    events.stop();
  });

  it("does not double-complete when a Host cancel races a mux turn end", async () => {
    const fake = await host();
    fake.onRawRequest = (request) => dshClientRequestSchema.safeParse(request.body).data?.method === "session.cancel";
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "race-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "race", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host")]);
    fake.send("host", { type: "server-request", rpcId: "lost-host", method: "stream/error", payload: { type: "stream/error", error: { code: "internal", message: "secret", details: {} } } });
    await fake.waitForRawResponse();
    fake.send("mux", { type: "server-request", rpcId: "late-end", method: "session/event", payload: { type: "session/event", sessionId: "race-session", event: { type: "turn/end", seq: 1, time: 1, data: { reason: { kind: "cancelled" } } } } });
    expect(events.events.filter((event) => event.type === "turn.completed" && event.threadId === "race")).toHaveLength(0);
    fake.releaseRawResponses();
    await events.until((event) => event.type === "turn.completed" && event.stopReason === "stream_lost");
    expect(events.events.filter((event) => event.type === "turn.completed" && event.threadId === "race")).toHaveLength(1);
    await instance.dispose();
  });

  it("keeps session ownership after terminal completion and rejects sequential cross-thread reuse", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "owned-after-terminal");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "owner-first", text: "x", resumeCursor: "owned-after-terminal", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    fake.send("mux", { type: "server-request", rpcId: "done", method: "session/event", payload: { type: "session/event", sessionId: "owned-after-terminal", event: { type: "turn/end", seq: 1, time: 1, data: { reason: { kind: "completed" } } } } });
    await events.until((event) => event.type === "turn.completed" && event.threadId === "owner-first");
    await expect(instance.adapter.sendTurn({ threadId: "owner-second", text: "x", resumeCursor: "owned-after-terminal", model: encodeDshModelId("deepseek", "chat") })).rejects.toThrow("already active on another thread");
    await instance.dispose();
  });

  it("never reuses a public request id when Host item ids repeat sequentially", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.safeParse(body);
      if (!request.success) return accepted();
      return officialResponse(request.data, "id-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    const model = encodeDshModelId("deepseek", "chat");
    await instance.adapter.sendTurn({ threadId: "id-thread", text: "one", model });
    await fake.waitForStream("mux");
    const ask = (rpcId: string) => ({ type: "server-request", rpcId, method: "approval/requested", payload: { type: "approval/requested", sessionId: "id-session", approvalId: "reused", toolName: "shell" } });
    fake.send("mux", ask("rpc-one"));
    const first = await events.until((event) => event.type === "request.opened");
    const firstId = first.type === "request.opened" ? first.requestId! : "";
    fake.send("mux", { type: "server-request", rpcId: "resolved-one", method: "approval/resolved", payload: { type: "approval/resolved", sessionId: "id-session", approvalId: "reused", outcome: "cancelled" } });
    fake.send("mux", { type: "server-request", rpcId: "end-one", method: "session/event", payload: { type: "session/event", sessionId: "id-session", event: { type: "turn/end", seq: 1, time: 1, data: { reason: { kind: "completed" } } } } });
    await events.until((event) => event.type === "turn.completed");
    await instance.adapter.sendTurn({ threadId: "id-thread", text: "two", model });
    fake.send("mux", ask("rpc-two"));
    const second = await events.until((event) => event.type === "request.opened" && event.requestId !== firstId);
    const secondId = second.type === "request.opened" ? second.requestId! : "";
    expect(secondId).not.toBe(firstId);
    await expect(instance.adapter.respondToRequest("id-thread", firstId, { behavior: "allow" })).resolves.toBe("unavailable");
    await expect(instance.adapter.respondToRequest("id-thread", secondId, { behavior: "allow" })).resolves.toBe("allowed-once");
    await instance.dispose();
    events.stop();
  });

  it("never publishes an unsafe accumulated usage total", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return officialResponse(request, "overflow-session");
    };
    const instance = await DeepSeekHarnessDriver.create({ instanceId: "deepseekHarness", displayName: undefined, environment: {}, enabled: true, config: { baseUrl: fake.baseUrl, transport: "direct" } });
    const events = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "overflow", text: "x", model: encodeDshModelId("deepseek", "chat") });
    await fake.waitForStream("mux");
    const event = (rpcId: string, type: string, data: DshJsonValue) => ({ type: "server-request", rpcId, method: "session/event", payload: { type: "session/event", sessionId: "overflow-session", event: { type, seq: 1, time: 1, data } } });
    fake.send("mux", event("safe", "assistant/message", { message: { content: [] }, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }));
    fake.send("mux", event("overflow", "assistant/message", { message: { content: [] }, usage: { inputTokens: 1, outputTokens: 1 } }));
    fake.send("mux", event("overflow-sentinel", "tool/call", { callId: "overflow-sentinel", name: "sentinel", arguments: {} }));
    await events.until((item) => item.type === "item.started" && item.itemId === "overflow-sentinel");
    await fake.waitForStreamRoundTrip("mux");
    const usageEvents = events.events.filter((item) => item.type === "thread.token-usage.updated");
    expect(usageEvents).toEqual([expect.objectContaining({ input: Number.MAX_SAFE_INTEGER, output: 1 })]);
    expect(usageEvents.every((item) => Number.isSafeInteger(item.input) && Number.isSafeInteger(item.output))).toBe(true);
    await instance.dispose();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { DshApiClient, DshRpcError } from "./client.ts";
import { dshClientRequestSchema, dshClientResponseSchema, dshJsonValueSchema } from "./protocol.ts";
import { defaultFakeResponse, FakeDshHost } from "../../testing/fake-dsh-host.ts";

const hosts: FakeDshHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

async function host(): Promise<FakeDshHost> {
  const fake = new FakeDshHost();
  hosts.push(fake);
  await fake.start();
  return fake;
}

describe("DshApiClient unary transport", () => {
  it("builds exact official defaults for every fake Host RPC without undefined fields", () => {
    const cases = [
      ["session.create", { cwd: "/fixture" }, { sessionId: "fake-session" }],
      ["session.selectModel", { sessionId: "s", provider: "deepseek", model: "chat" }, { selected: { provider: "deepseek", model: "chat" } }],
      ["session.prompt", { sessionId: "s", mode: "queue", content: [{ type: "text", text: "x" }] }, { accepted: true }],
      ["session.cancel", { sessionId: "s" }, { accepted: true }],
      ["host.describe", {}, { version: "fake", cwd: "/fixture", attachedSessions: 0, home: "/fixture", canOpenPath: false }],
      ["llm.providers", {}, { providers: [] }],
      ["llm.models", {}, { groups: [], failures: [] }],
      ["llm.discoverModels", { settingsNs: "llm-pi-ai", provider: "openrouter" }, { models: [] }],
      ["settings.describe", {}, { writable: true, hasDocument: false, namespaces: [] }],
      ["settings.mutate", { ns: "llm-pi-ai", ops: [], expectedRevision: 0 }, { ns: "llm-pi-ai", schema: {}, value: {}, applies: "live", secrets: [], revision: 1 }],
      ["agentPreset.list", {}, { presets: [], authorable: false, hasDocument: false }],
    ] as const;

    for (const [method, payload, value] of cases) {
      const request = dshClientRequestSchema.parse({ type: "client-request", rpcId: `default-${method}`, method, payload });
      expect(defaultFakeResponse({ path: `/api/${method}`, headers: {}, body: request })).toStrictEqual({
        type: "server-response",
        rpcId: `default-${method}`,
        result: { ok: true, value },
      });
    }

    const response = dshJsonValueSchema.parse(
      dshClientResponseSchema.parse({
        type: "client-response",
        rpcId: "default-respond",
        result: { ok: false, error: { code: "cancelled", message: "cleanup", details: {} } },
      }),
    );
    expect(defaultFakeResponse({ path: "/api/respond", headers: {}, body: response })).toStrictEqual({ accepted: true });
  });

  it("uses the direct API path and correlates the returned rpc id", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    const result = await client.unary<{ name: string }>("host.describe", {});

    expect(result.value).toEqual({
      version: "fake",
      cwd: "/fixture",
      attachedSessions: 0,
      home: "/fixture",
      canOpenPath: false,
    });
    expect(result.rpcId).toMatch(/^[a-z0-9-]+$/);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      path: "/api/host.describe",
      headers: { "content-type": "application/json" },
      body: { type: "client-request", method: "host.describe", rpcId: result.rpcId, payload: {} },
    });
    client.close();
  });

  it.each([
    ["session.create", { cwd: "/fixture" }],
    ["session.selectModel", { sessionId: "s", provider: "deepseek", model: "chat" }],
    ["session.prompt", { sessionId: "s", mode: "queue", content: [{ type: "text", text: "hello" }] }],
    ["session.cancel", { sessionId: "s" }],
    ["host.describe", {}],
    ["llm.models", {}],
    ["agentPreset.list", {}],
  ] as const)("rejects a malformed successful %s value at the Host boundary", async (method, payload) => {
    const fake = await host();
    fake.onRawRequest = ({ body }, response) => {
      const request = dshClientRequestSchema.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: {} } }));
      return true;
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary(method, dshJsonValueSchema.parse(payload))).rejects.toThrow("DSH response value was invalid");
    client.close();
  });

  it("makes the strict fake reject a malformed method-specific success fixture", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      const request = dshClientRequestSchema.parse(body);
      return dshJsonValueSchema.parse({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: {} } });
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary("session.create", { cwd: "/fixture" })).rejects.toThrow();
    expect(fake.invalidResponses).toContain("invalid session.create success value");
    client.close();
  });

  it("uses the paired API path and sends the device cookie only as a header", async () => {
    const fake = await host();
    const client = new DshApiClient({
      baseUrl: fake.baseUrl,
      transport: "paired",
      deviceCookie: "dsh_device=fixture-value",
    });

    await client.unary("llm.models", {});

    expect(fake.requests[0]).toMatchObject({
      path: "/remote/api/llm.models",
      headers: { cookie: "dsh_device=fixture-value" },
    });
    expect(fake.requests[0].path).not.toContain("fixture-value");
    client.close();
  });

  it("refuses unary redirects before a paired cookie can reach another origin", async () => {
    const target = await host();
    const source = await host();
    source.onRawRequest = (_request, response) => {
      response.writeHead(302, { location: `${target.baseUrl}/api/host.describe` });
      response.end();
      return true;
    };
    const client = new DshApiClient({
      baseUrl: source.baseUrl,
      transport: "paired",
      deviceCookie: "dsh_device=fixture-secret-value",
    });

    await expect(client.unary("host.describe", {})).rejects.toThrow("HTTP 302");
    expect(target.requests).toEqual([]);
    client.close();
  });

  it("rejects path-segment methods before a paired request is emitted", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });

    await expect(client.unary("x/../../../api/settings.describe", {})).rejects.toThrow("DSH API method is invalid");

    expect(fake.requests).toEqual([]);
    client.close();
  });

  it("rejects the paired plugin loopback-only method surface without issuing requests", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });
    const loopbackOnlyMethods = [
      "settings.describe",
      "settings.mutate",
      "credentials.describe",
      "credentials.set",
      "llm.discoverModels",
      "agentPreset.read",
      "agentPreset.copy",
      "agentPreset.openDocument",
      "agentPreset.remove",
      "host.pickDirectory",
      "host.openPath",
    ];

    for (const method of loopbackOnlyMethods) {
      await expect(client.unary(method, {})).rejects.toThrow("DSH method is not available through paired transport");
    }

    expect(fake.requests).toEqual([]);
    client.close();
  });

  it("allows the paired model, preset-list, and session surfaces", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });

    await client.unary("llm.models", {});
    await client.unary("agentPreset.list", {});
    await client.unary("session.create", { cwd: "/fixture" });

    expect(fake.requests.map((request) => request.path)).toEqual([
      "/remote/api/llm.models",
      "/remote/api/agentPreset.list",
      "/remote/api/session.create",
    ]);
    client.close();
  });

  it("rejects mismatched response rpc ids", async () => {
    const fake = await host();
    fake.onRawRequest = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "server-response", rpcId: "a-different-rpc-id", result: { ok: true, value: { version: "fixture", cwd: "/fixture", attachedSessions: 0, home: "/fixture", canOpenPath: false } } }));
      return true;
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary("host.describe", {})).rejects.toThrow("DSH response rpc id did not match request");
    client.close();
  });

  it("keeps paired device cookies out of DSH business-error text", async () => {
    const fake = await host();
    const deviceCookie = "dsh_device=fixture-secret-value";
    fake.onRequest = ({ body }) => {
      const rpcId = dshClientRequestSchema.parse(body).rpcId;
      return dshJsonValueSchema.parse({
        type: "server-response",
        rpcId,
        result: { ok: false, error: { code: "model-unavailable", message: `reflected ${deviceCookie}`, details: { provider: "fixture", model: "missing" } } },
      });
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie });

    await expect(client.unary("llm.models", {})).rejects.toBeInstanceOf(DshRpcError);
    await expect(client.unary("llm.models", {})).rejects.toThrow("DSH request was rejected (model-unavailable)");
    try {
      await client.unary("llm.models", {});
    } catch (error) {
      expect(error).toBeInstanceOf(DshRpcError);
      expect(String(error)).not.toContain(deviceCookie);
    }
    client.close();
  });

  it("rejects a chunked oversized response before the host finishes it", async () => {
    const fake = await host();
    fake.onRawRequest = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      response.write("x".repeat(1_000_001));
      return true;
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });
    const result = client.unary("host.describe", {});

    await fake.waitForRawResponse();
    const closed = fake.waitForRawResponseClose();
    await expect(result).rejects.toThrow("DSH response exceeds the size limit");
    await closed;
    client.close();
  });

  it("bounds blackholed operations and lets close abort an in-flight request", async () => {
    const fake = await host();
    fake.onRawRequest = () => true;
    const timed = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct", timeoutMs: 25 });
    await expect(timed.unary("host.describe", {})).rejects.toThrow("could not reach the host");
    timed.close();

    const closing = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct", timeoutMs: 5_000 });
    const pending = closing.unary("host.describe", {});
    await fake.waitForRawResponse();
    closing.close();
    await expect(pending).rejects.toThrow("could not reach the host");
  });

  it("sends client-response envelopes to the respond endpoint", async () => {
    const fake = await host();
    fake.onRequest = () => ({ accepted: true });
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.respond("approval-1", { ok: true, value: { sessionId: "s1", approvalId: "approval-1", outcome: "allowed-once" } })).resolves.toEqual({ accepted: true });

    expect(fake.requests[0]).toMatchObject({
      path: "/api/respond",
      body: { type: "client-response", rpcId: "approval-1", result: { ok: true, value: { sessionId: "s1", approvalId: "approval-1", outcome: "allowed-once" } } },
    });
    client.close();
  });

  it("maps an abort while reading a partial body to a fixed transport error", async () => {
    const fake = await host();
    fake.onRawRequest = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      response.write('{"type":"server-response"');
      return true;
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct", timeoutMs: 25 });
    await expect(client.unary("host.describe", {})).rejects.toThrow("DSH request could not reach the host");
    client.close();
  });

  it("lets the strict fake reject obsolete session prompt payloads", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });
    await expect(client.unary("session.prompt", { sessionId: "s1", mode: "queue", text: "obsolete" })).rejects.toThrow("HTTP 400");
    expect(fake.invalidRequests).toEqual(["invalid session.prompt payload"]);
    client.close();
  });

  it("lets the strict fake reject client methods outside the implemented Host surface", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary("session.invented", {})).rejects.toThrow("HTTP 400");
    expect(fake.invalidRequests).toEqual(["unsupported session.invented method"]);
    client.close();
  });

  it("matches the official create, event, question, and cancellation schemas", async () => {
    const fake = await host();
    fake.onRequest = ({ body }) => {
      if (dshClientResponseSchema.safeParse(body).success) return dshJsonValueSchema.parse({ accepted: true });
      const rpcId = dshClientRequestSchema.parse(body).rpcId;
      return dshJsonValueSchema.parse({ type: "server-response", rpcId, result: { ok: true, value: { sessionId: "s" } } });
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary("session.create", {})).resolves.toMatchObject({ value: { sessionId: "s" } });
    expect(() => fake.send("mux", { type: "server-request", rpcId: "q", method: "question/requested", payload: {
      type: "question/requested", sessionId: "s", questions: [{ id: "id", question: "q", header: "h", detail: "d", options: [{ label: "A", description: "desc" }], multiSelect: true, intent: { kind: "plan-review", approve: "Ship" } }],
    } })).not.toThrow();
    expect(() => fake.send("mux", { type: "server-request", rpcId: "bad-approval", method: "approval/requested", payload: { type: "approval/requested", sessionId: "s", approvalId: "a" } })).toThrow("invalid official");
    expect(() => fake.send("mux", { type: "server-request", rpcId: "bad-time", method: "session/event", payload: { type: "session/event", sessionId: "s", event: { type: "turn/start", seq: 0, time: "now", data: {} } } })).toThrow("invalid official");
    expect(() => fake.send("mux", { type: "server-request", rpcId: "bad-error", method: "stream/error", payload: { type: "stream/error", error: { code: "cancelled", message: "x" } } })).toThrow("invalid official");
    expect(() => fake.send("mux", { type: "server-request", rpcId: "queue", method: "session/queue", payload: {
      type: "session/queue", sessionId: "s", items: [{ id: "m", placement: "queued", message: { id: "m", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } } }],
    } })).not.toThrow();
    expect(() => fake.send("mux", { type: "server-request", rpcId: "bad-queue", method: "session/queue", payload: {
      type: "session/queue", sessionId: "s", items: [{ id: "m", placement: "queued", message: { id: "m", role: "user", content: [] } }],
    } })).toThrow("invalid official");
    expect(() => fake.send("mux", { type: "server-request", rpcId: "jobs", method: "session/jobs", payload: {
      type: "session/jobs", sessionId: "s", jobs: [{ id: "job", kind: "shell", label: "Build", status: "running", startedAt: 1 }],
    } })).not.toThrow();
    expect(() => fake.send("mux", { type: "server-request", rpcId: "bad-jobs", method: "session/jobs", payload: {
      type: "session/jobs", sessionId: "s", jobs: [{ id: "job", kind: "shell", label: "Build", status: "running" }],
    } })).toThrow("invalid official");
    expect(() => fake.send("host", { type: "server-request", rpcId: "workspace", method: "host/workspace-changed", payload: {
      type: "host/workspace-changed", workspace: { workspaceId: "w", path: "/tmp/w", title: "Workspace", sessionIds: ["s"], createdAt: "now", updatedAt: "now" },
    } })).not.toThrow();
    expect(() => fake.send("host", { type: "server-request", rpcId: "bad-workspace", method: "host/workspace-changed", payload: {
      type: "host/workspace-changed", workspace: { workspaceId: "w", path: "/tmp/w", title: "Workspace", sessionIds: ["s"], createdAt: "now" },
    } })).toThrow("invalid official");
    await expect(client.respond("cancel-rpc", { ok: false, error: { code: "cancelled", message: "cleanup", details: {} } })).resolves.toEqual({ accepted: true });
    // SAFETY: this deliberately malformed fixture verifies the runtime schema rejects missing error details.
    await expect(client.respond("malformed", { ok: false, error: { code: "cancelled", message: "cleanup" } } as never)).rejects.toThrow("response envelope was invalid");
    expect(dshClientResponseSchema.parse(fake.requests.at(-1)!.body).result).toEqual({ ok: false, error: { code: "cancelled", message: "cleanup", details: {} } });
    client.close();
  });

  it("rejects a valueless success when session.cancel requires accepted true", async () => {
    const fake = await host();
    fake.onRawRequest = ({ body }, response) => {
      const request = dshClientRequestSchema.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "server-response", rpcId: request.rpcId, result: { ok: true } }));
      return true;
    };
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct" });

    await expect(client.unary("session.cancel", { sessionId: "void-session" })).rejects.toThrow("DSH response value was invalid");
    client.close();
  });
});

describe("DshApiClient event streams", () => {
  it("invalidates paired streams when the next authenticated request is rejected", async () => {
    const fake = await host();
    const client = new DshApiClient({
      baseUrl: fake.baseUrl,
      transport: "paired",
      deviceCookie: "dsh_device=fixture-value",
    });
    const health: string[] = [];
    const stopHealth = client.subscribeHealth((state) => health.push(`${state.kind}:${state.state}`));
    const stopMux = client.subscribeMux(() => {});
    const stopHost = client.subscribeHost(() => {});

    try {
      await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host"), client.waitForStreamsOpen()]);
      fake.onRouteRequest = ({ path }, response) => {
        if (path !== "/remote/api/respond") return false;
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "revoked-device-upstream-secret" }));
        return true;
      };
      const allClosed = Promise.all([fake.waitForNoStreams("mux"), fake.waitForNoStreams("host")]);

      await expect(client.respond("revoked-rpc", { ok: true, value: { behavior: "allow" } })).rejects.toThrow(
        "paired device is no longer authorized",
      );
      await allClosed;
      expect(health).toEqual(expect.arrayContaining(["mux:reconnecting", "host:reconnecting"]));
      expect(JSON.stringify(health)).not.toContain("revoked-device-upstream-secret");
      const requestCount = fake.requests.length;
      const streamAttempts = { mux: fake.streamHeaders.mux.length, host: fake.streamHeaders.host.length };
      await expect(client.waitForStreamsOpen()).rejects.toThrow("paired device is no longer authorized");
      await expect(client.unary("llm.models", {})).rejects.toThrow("paired device is no longer authorized");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.requests).toHaveLength(requestCount);
      expect(fake.streamHeaders.mux).toHaveLength(streamAttempts.mux);
      expect(fake.streamHeaders.host).toHaveLength(streamAttempts.host);
    } finally {
      stopMux();
      stopHost();
      stopHealth();
      client.close();
    }
  });

  it("recycles both physical streams after an incomplete WebSocket upgrade and later recovers", async () => {
    const fake = await host();
    fake.setStreamHandshakeHung("mux", true);
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "direct", streamOpenTimeoutMs: 30 });
    const health: string[] = [];
    const stopHealth = client.subscribeHealth((state) => health.push(`${state.kind}:${state.state}:${state.generation}`));
    const stopMux = client.subscribeMux(() => {});
    const stopHost = client.subscribeHost(() => {});

    try {
      const readiness = client.waitForStreamsOpen();
      await fake.waitForHungStreamHandshake("mux");
      await expect(readiness).rejects.toThrow("event streams did not open");

      fake.setStreamHandshakeHung("mux", false);
      await Promise.all([fake.waitForStream("mux"), client.waitForStreamsOpen()]);

      expect(fake.streamHeaders.mux).toHaveLength(1);
      expect(fake.streamHeaders.host.length).toBeGreaterThanOrEqual(2);
      expect(health.filter((entry) => entry.startsWith("mux:reconnecting"))).toHaveLength(1);
      expect(health.filter((entry) => entry.startsWith("host:reconnecting"))).toHaveLength(1);
    } finally {
      stopMux();
      stopHost();
      stopHealth();
      client.close();
    }
  });

  it("connects both streams, ignores malformed frames, reconnects, and tears down cleanly", async () => {
    const fake = await host();
    const client = new DshApiClient({ baseUrl: fake.baseUrl, transport: "paired", deviceCookie: "dsh_device=fixture-value" });
    const muxFrames: unknown[] = [];
    const hostFrames: unknown[] = [];
    const health: string[] = [];
    const muxReconnecting = deferred();
    const stopHealth = client.subscribeHealth((state) => {
      health.push(`${state.kind}:${state.state}`);
      if (state.kind === "mux" && state.state === "reconnecting") muxReconnecting.resolve();
    });
    const firstMux = deferred();
    const secondMux = deferred();
    const firstHost = deferred();
    const stopMux = client.subscribeMux((frame) => {
      muxFrames.push(frame);
      if (muxFrames.length === 1) firstMux.resolve();
      if (muxFrames.length === 2) secondMux.resolve();
    });
    const stopHost = client.subscribeHost((frame) => {
      hostFrames.push(frame);
      if (hostFrames.length === 1) firstHost.resolve();
    });

    await Promise.all([fake.waitForStream("mux"), fake.waitForStream("host"), client.waitForStreamsOpen()]);
    expect(health).toContain("mux:connected");
    expect(fake.streamHeaders.mux[0].cookie).toBe("dsh_device=fixture-value");
    expect(fake.streamHeaders.host[0].cookie).toBe("dsh_device=fixture-value");
    fake.sendRaw("mux", "not JSON");
    fake.sendRaw("mux", JSON.stringify({ type: "unexpected", rpcId: "nope" }));
    const muxOne = { type: "server-request", rpcId: "mux-1", method: "session/event", payload: { type: "session/event", sessionId: "s1", event: { type: "turn/start", seq: 0, time: 1, data: {} } } };
    const hostOne = { type: "server-request", rpcId: "host-1", method: "host/agent-error", payload: { type: "host/agent-error", sessionId: "s1", message: "fixture" } };
    fake.send("mux", muxOne);
    fake.send("host", hostOne);

    await Promise.all([firstMux.promise, firstHost.promise]);
    expect(muxFrames).toEqual([muxOne]);
    expect(hostFrames).toEqual([hostOne]);

    const muxClosed = fake.waitForNoStreams("mux");
    fake.closeStreams("mux");
    await Promise.all([muxClosed, muxReconnecting.promise]);
    expect(health).toContain("mux:reconnecting");
    await Promise.all([fake.waitForStream("mux"), client.waitForStreamsOpen()]);
    fake.send("mux", { type: "server-request", rpcId: "mux-2", method: "session/event", payload: { type: "session/event", sessionId: "s2", event: { type: "turn/start", seq: 0, time: 1, data: {} } } });
    await secondMux.promise;

    stopMux();
    stopHost();
    stopHealth();
    const allClosed = Promise.all([fake.waitForNoStreams("mux"), fake.waitForNoStreams("host")]);
    client.close();
    await allClosed;
  });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

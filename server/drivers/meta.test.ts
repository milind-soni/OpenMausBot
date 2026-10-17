import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { MetaDriver } from "./meta.ts";
import { reviewApproval, type ReviewAction } from "../approval-review.ts";
import { assignmentLevel } from "../runtime/level.ts";
import { startFakeHttpMcp } from "../testing/fake-http-mcp-server.ts";

type ChatBody = { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[]; stream_options?: unknown };
const fixtureKey = `LLM|607358788850350|${"a".repeat(40)}`;
const stream = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
};

describe("Meta provider", () => {
  let server: Server;
  let base: string;
  let models: unknown;
  let reply: (body: ChatBody, res: ServerResponse) => void;
  let requests: Array<{ path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    vi.stubEnv("META_API_KEY", "");
    requests = [];
    instances = [];
    models = { data: [{ id: "muse-spark-1.3" }] };
    reply = (_body, res) => stream(res, [{ choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] }]);
    server = createServer(async (req, res) => {
      const request = { path: req.url ?? "", authorization: req.headers.authorization, body: undefined as ChatBody | undefined };
      requests.push(request);
      if (request.path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(models));
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      request.body = JSON.parse(text) as ChatBody;
      reply(request.body, res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture provider address missing");
    base = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await Promise.all(instances.map(instance => instance.dispose()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  const create = async (config = {}, environment = { META_API_KEY: fixtureKey }) => {
    const instance = await MetaDriver.create({ instanceId: "meta-fixture", displayName: "Meta Muse", enabled: true,
      config: MetaDriver.decodeConfig(config), environment });
    instances.push(instance);
    return instance;
  };

  it("presets Meta's endpoint, rejects unsafe configuration and never sends an unkeyed turn", async () => {
    expect(MetaDriver.defaultConfig().url).toBe("https://api.meta.ai/v1");
    expect(() => MetaDriver.decodeConfig({ url: "http://provider.example.test/v1" })).toThrow("HTTPS");
    expect(() => MetaDriver.decodeConfig({ tools: "false" })).toThrow();
    const instance = await create({ url: base }, { META_API_KEY: "" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Meta Model API key") });
      await expect(instance.adapter.sendTurn({ threadId: "missing", text: "Hello" })).rejects.toThrow("Meta Model API key");
      expect(requests).toHaveLength(0);
    } finally { recorder.stop(); }
  });

  it("does not send the server's Meta key to a custom instance host", async () => {
    vi.stubEnv("META_API_KEY", fixtureKey);
    const instance = await create({ url: base }, { META_API_KEY: "" });
    await instance.refreshModels?.();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    const unkeyed = await MetaDriver.create({ instanceId: "custom", displayName: "Custom Meta", enabled: true,
      config: MetaDriver.decodeConfig({ url: base }), environment: {} });
    instances.push(unkeyed);
    expect(await unkeyed.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("lists Meta's chat models, names them, and makes Muse Wonder the default once Meta lists it", async () => {
    models = { data: [
      { id: "muse-wonder-full" }, { id: "muse-wonder-contributor" }, { id: "muse-wonder" },
      { id: "muse-spark-1.3" }, { id: "muse-spark-1.3" }, { id: "muse-image-1.0" },
      { id: "muse-voice-transcribe-1.0" }, { id: "sam-3.1" }, null, { id: " " }, { id: 7 },
    ] };
    const instance = await create({ url: base });
    await instance.refreshModels?.();
    expect(instance.models).toEqual({ default: "muse-wonder", options: [
      { id: "muse-wonder-full", label: "Muse Wonder Full", contextWindow: 1_048_576 },
      { id: "muse-wonder-contributor", label: "Muse Wonder Contributor", contextWindow: 1_048_576 },
      { id: "muse-wonder", label: "Muse Wonder", contextWindow: 1_048_576 },
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 1_048_576 },
    ] });
    expect(requests.every(request => request.path === "/v1/models" && request.authorization === `Bearer ${fixtureKey}`)).toBe(true);
    const previous = instance.models;
    for (const malformed of [null, { data: "wrong" }, { data: [] }]) {
      models = malformed;
      await instance.refreshModels?.();
      expect(instance.models).toEqual(previous);
    }
  });

  it("offers Muse Wonder before Meta answers, Spark when the account lacks Wonder, and an owner's chosen model over both", async () => {
    expect(MetaDriver.models.default).toBe("muse-wonder-1.0");
    models = { data: [{ id: "muse-spark-1.3" }, { id: "muse-spark-1.2" }] };
    const spark = await create({ url: base });
    await spark.refreshModels?.();
    expect(spark.models.default).toBe("muse-spark-1.3");
    models = { data: [{ id: "muse-wonder" }, { id: "muse-spark-1.3" }] };
    const pinned = await create({ url: base, model: "muse-spark-1.3" });
    await pinned.refreshModels?.();
    expect(pinned.models.default).toBe("muse-spark-1.3");
  });

  it("streams the selected model and reports Meta usage", async () => {
    reply = (_body, res) => stream(res, [
      { choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 14, completion_tokens: 4 } },
    ]);
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "stream", text: "Hello", model: "muse-spark-1.3" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true, usage: { input: 14, output: 4 } });
      expect(instance.adapter.provider).toBe("meta");
      const request = requests.find(request => request.path.endsWith("/chat/completions"))!;
      expect(request.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(request.body).toMatchObject({ model: "muse-spark-1.3", stream: true, stream_options: { include_usage: true }, tools: expect.any(Array) });
      expect(request.body).not.toHaveProperty("reasoning_effort");
    } finally { recorder.stop(); }
  });

  it.each(["allow", "deny"] as const)("reviews inherited Meta Auto actions in a separate tool-free call: %s", async decision => {
    const remote = await startFakeHttpMcp({ transport: "http", tools: [
      { name: "record", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
    ] });
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    reply = (body, res) => {
      const isReview = body.messages.some(message => String(message.content ?? "").includes("independent execution reviewer"));
      const delta = isReview ? { content: JSON.stringify({ decision, reason: "Synthetic scoped decision" }) }
        : body.messages.some(message => message.role === "tool") ? { content: "Recorded." }
        : { tool_calls: [{ index: 0, id: "record-1", type: "function", function: { name: "fixture_record", arguments: JSON.stringify({ value: "synthetic" }) } }] };
      stream(res, [{ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] }]);
    };
    const mode = assignmentLevel({ own: "ask", chief: "auto", chiefLineage: true, origin: "person", driverKind: instance.driverKind }).level;
    const judge = vi.fn((action: ReviewAction, signal: AbortSignal) => reviewApproval({ action,
      session: { instanceId: instance.instanceId, model: instance.models.default }, settings: {},
      messages: [{ id: "permission-source", at: 1, role: "user", kind: "text", text: "Record synthetic in the disposable fixture." }],
      getProvider: id => id === instance.instanceId ? instance : undefined, isCurrent: () => true, signal,
    }));
    try {
      expect(mode).toBe("auto");
      await instance.adapter.sendTurn({ threadId: "meta-review", text: "Record synthetic in the disposable fixture.", model: instance.models.default,
        approvalMode: mode, reviewTool: judge, integrations: { custom: { fixture: { type: "http", url: remote.url, headers: {} } } } });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: decision === "allow" });
      expect(judge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool: "fixture_record", arguments: { value: "synthetic" } }), expect.any(AbortSignal));
      expect(remote.calls).toEqual(decision === "allow" ? [{ name: "record", arguments: { value: "synthetic" } }] : []);
      expect(recorder.events.filter(event => event.type === "request.opened")).toEqual([]);
      const review = requests.find(request => request.body?.messages.some(message => String(message.content ?? "").includes("independent execution reviewer")))!;
      expect(review.body?.tools).toBeUndefined();
      expect(review.body?.model).toBe(instance.models.default);
    } finally { recorder.stop(); await instance.dispose(); await remote.close(); }
  });

  it("reports a rejected key without exposing it in canonical errors", async () => {
    reply = (_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Invalid API key: ${fixtureKey}` } }));
    };
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "rejected", text: "Hello" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false });
      expect(JSON.stringify(recorder.events)).not.toContain(fixtureKey);
      expect(await instance.snapshot()).toMatchObject({ authenticated: false });
    } finally { recorder.stop(); }
  });
});

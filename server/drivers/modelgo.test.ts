import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELGO_URL } from "../../shared/modelgo.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { classifyError } from "./retry.ts";
import { ModelgoDriver } from "./modelgo.ts";

type ChatBody = { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[]; stream?: boolean };
const fixtureKey = `modelgo-fixture-${"a".repeat(40)}`;
const stream = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`: gateway comment\n\n${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
};
const refuse = (status: number, code: string, field: "error_class" | "reason" = "error_class") => (_body: ChatBody, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Refused by the gateway.", type: "invalid_request_error", code: status, metadata: { [field]: code, request_id: "r1" } }, trace_id: "t1" }));
};

describe("ModelGo provider", () => {
  let server: Server;
  let base: string;
  let models: unknown;
  let reply: (body: ChatBody, res: ServerResponse) => void;
  let requests: Array<{ path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    vi.stubEnv("MODELGO_API_KEY", "");
    requests = [];
    instances = [];
    models = { object: "list", data: [{ id: "fixture-tool-model", output_modalities: ["text"] }] };
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

  const create = async (config = {}, environment: Record<string, string> = { MODELGO_API_KEY: fixtureKey }) => {
    const instance = await ModelgoDriver.create({ instanceId: "modelgo-fixture", displayName: "ModelGo", enabled: true,
      config: ModelgoDriver.decodeConfig(config), environment });
    instances.push(instance);
    return instance;
  };

  it("presets ModelGo's endpoint and its tracked docs link, rejects unsafe configuration and never sends an unkeyed turn", async () => {
    expect(ModelgoDriver.defaultConfig().url).toBe("https://api.modelgo.ai/v1");
    expect(ModelgoDriver.install?.docsUrl).toBe(MODELGO_URL);
    expect(() => ModelgoDriver.decodeConfig({ url: "http://provider.example.test/v1" })).toThrow("HTTPS");
    const instance = await create({ url: base }, { MODELGO_API_KEY: "" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("ModelGo API key") });
      await expect(instance.adapter.sendTurn({ threadId: "missing", text: "Hello" })).rejects.toThrow("ModelGo API key");
      expect(requests).toHaveLength(0);
    } finally { recorder.stop(); }
  });

  it("has no built-in model ids: the list is only what the key's GET /models returns", () => {
    expect(ModelgoDriver.models).toEqual({ default: "", options: [] });
  });

  it("does not send the server's ModelGo key to a custom instance host", async () => {
    vi.stubEnv("MODELGO_API_KEY", fixtureKey);
    const instance = await create({ url: base }, {});
    await instance.refreshModels?.();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("does send the server's ModelGo key to ModelGo's own host", async () => {
    vi.stubEnv("MODELGO_API_KEY", fixtureKey);
    const sent: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "fixture-tool-model", output_modalities: ["text"] }] });
    }));
    try {
      await create({}, {});
      expect(sent).toEqual([{ url: "https://api.modelgo.ai/v1/models", authorization: `Bearer ${fixtureKey}` }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("lists the key's live text models with their context windows, leaves out image, video and speech models, and keeps the last list after a bad refresh", async () => {
    models = { object: "list", data: [
      { id: "fixture-b", object: "model", created: 1, context_length: 262144, max_request_bytes: 1048576, input_modalities: ["text"], output_modalities: ["text"] },
      { id: "fixture-a", output_modalities: ["text"] },
      { id: "fixture-vision", input_modalities: ["text", "image"], output_modalities: ["text"] },
      { id: "fixture-painter", input_modalities: ["text"], output_modalities: ["image"] },
      { id: "fixture-film", output_modalities: ["video"] },
      { id: "fixture-voice", output_modalities: ["audio"] },
      { id: "fixture-unknown" },
      { id: "fixture-a", output_modalities: ["text"] },
      null, { id: " ", output_modalities: ["text"] },
    ] };
    const instance = await create({ url: base });
    await instance.refreshModels?.();
    expect(instance.models).toEqual({ default: "fixture-b", options: [
      { id: "fixture-b", label: "fixture-b", contextWindow: 262144 },
      { id: "fixture-a", label: "fixture-a" },
      { id: "fixture-vision", label: "fixture-vision" },
    ] });
    expect(requests.every(request => request.path === "/v1/models" && request.authorization === `Bearer ${fixtureKey}`)).toBe(true);
    const previous = instance.models;
    for (const malformed of [null, { data: "wrong" }, { data: [] }, { data: [{ id: "fixture-painter", output_modalities: ["image"] }] }]) {
      models = malformed;
      await instance.refreshModels?.();
      expect(instance.models).toEqual(previous);
    }
  });

  it("says plainly when the key lists no models", async () => {
    models = { data: [] };
    const instance = await create({ url: base });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("listed no models") });
  });

  it("streams over /chat/completions with the key, tools, reasoning and the usage frame that has no choices", async () => {
    reply = (_body, res) => stream(res, [
      { choices: [{ delta: { reasoning_content: "Thinking." } }] },
      { choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 14, completion_tokens: 4 } },
    ]);
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "stream", text: "Hello", model: "fixture-tool-model" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true, usage: { input: 14, output: 4 } });
      expect(recorder.events.some(event => event.type === "content.delta" && event.streamKind === "reasoning_text" && event.delta === "Thinking.")).toBe(true);
      expect(recorder.events.some(event => event.type === "content.delta" && event.streamKind === "assistant_text" && event.delta === "Hello.")).toBe(true);
      expect(instance.adapter.provider).toBe("modelgo");
      const request = requests.find(request => request.path === "/v1/chat/completions")!;
      expect(request.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(request.body).toMatchObject({ model: "fixture-tool-model", stream: true, tools: expect.any(Array) });
    } finally { recorder.stop(); }
  });

  it("runs a tool call round trip: tool_calls parsed from the stream, a role:tool result sent back on the next request", async () => {
    let round = 0;
    reply = (_body, res) => {
      round += 1;
      stream(res, round === 1
        ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "fixture_missing_tool", arguments: "{}" } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]
        : [{ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] }]);
    };
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "tools", text: "Use the tool", model: "fixture-tool-model", approvalMode: "full" });
      await recorder.until(event => event.type === "turn.completed");
      const calls = requests.filter(request => request.path === "/v1/chat/completions");
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body!.messages.some(message => message.role === "assistant" && Array.isArray(message.tool_calls))).toBe(true);
      expect(calls[1]!.body!.messages.some(message => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
    } finally { recorder.stop(); }
  });

  const toolDeltas = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "fixture_missing_tool", arguments: "{}" } }] } }] }];
  const toolTurn = async (first: unknown[]) => {
    let round = 0;
    reply = (_body, res) => { round += 1; stream(res, round === 1 ? first : [{ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] }]); };
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "tools", text: "Use the tool", model: "fixture-tool-model", approvalMode: "full" });
      await recorder.until(event => event.type === "turn.completed");
      return { calls: requests.filter(request => request.path === "/v1/chat/completions"), events: recorder.events };
    } finally { recorder.stop(); }
  };

  it("runs tool calls from their deltas when the stream ends with finish_reason stop, as gemini-3.6-flash does", async () => {
    const { calls } = await toolTurn([...toolDeltas, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body!.messages.some(message => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
  });

  it.each(["reasoning_content", "reasoning"])("keeps a tool call that follows %s deltas", async (field) => {
    const { calls, events } = await toolTurn([
      { choices: [{ index: 0, delta: { [field]: "Thinking one." } }] },
      { choices: [{ index: 0, delta: { [field]: " Thinking two." } }] },
      ...toolDeltas,
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 14, completion_tokens: 4 } },
    ]);
    expect(events.filter(event => event.type === "content.delta" && event.streamKind === "reasoning_text").map(event => (event as { delta: string }).delta)).toEqual(["Thinking one.", " Thinking two."]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body!.messages.some(message => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
  });

  it.each([
    ["an empty balance", 402, "billing_insufficient", "error_class" as const, "balance has run out", "quota"],
    ["a first top-up", 403, "first_recharge_required", "reason" as const, "free models need a first top-up", "unknown"],
  ])("says %s in a plain sentence, wherever the code sits, and never marks the key as rejected", async (_name, status, code, field, words, reason) => {
    reply = refuse(status, code, field);
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "refused", text: "Hello", model: "fixture-tool-model" });
      await recorder.until(event => event.type === "turn.completed");
      const error = recorder.events.find(event => event.type === "runtime.error") as { message: string } | undefined;
      expect(error?.message).toContain(words);
      expect(error?.message).not.toMatch(/HTTP \d{3}|billing_insufficient|first_recharge_required|\{/);
      expect(classifyError(new Error(error!.message))).toEqual({ transient: false, reason });
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    } finally { recorder.stop(); }
  });

  it("leaves other 402s and 403s to the shared wording", async () => {
    reply = refuse(403, "policy");
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "policy", text: "Hello", model: "fixture-tool-model" });
      await recorder.until(event => event.type === "turn.completed");
      expect((recorder.events.find(event => event.type === "runtime.error") as { message: string }).message).toMatch(/^ModelGo HTTP 403/);
    } finally { recorder.stop(); }
  });

  it("reports a rejected key without exposing it in canonical errors", async () => {
    reply = (_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 401, message: `invalid or expired token ${fixtureKey}` } }));
    };
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "rejected", text: "Hello", model: "fixture-tool-model" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false });
      expect(JSON.stringify(recorder.events)).not.toContain(fixtureKey);
      expect(await instance.snapshot()).toMatchObject({ authenticated: false });
    } finally { recorder.stop(); }
  });
});

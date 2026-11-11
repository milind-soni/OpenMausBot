import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { GreenferenceDriver } from "./greenference.ts";

type ChatBody = { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[] };
const fixtureKey = `greenference-fixture-${"a".repeat(40)}`;
const stream = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
};

describe("Greenference provider", () => {
  let server: Server;
  let base: string;
  let models: unknown;
  let reply: (body: ChatBody, res: ServerResponse) => void;
  let requests: Array<{ path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    vi.stubEnv("GREENFERENCE_API_KEY", "");
    requests = [];
    instances = [];
    models = { data: [{ id: "greenference/glm-5.3-flash", supported_features: ["tools"] }] };
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

  const create = async (config = {}, environment = { GREENFERENCE_API_KEY: fixtureKey }) => {
    const instance = await GreenferenceDriver.create({ instanceId: "greenference-fixture", displayName: "Greenference", enabled: true,
      config: GreenferenceDriver.decodeConfig(config), environment });
    instances.push(instance);
    return instance;
  };

  it("presets Greenference's endpoint, rejects unsafe configuration and never sends an unkeyed turn", async () => {
    expect(GreenferenceDriver.defaultConfig().url).toBe("https://llm.eu.greenference.com/v1");
    expect(() => GreenferenceDriver.decodeConfig({ url: "http://provider.example.test/v1" })).toThrow("HTTPS");
    const instance = await create({ url: base }, { GREENFERENCE_API_KEY: "" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Greenference API key") });
      await expect(instance.adapter.sendTurn({ threadId: "missing", text: "Hello" })).rejects.toThrow("Greenference API key");
      expect(requests).toHaveLength(0);
    } finally { recorder.stop(); }
  });

  it("does not send the server's Greenference key to a custom instance host", async () => {
    vi.stubEnv("GREENFERENCE_API_KEY", fixtureKey);
    const instance = await create({ url: base }, { GREENFERENCE_API_KEY: "" });
    await instance.refreshModels?.();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("lists ready models that can call tools, by their short names, and keeps the last list after a bad refresh", async () => {
    models = { data: [
      { id: "greenference/qwen3.6-27b", name: "Qwen: Qwen3.6 27B", context_length: 262144, supported_features: ["function_calling", "tools"] },
      { id: "greenference/glm-5.3-flash", name: "Zai Org: GLM 5.3 Flash", context_length: 1048576, input_modalities: ["text", "image"], supported_features: ["tools"] },
      { id: "greenference/qwen3-8b", name: "Qwen: Qwen3 8B", supported_features: ["json_mode"] },
      { id: "greenference/warming-up", supported_features: ["tools"], is_ready: false },
      { id: "greenference/painter", output_modalities: ["image"], supported_features: ["tools"] },
      { id: "greenference/qwen3.6-27b", supported_features: ["tools"] },
      null, { id: " " }, { id: "bad-context", context_length: -1 },
    ] };
    const instance = await create({ url: base });
    await instance.refreshModels?.();
    expect(instance.models).toEqual({ default: "greenference/glm-5.3-flash", options: [
      { id: "greenference/qwen3.6-27b", label: "Qwen3.6 27B", contextWindow: 262144 },
      { id: "greenference/glm-5.3-flash", label: "GLM 5.3 Flash", contextWindow: 1048576 },
    ] });
    expect(requests.every(request => request.path === "/v1/models" && request.authorization === `Bearer ${fixtureKey}`)).toBe(true);
    const previous = instance.models;
    for (const malformed of [null, { data: "wrong" }, { data: [] }, { data: [{ id: "greenference/qwen3-8b", supported_features: ["json_mode"] }] }]) {
      models = malformed;
      await instance.refreshModels?.();
      expect(instance.models).toEqual(previous);
    }
  });

  it("streams the selected model with tools, reasoning and usage", async () => {
    reply = (_body, res) => stream(res, [
      { choices: [{ delta: { reasoning_content: "Thinking." } }] },
      { choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 14, completion_tokens: 4 } },
    ]);
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "stream", text: "Hello", model: "greenference/glm-5.3-flash" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true, usage: { input: 14, output: 4 } });
      expect(recorder.events.some(event => event.type === "content.delta" && event.streamKind === "reasoning_text" && event.delta === "Thinking.")).toBe(true);
      expect(instance.adapter.provider).toBe("greenference");
      const request = requests.find(request => request.path.endsWith("/chat/completions"))!;
      expect(request.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(request.body).toMatchObject({ model: "greenference/glm-5.3-flash", stream: true, tools: expect.any(Array) });
    } finally { recorder.stop(); }
  });

  it("reports a rejected key without exposing it in canonical errors", async () => {
    reply = (_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "authentication", message: `invalid or expired token ${fixtureKey}` } }));
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

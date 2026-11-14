import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { LlmtrDriver } from "./llmtr.ts";

type ChatBody = { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[] };
const fixtureKey = `llmtr-fixture-${"a".repeat(40)}`;
const stream = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
};
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, supported_operations: ["CHAT_COMPLETIONS"], supported_parameters: ["tools", "tool_choice"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] }, ...extra,
});

describe("LLMTR provider", () => {
  let server: Server;
  let base: string;
  let models: unknown;
  let reply: (body: ChatBody, res: ServerResponse) => void;
  let requests: Array<{ path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    vi.stubEnv("LLMTR_API_KEY", "");
    requests = [];
    instances = [];
    models = { data: [card("llmtr/qwen3-8-27b")] };
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

  const create = async (config = {}, environment = { LLMTR_API_KEY: fixtureKey }) => {
    const instance = await LlmtrDriver.create({ instanceId: "llmtr-fixture", displayName: "LLMTR", enabled: true,
      config: LlmtrDriver.decodeConfig(config), environment });
    instances.push(instance);
    return instance;
  };

  it("presets LLMTR's endpoint, rejects unsafe configuration and never sends an unkeyed turn", async () => {
    expect(LlmtrDriver.defaultConfig().url).toBe("https://llmtr.com/v1");
    expect(() => LlmtrDriver.decodeConfig({ url: "http://provider.example.test/v1" })).toThrow("HTTPS");
    const instance = await create({ url: base }, { LLMTR_API_KEY: "" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("LLMTR API key") });
      await expect(instance.adapter.sendTurn({ threadId: "missing", text: "Hello" })).rejects.toThrow("LLMTR API key");
      expect(requests).toHaveLength(0);
    } finally { recorder.stop(); }
  });

  it("does not send the server's LLMTR key to a custom instance host", async () => {
    vi.stubEnv("LLMTR_API_KEY", fixtureKey);
    const instance = await create({ url: base }, { LLMTR_API_KEY: "" });
    await instance.refreshModels?.();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("lists chat models that can call tools, by their short names, and keeps the last list after a bad refresh", async () => {
    models = { data: [
      card("qwen/qwen3.8-27b", { name: "Qwen: Qwen3.8 27B", context_length: 131042 }),
      card("llmtr/gemma-4", { name: "Gemma 4", context_length: 131072, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }),
      card("llmtr/no-tools", { supported_parameters: ["temperature"] }),
      card("llmtr/painter", { supported_operations: ["IMAGES_GENERATIONS"] }),
      card("llmtr/speaker", { architecture: { output_modalities: ["audio"] } }),
      { id: "llmtr/unlabelled" },
      card("llmtr/gemma-4"),
      null, { id: " " }, card("bad-context", { context_length: -1 }),
    ] };
    const instance = await create({ url: base });
    await instance.refreshModels?.();
    expect(instance.models).toEqual({ default: "qwen/qwen3.8-27b", options: [
      { id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B", contextWindow: 131042 },
      { id: "llmtr/gemma-4", label: "Gemma 4", contextWindow: 131072 },
    ] });
    expect(requests.every(request => request.path === "/v1/models" && request.authorization === `Bearer ${fixtureKey}`)).toBe(true);
    const previous = instance.models;
    for (const malformed of [null, { data: "wrong" }, { data: [] }, { data: [card("llmtr/no-tools", { supported_parameters: [] })] }]) {
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
      await instance.adapter.sendTurn({ threadId: "stream", text: "Hello", model: "llmtr/qwen3-8-27b" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true, usage: { input: 14, output: 4 } });
      expect(recorder.events.some(event => event.type === "content.delta" && event.streamKind === "reasoning_text" && event.delta === "Thinking.")).toBe(true);
      expect(instance.adapter.provider).toBe("llmtr");
      const request = requests.find(request => request.path.endsWith("/chat/completions"))!;
      expect(request.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(request.body).toMatchObject({ model: "llmtr/qwen3-8-27b", stream: true, tools: expect.any(Array) });
    } finally { recorder.stop(); }
  });

  it("reports a rejected key without exposing it in canonical errors", async () => {
    reply = (_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Invalid API key ${fixtureKey}`, type: "auth_error" } }));
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

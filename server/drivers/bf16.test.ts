import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { Bf16Driver } from "./bf16.ts";

type ChatBody = { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[] };
const fixtureKey = `sk-bf16-v1-${"a".repeat(32)}`;
const stream = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
};

describe("bf16.ai provider", () => {
  let server: Server;
  let base: string;
  let models: unknown;
  let reply: (body: ChatBody, res: ServerResponse) => void;
  let requests: Array<{ path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    vi.stubEnv("BF16_API_KEY", "");
    requests = [];
    instances = [];
    models = {
      data: [
        {
          id: "deepseek/deepseek-v4.1-flash-uncensored",
          name: "DeepSeek V4.1 Flash (Uncensored)",
          context_window: 1048576,
          supports_tools: true,
          supports_vision: true,
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        },
      ],
    };
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

  const create = async (config = {}, environment = { BF16_API_KEY: fixtureKey }) => {
    const instance = await Bf16Driver.create({
      instanceId: "bf16-fixture", displayName: "bf16.ai", enabled: true,
      config: Bf16Driver.decodeConfig(config), environment,
    });
    instances.push(instance);
    return instance;
  };

  it("presets bf16.ai endpoint, rejects unsafe HTTP hosts, and blocks unkeyed turns", async () => {
    expect(Bf16Driver.defaultConfig().url).toBe("https://api.bf16.ai/v1");
    expect(() => Bf16Driver.decodeConfig({ url: "http://provider.example.test/v1" })).toThrow("HTTPS");
    expect(() => Bf16Driver.decodeConfig({ url: "https://api.bf16.ai/v1?foo=1" })).toThrow("query string or fragment");
    expect(() => Bf16Driver.decodeConfig({ url: "https://api.bf16.ai/v1?" })).toThrow("query string or fragment");
    expect(() => Bf16Driver.decodeConfig({ url: "https://api.bf16.ai/v1#frag" })).toThrow("query string or fragment");
    const instance = await create({ url: base }, { BF16_API_KEY: "" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("bf16.ai API key") });
      await expect(instance.adapter.sendTurn({ threadId: "missing", text: "Hello" })).rejects.toThrow("bf16.ai API key");
      expect(requests).toHaveLength(0);
    } finally { recorder.stop(); }
  });

  it("does not leak the host BF16_API_KEY to a custom instance URL", async () => {
    vi.stubEnv("BF16_API_KEY", fixtureKey);
    const instance = await create({ url: base }, { BF16_API_KEY: "" });
    await instance.refreshModels?.();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("refreshes active tool-calling models and smart routers while filtering inactive/non-tool entries", async () => {
    models = {
      data: [
        { id: "deepseek/deepseek-v4.1-flash-uncensored", name: "DeepSeek V4.1 Flash (Uncensored)", context_window: 1048576, supports_tools: true, supports_vision: true },
        { id: "zai-org/glm-5.3-uncensored", name: "GLM-5.3 Flagship (Uncensored)", context_window: 1048576, supports_tools: true, supports_vision: false },
        { id: "bf16/auto", bf16: { family: "router" } },
        { id: "deprecated/model", supports_tools: true, bf16: { status: "deprecated" } },
        { id: "no-tools/model", supports_tools: false },
      ],
    };
    const instance = await create({ url: base });
    await instance.refreshModels?.();
    expect(instance.models.options.map(o => o.id)).toEqual([
      "deepseek/deepseek-v4.1-flash-uncensored",
      "zai-org/glm-5.3-uncensored",
      "bf16/auto",
    ]);
    expect(instance.models.default).toBe("deepseek/deepseek-v4.1-flash-uncensored");

    const pixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=",
      "base64",
    );
    const dir = mkdtempSync(join(tmpdir(), "bf16-vision-"));
    const imagePath = join(dir, "pixel.png");
    writeFileSync(imagePath, pixelPng);
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "vision-auto", model: "bf16/auto", text: "Inspect",
        images: [{ path: imagePath, mime: "image/png", bytes: pixelPng.length }],
      });
      expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
      const autoReq = requests.find(r => r.body?.model === "bf16/auto");
      const autoUser = autoReq?.body?.messages.find(m => m.role === "user");
      expect(Array.isArray(autoUser?.content)).toBe(true);

      await instance.adapter.sendTurn({
        threadId: "vision-text-only", model: "zai-org/glm-5.3-uncensored", text: "Inspect",
        images: [{ path: imagePath, mime: "image/png", bytes: pixelPng.length }],
      });
      expect(await recorder.until(e => e.type === "turn.completed" && e.threadId === "vision-text-only")).toMatchObject({ ok: true });
      const textOnlyReq = requests.find(r => r.body?.model === "zai-org/glm-5.3-uncensored");
      const textOnlyUser = textOnlyReq?.body?.messages.find(m => m.role === "user");
      expect(typeof textOnlyUser?.content).toBe("string");
    } finally {
      recorder.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams a chat completion turn with Bearer authorization", async () => {
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t1", text: "Say hello" });
      expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
      const chatReq = requests.find(r => r.path.endsWith("/chat/completions"));
      expect(chatReq?.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(chatReq?.body?.model).toBe("deepseek/deepseek-v4.1-flash-uncensored");
    } finally { recorder.stop(); }
  });
});

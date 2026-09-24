import { afterEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { MistralDriver } from "./mistral.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const create = (config = {}) => MistralDriver.create({
  instanceId: "mistral-test", displayName: "Mistral", enabled: true,
  config: MistralDriver.decodeConfig(config), environment: { MISTRAL_API_KEY: "fixture-key" },
});

describe("Mistral provider", () => {
  it("rejects invalid tools flags and non-TLS remote endpoints", () => {
    expect(() => MistralDriver.decodeConfig({ tools: "false" })).toThrow();
    expect(() => MistralDriver.decodeConfig({ url: "http://example.com/v1" })).toThrow("HTTPS");
    expect(MistralDriver.decodeConfig({ tools: false })).toMatchObject({ tools: false });
    expect(MistralDriver.decodeConfig({ url: "http://127.0.0.1:1234/v1/" }).url).toBe("http://127.0.0.1:1234/v1");
  });

  it("does not contact the provider without a key", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const instance = await MistralDriver.create({ instanceId: "empty", displayName: "Mistral", enabled: true,
      config: MistralDriver.defaultConfig(), environment: {} });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Mistral API key") });
    expect(fetcher).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("discovers versioned chat models and aliases while excluding archived and non-chat entries", async () => {
    let data: unknown = { data: [
      { id: "mistral-large-2512", name: "Mistral Large 3", aliases: ["mistral-large-latest", "mistral-large-2512"], max_context_length: 262144, capabilities: { completion_chat: true } },
      { id: "embed", capabilities: { completion_chat: false } },
      { id: "archived", archived: true }, null, { id: 3 },
    ] };
    const fetcher = vi.fn(async () => Response.json(data)); vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    await instance.refreshModels?.();
    expect(instance.models.default).toBe("mistral-large-latest");
    expect(instance.models.options).toEqual([
      { id: "mistral-large-2512", label: "Mistral Large 3", contextWindow: 262144 },
      { id: "mistral-large-latest", label: "mistral-large-latest", contextWindow: 262144 },
    ]);
    expect(fetcher.mock.calls[0]).toMatchObject(["https://api.mistral.ai/v1/models", {
      headers: { authorization: "Bearer fixture-key" }, redirect: "error",
    }]);
    data = { error: "offline" };
    await instance.refreshModels?.();
    expect(instance.models.options).toHaveLength(2);
    await instance.dispose();
  });

  it("keeps a configured custom model and accepts array catalogs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ id: "listed" }])));
    const instance = await create({ model: "private-finetune" });
    await instance.refreshModels?.();
    expect(instance.models.default).toBe("private-finetune");
    expect(instance.models.options.map((row) => row.id)).toEqual(["private-finetune", "listed"]);
    await instance.dispose();
  });

  it("streams text chunks and provider usage without unsupported request fields", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      request = init;
      return new Response('data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hello"},{"type":"reference","reference_ids":[0]}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "chat", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, usage: { input: 15, output: 2 } });
    expect(JSON.parse(String(request?.body))).toEqual({ model: "mistral-large-latest", stream: true,
      messages: [{ role: "user", content: "hello" }] });
    recorder.stop(); await instance.dispose();
  });

  it("extracts chunked text for non-streamed generation too", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [] })
      : Response.json({ choices: [{ message: { content: [{ type: "text", text: "Answer" }] }, finish_reason: "stop" }] })));
    const instance = await create();
    expect(await instance.generateText?.("hello")).toBe("Answer");
    await instance.dispose();
  });
});

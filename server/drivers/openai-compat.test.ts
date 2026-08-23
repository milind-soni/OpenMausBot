import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

describe("OpenAICompatDriver", () => {
  const savedUrl = process.env.OPENAI_COMPAT_URL;
  const savedKey = process.env.OPENAI_COMPAT_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_COMPAT_URL;
    delete process.env.OPENAI_COMPAT_API_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.OPENAI_COMPAT_URL;
    else process.env.OPENAI_COMPAT_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the openai-compat kind and a display name", () => {
    expect(OpenAICompatDriver.driverKind).toBe("openai-compat");
    expect(OpenAICompatDriver.metadata.displayName).toMatch(/OpenRouter|Groq/);
  });

  it("falls back to the OpenRouter endpoint by default", () => {
    const cfg = OpenAICompatDriver.defaultConfig();
    expect(cfg.url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
  });

  it("honours an explicit url and apiKeyEnv override", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      url: "https://api.groq.com/openai/v1/",
      apiKeyEnv: "GROQ_KEY",
    });
    expect(cfg.url).toBe("https://api.groq.com/openai/v1");
    expect(cfg.apiKeyEnv).toBe("GROQ_KEY");
  });

  it("reports unavailable without an API key", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-1",
      displayName: "Free",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    await inst.dispose();
  });

  it("exposes a refreshed model catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "vendor/model-a", name: "Model A" },
              { id: "vendor/model-b" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A" },
        { id: "vendor/model-b", label: "vendor/model-b" },
      ],
    });
    await inst.dispose();
  });

  it("includes streamed token totals in turn.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "private prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await inst.dispose();
  });
});

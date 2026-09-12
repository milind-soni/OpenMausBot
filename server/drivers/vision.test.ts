import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { VisionDriver } from "./vision.ts";

describe("VisionDriver", () => {
  const savedUrl = process.env.VISION_URL;
  const savedKey = process.env.FREELLMAPI_API_KEY;
  const savedModel = process.env.VISION_MODEL;

  beforeEach(() => {
    delete process.env.VISION_URL;
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.VISION_MODEL;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.VISION_URL;
    else process.env.VISION_URL = savedUrl;
    if (savedKey === undefined) delete process.env.FREELLMAPI_API_KEY;
    else process.env.FREELLMAPI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.VISION_MODEL;
    else process.env.VISION_MODEL = savedModel;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the vision kind and a unified display name", () => {
    expect(VisionDriver.driverKind).toBe("vision");
    expect(VisionDriver.metadata.displayName).toMatch(/Vision/);
  });

  it("falls back to the local freellmapi endpoint and the auto model by default", () => {
    const cfg = VisionDriver.defaultConfig();
    expect(cfg.url).toBe("http://localhost:3001/v1");
    expect(cfg.apiKeyEnv).toBe("FREELLMAPI_API_KEY");
    expect(cfg.model).toBe("auto");
  });

  it("honours env overrides for url and model", () => {
    process.env.VISION_URL = "http://proxy.example.test/v1/";
    process.env.VISION_MODEL = "openrouter:z-ai/glm-4.5-air";
    const cfg = VisionDriver.decodeConfig({});
    expect(cfg.url).toBe("http://proxy.example.test/v1");
    expect(cfg.model).toBe("openrouter:z-ai/glm-4.5-air");
  });

  it("strips a trailing slash from an explicit url", () => {
    const cfg = VisionDriver.decodeConfig({ url: "https://example.test/v1/", apiKeyEnv: "TEST_KEY" });
    expect(cfg.url).toBe("https://example.test/v1");
    expect(cfg.apiKeyEnv).toBe("TEST_KEY");
  });

  it("reports unavailable without an API key", async () => {
    const inst = await VisionDriver.create({
      instanceId: "test-1",
      displayName: "Vision",
      enabled: true,
      config: { url: "http://localhost:3001/v1", apiKeyEnv: "FREELLMAPI_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    await inst.dispose();
  });

  it("seeds every default catalog option as custom so the picker renders them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const inst = await VisionDriver.create({
      instanceId: "test-catalog",
      displayName: "Catalog",
      enabled: true,
      config: { url: "http://localhost:3001/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    expect(inst.models.default).toBe("auto");
    expect(inst.models.options.length).toBeGreaterThan(0);
    // `access: "custom"` engines render only custom-flagged options; an
    // unflagged seed would be invisible in its own picker.
    expect(inst.models.options.every((option) => option.custom === true)).toBe(true);
    expect(inst.models.options.some((option) => option.id === "auto")).toBe(true);
    expect(inst.models.options.some((option) => option.id === "rlm:auto")).toBe(true);
    await inst.dispose();
  });

  it("exposes a refreshed model catalog from the proxy's /models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "freellm/fast", name: "Fast" },
              { id: "freellm/smart" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const inst = await VisionDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "http://localhost:3001/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models).toEqual({
      default: "freellm/fast",
      options: [
        { id: "freellm/fast", label: "Fast", custom: true },
        { id: "freellm/smart", label: "freellm/smart", custom: true },
      ],
    });
    await inst.dispose();
  });

  it("keeps a configured default model ahead of a refreshed catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "freellm/fast", name: "Fast" }] }), { status: 200 }),
      ),
    );
    const inst = await VisionDriver.create({
      instanceId: "test-default-model",
      displayName: "Default model",
      enabled: true,
      config: { url: "http://localhost:3001/v1", apiKeyEnv: "TEST_KEY", model: "openrouter:z-ai/glm-4.5-air" },
      environment: { TEST_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models.default).toBe("openrouter:z-ai/glm-4.5-air");
    expect(inst.models.options[0]).toEqual({
      id: "openrouter:z-ai/glm-4.5-air",
      label: "openrouter:z-ai/glm-4.5-air",
      custom: true,
    });
    await inst.dispose();
  });

  it("sends plain chat-completions bodies (routing rides the model name)", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await VisionDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "http://localhost:3001/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    // A direct:-prefixed model must reach the proxy verbatim: the freellmapi
    // route decision (direct:* -> DeepSeek) happens upstream, never here.
    await inst.adapter.sendTurn({
      threadId: "thread-v",
      text: "prompt",
      model: "direct:deepseek-chat",
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true });
    expect(sentBody?.model).toBe("direct:deepseek-chat");
    expect(sentBody?.stream).toBe(true);
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("streams usage totals through to turn.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await VisionDriver.create({
      instanceId: "test-usage",
      displayName: "Usage",
      enabled: true,
      config: { url: "http://localhost:3001/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-u", text: "prompt", model: "auto" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 7, output: 2 } });
    recorder.stop();
    await inst.dispose();
  });
});

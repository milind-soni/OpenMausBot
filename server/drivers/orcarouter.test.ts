import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OrcaRouterDriver, decodeOrcaRouterConfig } from "./orcarouter.ts";

describe("OrcaRouterDriver", () => {
  const savedKey = process.env.ORCAROUTER_API_KEY;
  const savedUrl = process.env.ORCAROUTER_BASE_URL;

  beforeEach(() => {
    delete process.env.ORCAROUTER_API_KEY;
    delete process.env.ORCAROUTER_BASE_URL;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ORCAROUTER_API_KEY;
    else process.env.ORCAROUTER_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.ORCAROUTER_BASE_URL;
    else process.env.ORCAROUTER_BASE_URL = savedUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the orcarouter kind and a display name", () => {
    expect(OrcaRouterDriver.driverKind).toBe("orcarouter");
    expect(OrcaRouterDriver.metadata.displayName).toMatch(/OrcaRouter/);
  });

  it("defaults to the OrcaRouter endpoint", () => {
    const cfg = OrcaRouterDriver.defaultConfig();
    expect(cfg.url).toBe("https://api.orcarouter.ai/v1");
  });

  it("normalizes an env base URL to a /v1 root", () => {
    process.env.ORCAROUTER_BASE_URL = "https://gateway.example.test";
    const cfg = OrcaRouterDriver.defaultConfig();
    expect(cfg.url).toBe("https://gateway.example.test/v1");
  });

  it("honours an explicit url override", () => {
    const cfg = decodeOrcaRouterConfig({ url: "https://api.orcarouter.ai/v1/" });
    expect(cfg.url).toBe("https://api.orcarouter.ai/v1");
  });

  it("reports unavailable without an API key", async () => {
    const inst = await OrcaRouterDriver.create({
      instanceId: "test-1",
      displayName: "OrcaRouter",
      enabled: true,
      config: { url: "https://api.orcarouter.ai/v1" },
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
              { id: "orcarouter/fusion", name: "Fusion" },
              { id: "deepseek/deepseek-chat" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const inst = await OrcaRouterDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "https://api.orcarouter.ai/v1" },
      environment: { ORCAROUTER_API_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models).toEqual({
      default: "orcarouter/fusion",
      options: [
        { id: "orcarouter/fusion", label: "Fusion" },
        { id: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat" },
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
    const inst = await OrcaRouterDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "https://api.orcarouter.ai/v1" },
      environment: { ORCAROUTER_API_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "private prompt", model: "orcarouter/fusion" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await inst.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OrcaRouterDriver.create({
      instanceId: "test-reasoning-stream",
      displayName: "Reasoning",
      enabled: true,
      config: { url: "https://api.orcarouter.ai/v1" },
      environment: { ORCAROUTER_API_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "reasoning-thread", text: "question", model: "orcarouter/fusion" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking" }),
      expect.objectContaining({ type: "content.delta", streamKind: "assistant_text", delta: "answer" }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "answer" }),
    ]));
    expect(recorder.events).not.toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "thinking" }),
    );
    recorder.stop();
    await inst.dispose();
  });

  it("uses reasoning as a helper-model fallback when normal content is whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const inst = await OrcaRouterDriver.create({
      instanceId: "test-reasoning-helper",
      displayName: "Reasoning helper",
      enabled: true,
      config: { url: "https://api.orcarouter.ai/v1" },
      environment: { ORCAROUTER_API_KEY: "secret" },
    });

    await expect(inst.generateText?.("question")).resolves.toBe("usable result");
    await inst.dispose();
  });

  it("seeds the picker with the static default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const inst = await OrcaRouterDriver.create({
      instanceId: "test-default-model",
      displayName: "Default model",
      enabled: true,
      config: { url: "https://api.orcarouter.ai/v1" },
      environment: { ORCAROUTER_API_KEY: "secret" },
    });
    expect(inst.models.default).toBe("orcarouter/fusion");
    expect(inst.models.options.some((o) => o.id === "orcarouter/fusion")).toBe(true);
    await inst.dispose();
  });
});

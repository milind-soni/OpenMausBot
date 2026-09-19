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

  it("allows an isolated connection to disable an inherited OpenRouter provider pin", () => {
    const before = process.env.OPENAI_COMPAT_PROVIDER;
    process.env.OPENAI_COMPAT_PROVIDER = "fixture-upstream";
    try {
      expect(OpenAICompatDriver.decodeConfig({}).provider).toBe("fixture-upstream");
      expect(OpenAICompatDriver.decodeConfig({ provider: "" }).provider).toBeUndefined();
      expect(OpenAICompatDriver.decodeConfig({ provider: "another-upstream" }).provider).toBe("another-upstream");
    } finally {
      if (before === undefined) delete process.env.OPENAI_COMPAT_PROVIDER;
      else process.env.OPENAI_COMPAT_PROVIDER = before;
    }
  });

  it("does not inherit environment defaults into explicit connections", () => {
    const beforeModel = process.env.OPENAI_COMPAT_MODEL;
    const beforeProvider = process.env.OPENAI_COMPAT_PROVIDER;
    process.env.OPENAI_COMPAT_URL = "https://global.example/v1";
    process.env.OPENAI_COMPAT_MODEL = "global/model";
    process.env.OPENAI_COMPAT_PROVIDER = "global upstream";
    try {
      expect(OpenAICompatDriver.decodeConfig({ auth: "bearer", url: "https://own.example/v1" }))
        .toMatchObject({ auth: "bearer", url: "https://own.example/v1", model: undefined, provider: undefined });
      expect(() => OpenAICompatDriver.decodeConfig({ auth: "bearer" })).toThrow(/requires an API URL/u);
    } finally {
      if (beforeModel === undefined) delete process.env.OPENAI_COMPAT_MODEL;
      else process.env.OPENAI_COMPAT_MODEL = beforeModel;
      if (beforeProvider === undefined) delete process.env.OPENAI_COMPAT_PROVIDER;
      else process.env.OPENAI_COMPAT_PROVIDER = beforeProvider;
    }
  });

  it.each(["bearer", "none"])("validates independent %s endpoints when loading saved configuration", (auth) => {
    expect(() => OpenAICompatDriver.decodeConfig({ auth, url: "http://provider.example/v1" })).toThrow(/HTTPS/);
    expect(OpenAICompatDriver.decodeConfig({ auth, url: "https://provider.example/v1/" }).url).toBe("https://provider.example/v1");
    expect(OpenAICompatDriver.decodeConfig({ auth, url: "http://127.0.0.1:1234/v1" }).url).toBe("http://127.0.0.1:1234/v1");
  });

  it("never uses global credentials when an independent connection has no key", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "global-secret";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const inst = await OpenAICompatDriver.create({
      instanceId: "missing-key", displayName: "Independent", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ auth: "bearer", url: "https://own.example/v1", model: "own/model" }),
      environment: { OPENAI_COMPAT_API_KEY: "injected-global-secret" },
    });
    expect(await inst.snapshot()).toMatchObject({ state: "unavailable" });
    await expect(inst.adapter.sendTurn({ threadId: "thread", text: "hello" })).rejects.toThrow(/no API key/u);
    await expect(inst.generateText?.("hello")).rejects.toThrow(/no API key/u);
    expect(inst.models).toEqual({ default: "own/model", options: [{ id: "own/model", label: "own/model", custom: true }] });
    expect(fetch).not.toHaveBeenCalled();
    await inst.dispose();
  });

  it("supports explicitly keyless local catalogs and replies without Authorization", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "global-secret";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "local-model" }] }))
      : new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const inst = await OpenAICompatDriver.create({
      instanceId: "local", displayName: "Local", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ auth: "none", url: "http://127.0.0.1:1234/v1", key: "ignored-key", tools: false }),
      environment: { OPENAI_COMPAT_API_KEY: "injected-global-secret" },
    });
    await inst.refreshModels?.();
    expect(await inst.snapshot()).toMatchObject({ state: "available" });
    // Absence means no authentication is required. False means a sign-in is
    // required in the model picker and would incorrectly block local servers.
    expect(await inst.snapshot()).not.toHaveProperty("authenticated");
    expect(inst.models.default).toBe("local-model");
    await expect(inst.generateText?.("hello")).resolves.toBe("hello");
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "thread", text: "hello" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
    }
    recorder.stop();
    await inst.dispose();
  });

  it("keeps identical model IDs on independent endpoints bound to their own keys", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [] }))
      : new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const instances = await Promise.all(["one", "two"].map((id) => OpenAICompatDriver.create({
      instanceId: id, displayName: id, enabled: true,
      config: OpenAICompatDriver.decodeConfig({ auth: "bearer", url: `https://${id}.example/v1`, key: `${id}-key`, model: "shared/model" }),
      environment: {},
    })));
    await Promise.all(instances.map((instance) => instance.generateText?.("hello")));
    for (const [url, init] of fetch.mock.calls) {
      const id = String(url).includes("one.example") ? "one" : "two";
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${id}-key`);
      expect(init?.redirect).toBe("error");
    }
    for (const inst of instances) await inst.dispose();
  });

  it.each(["bearer", "none"])("cancels helper generation on the caller signal for %s connections", async (auth) => {
    let requestStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { requestStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
      expect(new Headers(init?.headers).get("authorization")).toBe(auth === "bearer" ? "Bearer own-key" : null);
      const signal = init?.signal;
      if (!signal) throw new Error("Helper request must be cancellable");
      requestStarted(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "helper", displayName: "Helper", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ auth, url: "https://own.example/v1", key: "own-key", model: "own/model" }),
      environment: {},
    });
    const caller = new AbortController();
    try {
      const result = expect(instance.generateText?.("Create a title", { signal: caller.signal })).rejects.toThrow("Helper cancelled");
      const requestSignal = await started;
      caller.abort(new Error("Helper cancelled"));
      await result;
      expect(requestSignal.aborted).toBe(true);
    } finally {
      caller.abort();
      await instance.dispose();
    }
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

    // Every option carries `custom: true`: this engine advertises
    // `access: "custom"`, and the picker renders only custom-flagged options
    // for such engines — an unflagged one is invisible in its own picker.
    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A", custom: true },
        { id: "vendor/model-b", label: "vendor/model-b", custom: true },
      ],
    });
    await inst.dispose();
  });

  it("includes streamed token totals and bounds the cancellable stream", async () => {
    const anySignal = vi.spyOn(AbortSignal, "any");
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
    expect(anySignal).toHaveBeenCalledTimes(1);
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
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-stream",
      displayName: "Reasoning",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "reasoning-thread", text: "question", model: "vendor/model" });
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
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-helper",
      displayName: "Reasoning helper",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await expect(inst.generateText?.("question")).resolves.toBe("usable result");
    await inst.dispose();
  });

  it("falls back to reasoning_content when content is empty (streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
            'data: {"choices":[{"delta":{"content":""}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-fallback-stream",
      displayName: "Reasoning Fallback",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-rf", text: "prompt", model: "vendor/model" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "thinking through the problem")).toBe(true);

    recorder.stop();
    await inst.dispose();
  });

  it("decodes a default model and provider from config", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "fireworks",
    });
    expect(cfg.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(cfg.provider).toBe("fireworks");
  });

  it("seeds the picker with the configured default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-default-model",
      displayName: "Default model",
      enabled: true,
      config: {
        url: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        model: "deepseek/deepseek-v4-flash-0731",
      },
      environment: { TEST_KEY: "secret" },
    });
    expect(inst.models.default).toBe("deepseek/deepseek-v4-flash-0731");
    expect(inst.models.options.some((o) => o.id === "deepseek/deepseek-v4-flash-0731")).toBe(true);
    await inst.dispose();
  });

  it("pins the OpenRouter upstream provider in the request body", async () => {
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
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-provider-route",
      displayName: "Provider route",
      enabled: true,
      config: {
        url: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "thread-p",
      text: "prompt",
      model: "deepseek/deepseek-v4-flash-0731",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(sentBody?.provider).toEqual({ order: ["fireworks"], allow_fallbacks: false });
    recorder.stop();
    await inst.dispose();
  });

  it("U24 retest: requests stream_options.include_usage on a streamed turn, like minimax.ts does", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    // Local OpenAI-compatible servers (oMLX in particular) only emit a usage
    // object in the stream when the client explicitly requests it via
    // stream_options.include_usage -- without it every streamed turn against
    // such a server gets no token-usage accounting at all.
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-include-usage",
      displayName: "Include usage",
      enabled: true,
      config: { url: "http://host.lima.internal:9090/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-u24", text: "prompt" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.stream).toBe(true);
    expect(sentBody?.stream_options).toEqual({ include_usage: true });
    recorder.stop();
    await inst.dispose();
  });

  it("omits provider routing on non-OpenRouter endpoints even when configured", async () => {
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
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-groq-no-provider",
      displayName: "Groq strict",
      enabled: true,
      config: {
        url: "https://api.groq.com/openai/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-g", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    // Strict OpenAI-compatible endpoints (Groq et al.) reject unknown
    // top-level fields — `provider` is OpenRouter-only routing.
    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not treat a lookalike host as OpenRouter", async () => {
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
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-lookalike",
      displayName: "Lookalike host",
      enabled: true,
      config: {
        // hostname is NOT openrouter.ai — substring matching on the whole
        // URL would be fooled by a lookalike domain or a path segment
        url: "https://notopenrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-l", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("pins the provider on an OpenRouter subdomain", async () => {
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
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-subdomain",
      displayName: "OpenRouter subdomain",
      enabled: true,
      config: {
        url: "https://gateway.openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-s", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.provider).toEqual({ order: ["fireworks"], allow_fallbacks: false });
    recorder.stop();
    await inst.dispose();
  });

  it("aborts when the idle period elapses between stream chunks", async () => {
    vi.useFakeTimers();
    try {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });

      const encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
          }
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.error(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            } catch {}
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );

      const inst = await OpenAICompatDriver.create({
        instanceId: "test-idle-timeout-fail",
        displayName: "Idle Timeout Fail",
        enabled: true,
        config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
        environment: { TEST_KEY: "secret" },
      });
      const recorder = recordEvents(inst.adapter);

      await inst.adapter.sendTurn({ threadId: "thread-idle-fail", text: "prompt", model: "vendor/model" });

      // First chunk arrives immediately
      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part 1"}}]}\n\n'));

      // Advance clock past idle timeout without any new chunks
      await vi.advanceTimersByTimeAsync(185_000);

      const completed = await recorder.until((e) => e.type === "turn.completed");
      // A provider that stops delivering chunks failed; the person did not press Stop.
      expect(completed).toMatchObject({ ok: false, stopReason: "error" });

      recorder.stop();
      await inst.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abort after 120s if the stream continues receiving active chunks (renewable idle timeout)", async () => {
    vi.useFakeTimers();
    try {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });

      const encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
          }
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );

      const inst = await OpenAICompatDriver.create({
        instanceId: "test-idle-timeout-renew",
        displayName: "Idle Timeout Renew",
        enabled: true,
        config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
        environment: { TEST_KEY: "secret" },
      });
      const recorder = recordEvents(inst.adapter);

      await inst.adapter.sendTurn({ threadId: "thread-idle-renew", text: "prompt", model: "vendor/model" });

      // Chunk 1 at t=0s
      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"start "}}]}\n\n'));
      await vi.advanceTimersByTimeAsync(100_000);

      // Chunk 2 at t=100s (resets idle timer)
      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"middle "}}]}\n\n'));
      await vi.advanceTimersByTimeAsync(100_000);

      // Chunk 3 at t=200s (resets idle timer)
      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"end"}}]}\n\n'));
      await vi.advanceTimersByTimeAsync(100_000);

      // Total 300s exceeds both the old 120s limit and the new 180s idle limit.
      controller!.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller!.close();

      const completed = await recorder.until((e) => e.type === "turn.completed");
      expect(completed).toMatchObject({ ok: true });

      const item = recorder.events.find((e) => e.type === "item.completed");
      expect(item).toMatchObject({ text: "start middle end" });
      expect(vi.getTimerCount()).toBe(0);

      recorder.stop();
      await inst.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits provider routing when none is configured", async () => {
    let sentBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
      sentBody = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n');
    }));
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-no-provider", displayName: "No provider", enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_KEY" }, environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({ threadId: "thread-np", text: "prompt", model: "vendor/model" });
      await recorder.until((event) => event.type === "turn.completed");
      expect(sentBody).not.toBeNull();
      expect(sentBody).not.toHaveProperty("provider");
    } finally {
      recorder.stop();
      await inst.dispose();
    }
  });
});


it("openai-compat preserves an explicit tools-off connection and rejects ambiguous flags", () => {
  expect(OpenAICompatDriver.decodeConfig({})).not.toHaveProperty("tools");
  expect(OpenAICompatDriver.decodeConfig({ tools: false })).toMatchObject({ tools: false });
  expect(OpenAICompatDriver.decodeConfig({ tools: true })).toMatchObject({ tools: true });
  expect(() => OpenAICompatDriver.decodeConfig({ tools: "false" })).toThrow("tools must be a boolean");
});

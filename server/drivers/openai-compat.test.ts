import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { buildTurnContext, replaysNatively } from "../turn-context.ts";
import { instanceConfigs } from "../config.ts";
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
    expect(OpenAICompatDriver.metadata.displayName).toBe("Other (OpenAI-compatible)");
    expect(OpenAICompatDriver.metadata.access).toBe("api");
  });

  it("falls back to the OpenRouter endpoint by default", () => {
    const cfg = OpenAICompatDriver.defaultConfig();
    expect(cfg.url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
  });

  it.each([
    ["I'll open the browser first.", {}, 2],
    ["I'm working in the Cua Local VM and will launch XFCE Terminal first.", {}, 2],
    ["The terminal is open and the task is complete.", {}, 1],
    ["Should I open the terminal?", {}, 1],
    ["I'll open the browser first.", { tools: false }, 1],
  ] as const)("bounds OpenRouter announcement nudges: %s %j", async (text, config, count) => {
    const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "openrouter-nudge", displayName: "OpenRouter", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ model: "qwen/qwen3.5-35b-a3b", ...config }),
      environment: { OPENAI_COMPAT_API_KEY: "synthetic-fixture-key" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "nudge", text: "Open the terminal." });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: count !== 2 });
      expect(bodies).toHaveLength(count);
      expect(bodies[0]!.model).toBe("qwen/qwen3.5-35b-a3b");
      if (count === 2) {
        expect(bodies[1]!.messages.slice(0, -2)).toEqual(bodies[0]!.messages);
        expect(bodies[1]!.messages.at(-2)).toEqual({ role: "assistant", content: text });
        expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("called no tool") });
      }
    } finally {
      recorder.stop();
      await instance.dispose();
    }
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

  it("keeps a provider's own instance off the workspace key, URL and model", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "workspace-key";
    process.env.OPENAI_COMPAT_URL = "https://openrouter.ai/api/v1";
    const before = process.env.OPENAI_COMPAT_MODEL;
    process.env.OPENAI_COMPAT_MODEL = "meta-llama/llama-3.3-70b-instruct";
    try {
      const config = OpenAICompatDriver.decodeConfig({ url: "https://api.openai.com/v1", apiKeyEnv: "OMB_OPENAI_API_KEY", catalog: "openai" });
      expect(config).toMatchObject({ url: "https://api.openai.com/v1", catalog: "openai" });
      expect(config.model).toBeUndefined();
      const inst = await OpenAICompatDriver.create({
        instanceId: "openai", displayName: "OpenAI", enabled: true, config,
        environment: { OPENAI_COMPAT_API_KEY: "workspace-key" },
      });
      expect((await inst.snapshot()).state).toBe("unavailable");
      expect(inst.models.default).toBe("gpt-5");
      await inst.dispose();
      expect(OpenAICompatDriver.decodeConfig({ apiKeyEnv: "GROQ_KEY" }).model).toBe("meta-llama/llama-3.3-70b-instruct");
    } finally {
      if (before === undefined) delete process.env.OPENAI_COMPAT_MODEL;
      else process.env.OPENAI_COMPAT_MODEL = before;
    }
  });

  it("lists only OpenAI's chat models, newest first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "gpt-4.1", created: 1 },
      { id: "text-embedding-3-large", created: 9 },
      { id: "gpt-5", created: 3 },
      { id: "gpt-4o-realtime-preview", created: 8 },
      { id: "dall-e-3", created: 7 },
      { id: "o3", created: 2 },
      { id: "gpt-5-codex", created: 6 },
    ] }), { status: 200 })));
    const inst = await OpenAICompatDriver.create({
      instanceId: "openai", displayName: "OpenAI", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://api.openai.com/v1", apiKeyEnv: "OMB_OPENAI_API_KEY", catalog: "openai" }),
      environment: { OMB_OPENAI_API_KEY: "sk-fixture" },
    });
    await vi.waitFor(() => expect(inst.models.options.map((option) => option.id)).toEqual(["gpt-5", "o3", "gpt-4.1"]));
    expect(inst.models.options.every((option) => !option.custom)).toBe(true);
    await inst.dispose();
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

  it("sends setup to Settings → API keys instead of a terminal", async () => {
    expect(OpenAICompatDriver.install?.command).toBeUndefined();
    expect(OpenAICompatDriver.install?.settings).toBe("connections");
    expect(OpenAICompatDriver.install?.signInCommand).toContain("Settings → API keys");
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-setup", displayName: "Router", enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" }, environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Settings → API keys") });
    expect(JSON.stringify(snap)).not.toContain("config.json");
    await inst.dispose();
  });

  it.each([
    ["its own URL", { url: "https://third-party.example.test/v1" }, ["WORKSPACE"]],
    ["its own key variable", { url: "https://third-party.example.test/v1", apiKeyEnv: "THIRD_PARTY_KEY" }, ["WORKSPACE", "OPERATOR"]],
  ])("sends the workspace key nowhere near an instance with %s", async (_label, config, absent) => {
    process.env.OPENAI_COMPAT_API_KEY = "sk-or-OPERATOR";
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.stringify(init?.headers ?? {}));
      return new Response('{"data":[]}', { headers: { "content-type": "application/json" } });
    }));
    const map = instanceConfigs({
      openaiCompat: { key: "sk-or-WORKSPACE" },
      instances: { claude: { driver: "claudeAgent" }, router: { driver: "openai-compat", config } },
    });
    const entry = map.router!;
    const inst = await OpenAICompatDriver.create({
      instanceId: "router", displayName: "Router", enabled: true,
      config: OpenAICompatDriver.decodeConfig(entry.config), environment: entry.environment as Record<string, string>,
    });
    await inst.refreshModels?.();
    await inst.snapshot();
    for (const secret of absent) expect(JSON.stringify(seen)).not.toContain(secret);
    await inst.dispose();
  });

  it("rejects remote HTTP computer use before starting tools or a completion request", async () => {
    const request = vi.fn(async (_url: string | URL | Request) => new Response('{"data":[]}', { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const inst = await OpenAICompatDriver.create({ instanceId: "cleartext", displayName: "Fixture", enabled: true,
      config: { url: "http://remote.example.test/v1", apiKeyEnv: "FIXTURE_KEY" }, environment: { FIXTURE_KEY: "synthetic" } });
    try {
      await expect(inst.adapter.sendTurn({ threadId: "cleartext", text: "Inspect the screen", model: "fixture",
        integrations: { localComputer: { command: "must-not-start", args: [], env: {} } } })).rejects.toThrow("require HTTPS");
      expect(request.mock.calls.some(call => String(call[0]).includes("chat/completions"))).toBe(false);
    } finally { await inst.dispose(); }
  });
  it("smoke: offers ask_user and returns the person's reply verbatim", async () => {
    const askBody = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"ask1","type":"function","function":{"name":"ask_user","arguments":'
      + JSON.stringify(JSON.stringify({ questions: [{ question: "Ship the fixture?", options: [{ label: "Yes" }, { label: "No" }] }] }))
      + '}}]}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const finalBody = 'data: {"choices":[{"index":0,"delta":{"content":"done"}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      bodies.push(String(init?.body));
      return new Response(bodies.length === 1 ? askBody : finalBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const inst = await OpenAICompatDriver.create({
      instanceId: "compat-ask", displayName: "Compat", enabled: true,
      config: { url: "https://api.example.com/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: { OPENAI_COMPAT_API_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "thread", text: "hi", model: "vendor/model" });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", tool: "ask_user", choices: ["Yes", "No"] });
    const reply = "The user answered your questions.\n\nQ: Ship the fixture?\nA: Yes";
    expect(await inst.adapter.respondToRequest("thread", opened.requestId!, { behavior: "answer", message: reply })).toBe("answered");
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true });
    expect(bodies[0]).toContain('"ask_user"');
    expect(JSON.parse(JSON.parse(bodies[1]!).messages.at(-1).content).result).toBe(reply);
    recorder.stop();
    await inst.dispose();
  }, 20_000);

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

    // An `access: "custom"` engine's picker shows only custom-flagged options.
    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A", custom: true },
        { id: "vendor/model-b", label: "vendor/model-b", custom: true },
      ],
    });
    await inst.dispose();
  });

  it("lists LM Studio chat keys from the native catalog and skips the OpenAI variant id", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/models")) {
        return Response.json({
          models: [
            { type: "llm", key: "google/gemma-4-26b-a4b" },
            { type: "embedding", key: "acme/vector-model" },
            { type: "decision", key: "acme/router" },
          ],
        });
      }
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "google/gemma-4-26b-a4b@q4_k_m" }] });
      return new Response("no", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenAICompatDriver.create({
      instanceId: "lm-studio",
      displayName: "LM Studio",
      enabled: true,
      config: { url: "http://127.0.0.1:1234/v1", key: "lm-studio", apiKeyEnv: "OPENAI_COMPAT_API_KEY", catalog: "lmstudio" },
      environment: {},
    });
    await inst.refreshModels?.();
    expect(inst.models.options.map((option) => option.id)).toEqual(["google/gemma-4-26b-a4b"]);
    expect(fetchMock.mock.calls.some((call) => {
      const url = String(call[0]);
      return url.endsWith("/v1/models") && !url.includes("/api/v1/");
    })).toBe(false);
    await inst.dispose();
  });

  it("keeps a configured LM Studio model when the native catalog omits it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/models")) {
        return Response.json({ models: [{ type: "llm", key: "other/model" }] });
      }
      return new Response("no", { status: 500 });
    }));
    const inst = await OpenAICompatDriver.create({
      instanceId: "lm-studio",
      displayName: "LM Studio",
      enabled: true,
      config: {
        url: "http://127.0.0.1:1234/v1",
        key: "lm-studio",
        apiKeyEnv: "OPENAI_COMPAT_API_KEY",
        model: "my-loaded-instance",
        catalog: "lmstudio",
      },
      environment: {},
    });
    await inst.refreshModels?.();
    expect(inst.models.default).toBe("my-loaded-instance");
    expect(inst.models.options.map((option) => option.id)).toEqual(["my-loaded-instance", "other/model"]);
    await inst.dispose();
  });

  it("asks only a server added as LM Studio for LM Studio's own catalog", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ data: [{ id: "local/model" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenAICompatDriver.create({
      instanceId: "local-server",
      displayName: "llama.cpp",
      enabled: true,
      config: { url: "http://127.0.0.1:8080/v1", key: "local", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    await inst.refreshModels?.();
    const asked = fetchMock.mock.calls.map(([input]) => String(input));
    expect(asked).toContain("http://127.0.0.1:8080/v1/models");
    expect(asked.filter((url) => url.includes("/api/v1/models"))).toEqual([]);
    expect(inst.models.options.map((option) => option.id)).toContain("local/model");
    await inst.dispose();
  });

  it("falls back to OpenAI-compatible models when the native LM Studio catalog request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/models")) throw new Error("native offline");
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "local-chat" }] });
      return new Response("no", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenAICompatDriver.create({
      instanceId: "lm-studio",
      displayName: "LM Studio",
      enabled: true,
      config: { url: "http://127.0.0.1:1234/v1", key: "lm-studio", apiKeyEnv: "OPENAI_COMPAT_API_KEY", catalog: "lmstudio" },
      environment: {},
    });
    await inst.refreshModels?.();
    expect(inst.models.options.map((option) => option.id)).toEqual(["local-chat"]);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/v1/models"))).toBe(true);
    await inst.dispose();
  });

  it("uses the OpenAI model list when the LM Studio catalog is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/models")) return new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } });
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "local-chat" }] });
      return new Response("no", { status: 500 });
    }));
    const inst = await OpenAICompatDriver.create({
      instanceId: "lm-studio",
      displayName: "LM Studio",
      enabled: true,
      config: { url: "http://127.0.0.1:1234/v1", key: "lm-studio", apiKeyEnv: "OPENAI_COMPAT_API_KEY", catalog: "lmstudio" },
      environment: {},
    });
    await inst.refreshModels?.();
    expect(inst.models.options.map((option) => option.id)).toEqual(["local-chat"]);
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
    // Local servers (oMLX in particular) emit stream usage only with stream_options.include_usage.
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

  it("does not double the transcript when the thread was rewound", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const transcript = [
      { role: "user" as const, text: "u25-sentinel-first-message" },
      { role: "assistant" as const, text: "u25-sentinel-first-reply" },
    ];
    // Mirrors server/index.ts: buildTurnContext inlines the transcript only for drivers that do not replay natively.
    const { turnText } = buildTurnContext({
      text: "second message",
      transcript,
      rewound: true,
      fresh: false,
      externallyUpdated: false,
      replaysNatively: replaysNatively("openai-compat"),
    });
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-u25",
      displayName: "U25",
      enabled: true,
      config: { url: "http://host.lima.internal:9090/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-u25", text: turnText, transcript });
    await recorder.until((e) => e.type === "turn.completed");

    const serialized = JSON.stringify(sentBody?.messages);
    const occurrences = serialized.split("u25-sentinel-first-message").length - 1;
    expect(occurrences).toBe(1);
    recorder.stop();
    await inst.dispose();
  });

  it("keeps the system message to the stable half and carries the volatile half in the newest user message", async () => {
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
      instanceId: "test-prompt-split",
      displayName: "Prompt split",
      enabled: true,
      config: { url: "http://localhost:9/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "thread-prompt-split",
      text: "hello",
      system: "Standing rules.\n\nMemory: likes quiet hours.",
      systemStable: "Standing rules.",
      systemVolatile: "Memory: likes quiet hours.",
      transcript: [
        { role: "user" as const, text: "earlier" },
        { role: "assistant" as const, text: "answer" },
      ],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const messages: any[] = sentBody?.messages ?? [];
    expect(messages[0]).toEqual({ role: "system", content: "Standing rules." });
    expect(messages.slice(1, 3)).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "answer" },
    ]);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nMemory: likes quiet hours.\n\nhello",
    });

    await inst.adapter.sendTurn({
      threadId: "thread-prompt-split-legacy",
      text: "bare",
      system: "Whole block.",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "thread-prompt-split-legacy");
    const legacy: any[] = sentBody?.messages ?? [];
    expect(legacy[0]).toEqual({ role: "system", content: "Whole block." });
    expect(legacy.at(-1)).toEqual({ role: "user", content: "bare" });
    recorder.stop();
    await inst.dispose();
  });

  describe("replays what each earlier user message actually carried", () => {
    const NOTE = "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\n";
    // index.ts stamps the turn text (clock, recall) but stores only what the person typed.
    const clock = (minute: string) => `Current time when this message was sent: Friday, 2026-10-09 18:${minute} UTC (UTC+00:00).\n\n`;

    const fixture = async () => {
      const bodies: any[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const inst = await OpenAICompatDriver.create({
        instanceId: "test-replay-notes",
        displayName: "Replay notes",
        enabled: true,
        config: { url: "http://localhost:9/v1", apiKeyEnv: "TEST_KEY" },
        environment: { TEST_KEY: "secret" },
      });
      const recorder = recordEvents(inst.adapter);
      let turns = 0;
      const send = async (input: { text: string; volatile: string; transcript: Array<{ role: "user" | "assistant"; text: string }>; threadId?: string; mentionTurn?: boolean; recalled?: string }) => {
        const threadId = input.threadId ?? "thread-replay";
        const settled = ++turns;
        await inst.adapter.sendTurn({
          threadId,
          text: input.text,
          system: `Standing rules.\n\n${input.volatile}`,
          systemStable: "Standing rules.",
          systemVolatile: input.volatile,
          transcript: input.transcript,
          ...(input.mentionTurn ? { mentionTurn: true } : {}),
          ...(input.recalled ? { recalled: input.recalled } : {}),
        });
        await recorder.until((e) => e.type === "turn.completed" && e.threadId === threadId &&
          recorder.events.filter((x) => x.type === "turn.completed").length >= settled);
        return bodies.at(-1)!.messages as any[];
      };
      return { send, done: async () => { recorder.stop(); await inst.dispose(); } };
    };

    it("keeps the previous request a byte-identical prefix when the volatile half is unchanged", async () => {
      const { send, done } = await fixture();
      const first = await send({ text: clock("00") + "hello", volatile: "Memory: likes tea.", transcript: [] });
      const second = await send({
        text: clock("01") + "next",
        volatile: "Memory: likes tea.",
        transcript: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
      });
      expect(second.slice(0, first.length)).toEqual(first);
      expect(first.at(-1)).toEqual({ role: "user", content: NOTE + "Memory: likes tea.\n\n" + clock("00") + "hello" });
      expect(second.slice(first.length)).toEqual([
        { role: "assistant", content: "hi" },
        { role: "user", content: clock("01") + "next" },
      ]);
      await done();
    });

    it("keeps the prefix and appends the new note when the volatile half changes", async () => {
      const { send, done } = await fixture();
      const first = await send({ text: clock("00") + "hello", volatile: "Memory: likes tea.", transcript: [] });
      const second = await send({
        text: clock("01") + "next",
        volatile: "Memory: likes coffee.",
        transcript: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
      });
      expect(second.slice(0, first.length)).toEqual(first);
      expect(second.at(-1)).toEqual({ role: "user", content: NOTE + "Memory: likes coffee.\n\n" + clock("01") + "next" });
      const third = await send({
        text: "again",
        volatile: "",
        transcript: [
          { role: "user", text: "hello" }, { role: "assistant", text: "hi" },
          { role: "user", text: "next" }, { role: "assistant", text: "hi" },
        ],
      });
      expect(third.slice(0, second.length)).toEqual(second);
      expect(third.at(-1)).toEqual({
        role: "user",
        content: "The OpenMausBot context notes from earlier in this conversation have been cleared; the standing instructions still apply.\n\nagain",
      });
      await done();
    });

    it("re-delivers the note once the message that carried it leaves the replayed window", async () => {
      const { send, done } = await fixture();
      await send({ text: "hello", volatile: "Memory: likes tea.", transcript: [] });
      await send({ text: "next", volatile: "Memory: likes tea.", transcript: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] });
      const trimmed = await send({
        text: "third",
        volatile: "Memory: likes tea.",
        transcript: [
          { role: "assistant", text: "[2 earlier messages omitted from this context; full history remains in the app.]" },
          { role: "user", text: "next" }, { role: "assistant", text: "hi" },
        ],
      });
      expect(trimmed.slice(1, -1)).toEqual([
        { role: "assistant", content: "[2 earlier messages omitted from this context; full history remains in the app.]" },
        { role: "user", content: "next" },
        { role: "assistant", content: "hi" },
      ]);
      expect(trimmed.at(-1)).toEqual({ role: "user", content: NOTE + "Memory: likes tea.\n\nthird" });
      await done();
    });

    it("leaves automatic recall out of the replay and keeps the added bytes bounded", async () => {
      const { send, done } = await fixture();
      const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
      const bytes = (messages: any[]) => Buffer.byteLength(JSON.stringify(messages));
      let previous: any[] = [];
      for (let turn = 0; turn < 20; turn++) {
        const minute = String(turn).padStart(2, "0");
        const recalled = `<recalled turn="${turn}">\n${"r".repeat(6000)}\n</recalled>`;
        const typed = `message ${turn}`;
        const messages = await send({
          text: `${clock(minute)}${recalled}\n\n${typed}`,
          recalled,
          volatile: `Recent work: ${"w".repeat(2000)} ${turn}`,
          transcript: [...transcript],
        });
        expect(messages.at(-1).content).toContain(recalled);
        if (turn > 0) expect(messages.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
        for (const message of messages.slice(1, -1)) expect(message.content).not.toContain("<recalled");
        const stored = [{ role: "system", content: "Standing rules." }, ...transcript.map((m) => ({ role: m.role, content: m.text }))];
        expect(bytes(messages.slice(0, -1)) - bytes(stored)).toBeLessThanOrEqual(24_000 + 2_000);
        previous = messages;
        transcript.push({ role: "user", text: typed }, { role: "assistant", text: "hi" });
      }
      await done();
    });

    it("does not lend a record to a later identical message it did not send", async () => {
      const { send, done } = await fixture();
      await send({ text: clock("00") + "continue", volatile: "Memory: likes tea.", transcript: [] });
      const messages = await send({
        text: clock("05") + "next",
        volatile: "Memory: likes tea.",
        transcript: [
          { role: "user", text: "continue" }, { role: "assistant", text: "hi" },
          { role: "user", text: "continue" }, { role: "assistant", text: "done" },
        ],
      });
      expect(messages.slice(1, -1)).toEqual([
        { role: "user", content: NOTE + "Memory: likes tea.\n\n" + clock("00") + "continue" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "continue" },
        { role: "assistant", content: "done" },
      ]);
      await done();
    });

    it("still delivers the note on a mention turn and on a thread it has not seen", async () => {
      const { send, done } = await fixture();
      await send({ text: "hello", volatile: "Tagged: @Testy", transcript: [] });
      const mention = await send({
        text: "@Testy again",
        volatile: "Tagged: @Testy",
        transcript: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
        mentionTurn: true,
      });
      expect(mention.at(-1)).toEqual({ role: "user", content: NOTE + "Tagged: @Testy\n\n@Testy again" });
      const unseen = await send({
        threadId: "thread-unseen",
        text: "later",
        volatile: "Memory: likes tea.",
        transcript: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
      });
      expect(unseen.slice(1)).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: NOTE + "Memory: likes tea.\n\nlater" },
      ]);
      await done();
    });
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

    // Strict endpoints (Groq et al.) reject unknown top-level fields; `provider` is OpenRouter-only.
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
          // Not openrouter.ai: a lookalike domain or path segment must not match.
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

      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part 1"}}]}\n\n'));

      await vi.advanceTimersByTimeAsync(185_000);

      const completed = await recorder.until((e) => e.type === "turn.completed");
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

      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"start "}}]}\n\n'));
      await vi.advanceTimersByTimeAsync(100_000);

      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"middle "}}]}\n\n'));
      await vi.advanceTimersByTimeAsync(100_000);

      controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"end"}}]}\n\n'));
      await vi.advanceTimersByTimeAsync(100_000);

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

describe("how long a turn waits for a reply", () => {
  it("accepts 1 to 60 whole minutes and refuses anything else", () => {
    expect(OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:11434/v1", replyWaitMinutes: 20 })).toMatchObject({ replyWaitMinutes: 20 });
    expect(OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:11434/v1" })).not.toHaveProperty("replyWaitMinutes");
    for (const bad of [0, 61, 2.5, "10", null]) {
      expect(() => OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:11434/v1", replyWaitMinutes: bad })).toThrow(/replyWaitMinutes/);
    }
  });
});


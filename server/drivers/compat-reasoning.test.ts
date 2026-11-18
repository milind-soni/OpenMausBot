import { afterEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { advertisedReasoning, reasoningChoices } from "./compat-reasoning.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const variants = (models: { options: Array<{ id: string; variants?: Array<{ id: string }> }> }, id: string) =>
  models.options.find((option) => option.id === id)?.variants?.map((choice) => choice.id);
const answer = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  { headers: { "content-type": "text/event-stream" } });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenAI-compatible reasoning choices", () => {
  it("uses the advertised wire format over a provider's default", () => {
    const advertised = advertisedReasoning({ supported_parameters: ["reasoning_effort"], reasoning_efforts: ["max"] });
    expect(advertised?.wire).toBe("flat");
    expect(reasoningChoices({
      model: "model", catalog: { default: "model", options: [{ id: "model", label: "model" }] },
      metadata: new Map([["model", advertised!]]), manual: true, wire: "nested",
    })?.wire).toBe("flat");
  });

  it("discovers declared levels, hides explicit refusals, and offers choices to new unknown models", async () => {
    let rows: Record<string, unknown>[] = [
      { id: "vendor-a/known", effort: { supported_levels: ["low", "max", "future"] } },
      { id: "vendor-b/unknown" },
      { id: "vendor-c/no-reasoning", supports_reasoning_effort: false },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: rows })));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-catalog", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY" },
      environment: { FIXTURE_KEY: "fixture" },
    });
    try {
      await instance.refreshModels?.();
      expect(instance.adapter.capabilities.modelVariants).toBe(true);
      expect(variants(instance.models, "vendor-a/known")).toEqual(["low", "max", "future"]);
      expect(variants(instance.models, "vendor-b/unknown")).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(variants(instance.models, "vendor-c/no-reasoning")).toBeUndefined();
      rows = [{ id: "vendor-a/known" }, { id: "vendor-d/new" }];
      await instance.refreshModels?.();
      expect(variants(instance.models, "vendor-a/known")).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(variants(instance.models, "vendor-d/new")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    } finally { await instance.dispose(); }
  });

  it("keeps fixed model lists private and accepts only valid explicit overrides", async () => {
    const calls = vi.fn(async () => Response.json({ data: [{ id: "must-not-be-listed" }] }));
    vi.stubGlobal("fetch", calls);
    const declared = { "vendor/model": ["low", "xhigh", "max"] };
    const config = OpenAICompatDriver.decodeConfig({ url: "https://example.test/v1", key: "fixture", managedModels: ["vendor/model"], reasoningEfforts: declared });
    declared["vendor/model"] = ["changed"];
    expect(config.reasoningEfforts).toEqual({ "vendor/model": ["low", "xhigh", "max"] });
    for (const reasoningEfforts of [null, [], {}, { x: [] }, { x: ["max", "max"] }, { x: [3] }]) {
      expect(() => OpenAICompatDriver.decodeConfig({ reasoningEfforts })).toThrow(/reasoningEfforts/);
    }
    const instance = await OpenAICompatDriver.create({ instanceId: "fixed-models", displayName: "Fixture", enabled: true, config, environment: {} });
    try {
      await instance.refreshModels?.();
      expect(calls).not.toHaveBeenCalled();
      expect(instance.models.options.map((option) => option.id)).toEqual(["vendor/model"]);
      expect(variants(instance.models, "vendor/model")).toEqual(["low", "xhigh", "max"]);
    } finally { await instance.dispose(); }
  });

  it.each([
    ["flat", { id: "vendor/future" }, "reasoning_effort"],
    ["nested", { id: "vendor/future", supported_parameters: ["reasoning"], reasoning_efforts: ["low", "max"] }, "reasoning"],
    ["model name resembling an Ollama alias", { id: "vendor/model-omb-16k", reasoning_efforts: ["max"] }, "reasoning_effort"],
  ])("sends the exact choice in the %s format, but omits it by default", async (_name, model, property) => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [model] });
      bodies.push(JSON.parse(String(init?.body)));
      return answer();
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-send", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY", tools: false },
      environment: { FIXTURE_KEY: "fixture" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      await instance.adapter.sendTurn({ threadId: "default", text: "hello", model: model.id });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.threadId === "default")).toMatchObject({ ok: true });
      await instance.adapter.sendTurn({ threadId: "max", text: "hello", model: model.id, variant: "max" });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.threadId === "max")).toMatchObject({ ok: true });
      expect(bodies[0]).not.toHaveProperty("reasoning_effort");
      expect(bodies[0]).not.toHaveProperty("reasoning");
      expect(bodies[1]!.model).toBe(model.id);
      expect(bodies[1]![property]).toEqual(property === "reasoning" ? { effort: "max" } : "max");
    } finally { recorder.stop(); await instance.dispose(); }
  });

  it("reports an unavailable selected level before sending a request", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "vendor/future", reasoning_efforts: ["low", "max"] }] });
      bodies.push(init?.body);
      return answer();
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-invalid", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY", tools: false },
      environment: { FIXTURE_KEY: "fixture" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      await instance.adapter.sendTurn({ threadId: "invalid", text: "hello", model: "vendor/future", variant: "xhigh" });
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
      expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("unavailable") }));
      expect(bodies).toEqual([]);
    } finally { recorder.stop(); await instance.dispose(); }
  });

  it("reports an endpoint rejection without retrying at a different level", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "vendor/future" }] });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { message: "Unsupported reasoning_effort" } }, { status: 400 });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-rejected", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY", tools: false },
      environment: { FIXTURE_KEY: "fixture" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      await instance.adapter.sendTurn({ threadId: "rejected", text: "hello", model: "vendor/future", variant: "max" });
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toHaveProperty("reasoning_effort", "max");
      expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error" }));
    } finally { recorder.stop(); await instance.dispose(); }
  });

  it("waits for initial model metadata before applying an explicit level", async () => {
    let release!: (response: Response) => void;
    const metadata = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return metadata;
      bodies.push(JSON.parse(String(init?.body)));
      return answer();
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-startup", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY", tools: false },
      environment: { FIXTURE_KEY: "fixture" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "startup", text: "hi", model: "vendor/future", variant: "future-level" });
      await recorder.until((event) => event.type === "turn.started");
      expect(bodies).toEqual([]);
      release(Response.json({ data: [{ id: "vendor/future", reasoning_efforts: ["future-level"] }] }));
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      expect(bodies[0]).toHaveProperty("reasoning_effort", "future-level");
    } finally { recorder.stop(); await instance.dispose(); }
  });

  it("can interrupt a turn while the initial model catalog is still loading", async () => {
    let release!: (response: Response) => void;
    const metadata = new Promise<Response>((resolve) => { release = resolve; });
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return metadata;
      bodies.push(init?.body);
      return answer();
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-cancel-startup", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY", tools: false },
      environment: { FIXTURE_KEY: "fixture" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "startup", text: "hi", model: "vendor/future", variant: "max", images: [{ path: "/not-read.png", mime: "image/png", bytes: 1 }] });
      await instance.adapter.interruptTurn("startup", turnId);
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "interrupted" });
      release(Response.json({ data: [{ id: "vendor/future" }] }));
      await instance.refreshModels?.();
      expect(bodies).toEqual([]);
    } finally { release(Response.json({ data: [] })); recorder.stop(); await instance.dispose(); }
  });

  it("keeps the selected effort on each round after a tool call", async () => {
    const bodies: Array<Record<string, any>> = [];
    const argumentsJson = JSON.stringify({ questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] });
    const call = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "ask1", type: "function", function: { name: "ask_user", arguments: argumentsJson } }] } }] };
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "vendor/future" }] });
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length > 1) return answer();
      return new Response("data: " + JSON.stringify(call) + '\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "reasoning-tool-round", displayName: "Fixture", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "FIXTURE_KEY" },
      environment: { FIXTURE_KEY: "fixture" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      await instance.adapter.sendTurn({ threadId: "thread", text: "hi", model: "vendor/future", variant: "max" });
      const opened = await recorder.until((event) => event.type === "request.opened");
      expect(await instance.adapter.respondToRequest("thread", opened.requestId!, { behavior: "answer", message: "Yes" })).toBe("answered");
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      expect(bodies).toHaveLength(2);
      expect(bodies.map((body) => body.reasoning_effort)).toEqual(["max", "max"]);
    } finally { recorder.stop(); await instance.dispose(); }
  }, 20_000);
});

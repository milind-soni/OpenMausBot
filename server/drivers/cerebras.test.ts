import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_USER_TOOL_DEFINITION } from "../../shared/ask-question.ts";
import { recordEvents } from "../testing/events.ts";
import { compactBudget, contextWindowFor, shouldCompact } from "../context-budget.ts";
import { CerebrasDriver } from "./cerebras.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const create = (config = {}) => CerebrasDriver.create({
  instanceId: "cerebras-test", displayName: "Cerebras", enabled: true,
  config: CerebrasDriver.decodeConfig(config), environment: { CEREBRAS_API_KEY: "fixture-key" },
});

describe("Cerebras provider", () => {
  it("compacts known models before the free-tier context limit", () => {
    for (const { id } of CerebrasDriver.models.options) {
      const window = contextWindowFor(id, CerebrasDriver.models);
      expect(window).toBeLessThanOrEqual(65536);
      expect(shouldCompact({ contextTokens: 60000, estimatedBytes: 0, budget: compactBudget(window), window })).toBe(true);
    }
  });
  it("rejects invalid tools flags and non-TLS remote endpoints", () => {
    expect(() => CerebrasDriver.decodeConfig({ tools: "false" })).toThrow();
    expect(() => CerebrasDriver.decodeConfig({ url: "http://example.com/v1" })).toThrow("HTTPS");
    expect(CerebrasDriver.defaultConfig().url).toBe("https://api.cerebras.ai/v1");
    expect(CerebrasDriver.decodeConfig({ url: "http://127.0.0.1:1234/v1/" }).url).toBe("http://127.0.0.1:1234/v1");
  });

  it("does not contact the provider without a key", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const instance = await CerebrasDriver.create({ instanceId: "empty", displayName: "Cerebras", enabled: true,
      config: CerebrasDriver.defaultConfig(), environment: {} });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Cerebras API key") });
    expect(fetcher).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("lists the live catalog, keeping known labels and a configured custom model", async () => {
    const fetcher = vi.fn(async () => Response.json({ object: "list", data: [
      { id: "gpt-oss-120b", object: "model" }, { id: "brand-new-model" }, { id: "gpt-oss-120b" }, null, { id: "" },
    ] }));
    vi.stubGlobal("fetch", fetcher);
    const instance = await create({ model: "private-model" });
    await instance.refreshModels?.();
    expect(instance.models.default).toBe("private-model");
    expect(instance.models.options).toEqual([
      { id: "private-model", label: "private-model" },
      { id: "gpt-oss-120b", label: "GPT OSS 120B", contextWindow: 65536 },
      { id: "brand-new-model", label: "brand-new-model" },
    ]);
    expect(fetcher.mock.calls[0]).toMatchObject(["https://api.cerebras.ai/v1/models", {
      headers: { authorization: "Bearer fixture-key" }, redirect: "error",
    }]);
    await instance.dispose();
  });

  it("streams text with usage requested and the built-in tools attached", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      request = init;
      return new Response('data: {"choices":[{"delta":{"reasoning":"Thinking."}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "chat", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    expect(JSON.parse(String(request?.body))).toEqual({ model: "gpt-oss-120b", stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }], tools: [ASK_USER_TOOL_DEFINITION] });
    recorder.stop(); await instance.dispose();
  });

  it.each([
    ["Checking the live HN front page in the browser first — the top story can rotate between requests.", 2],
    ["Opening the page now:", 2],
    ["The top story is about Gemini 4. Want a longer summary?", 1],
    ["Here is the summary: it covers Google's new model and its benchmarks.", 1],
  ] as const)("nudges an announced-but-skipped action once: %s", async (first, requests) => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      bodies.push(JSON.parse(String(init?.body)));
      // A model that keeps announcing is nudged once, never looped.
      const text = bodies.length === 1 || requests === 2 ? first : "unreachable";
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "nudge", text: "open the top story on HN" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(bodies).toHaveLength(requests);
    if (requests === 2) expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("called no tool") });
    recorder.stop(); await instance.dispose();
  });

  it("replays reasoning after a tool call as `reasoning`, which Cerebras accepts, never `reasoning_content`", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const question = { questions: [{ question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }] }] };
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      bodies.push(JSON.parse(String(init?.body)));
      const chunks = bodies.length === 1 ? [
        { choices: [{ index: 0, delta: { reasoning: "Need the city first." } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "ask_city", type: "function",
          function: { name: "ask_user", arguments: JSON.stringify(question) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ] : [{ choices: [{ index: 0, delta: { content: "Sunny." }, finish_reason: "stop" }] }];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "replay", text: "Weather?" });
      const opened = await recorder.until(event => event.type === "request.opened");
      await instance.adapter.respondToRequest("replay", opened.requestId!, { behavior: "answer", message: "Pune" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      const replayed = bodies[1]!.messages.find(message => message.role === "assistant");
      expect(replayed).toMatchObject({ reasoning: "Need the city first." });
      expect(replayed).not.toHaveProperty("reasoning_content");
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

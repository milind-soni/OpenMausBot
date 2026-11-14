import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { GroqDriver } from "./groq.ts";

type ChatBody = { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[] };
const fixtureKey = `gsk_${"a".repeat(48)}`;
const stream = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
};

describe("Groq provider", () => {
  let server: Server;
  let base: string;
  let models: unknown;
  let reply: (body: ChatBody, res: ServerResponse) => void;
  let requests: Array<{ path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    requests = [];
    instances = [];
    models = { data: [{ id: "openai/gpt-oss-120b" }] };
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
    base = `http://127.0.0.1:${address.port}/openai/v1`;
  });

  afterEach(async () => {
    await Promise.all(instances.map(instance => instance.dispose()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  const create = async (config = {}, environment = { GROQ_API_KEY: fixtureKey }) => {
    const instance = await GroqDriver.create({ instanceId: "groq-fixture", displayName: "Groq", enabled: true,
      config: GroqDriver.decodeConfig(config), environment });
    instances.push(instance);
    return instance;
  };

  it("presets Groq's endpoint, rejects unsafe configuration and never sends an unkeyed turn", async () => {
    expect(GroqDriver.defaultConfig().url).toBe("https://api.groq.com/openai/v1");
    expect(() => GroqDriver.decodeConfig({ url: "http://provider.example.test/v1" })).toThrow("HTTPS");
    expect(() => GroqDriver.decodeConfig({ tools: "false" })).toThrow();
    const instance = await create({ url: base }, { GROQ_API_KEY: "" });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Groq API key") });
      await expect(instance.adapter.sendTurn({ threadId: "missing", text: "Hello" })).rejects.toThrow("Groq API key");
      expect(requests).toHaveLength(0);
    } finally { recorder.stop(); }
  });

  it("does not send the server's Groq key to a custom instance host", async () => {
    vi.stubEnv("GROQ_API_KEY", fixtureKey);
    const instance = await create({ url: base }, { GROQ_API_KEY: "" });
    await instance.refreshModels?.();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
    // Absence, rather than an explicit blank, must fail closed too.
    const unkeyed = await GroqDriver.create({ instanceId: "custom", displayName: "Custom Groq", enabled: true,
      config: GroqDriver.decodeConfig({ url: base }), environment: {} });
    instances.push(unkeyed);
    expect(await unkeyed.snapshot()).toMatchObject({ state: "unavailable" });
    expect(requests).toHaveLength(0);
  });

  it("discovers usable chat models and retains the last catalog after malformed refreshes", async () => {
    models = { data: [
      { id: "openai/gpt-oss-20b", active: true, context_window: 131072 },
      { id: "new-chat", context_window: 65536 }, { id: "new-chat" },
      { id: "inactive-chat", active: false }, { id: "whisper-large-v3" },
      { id: "canopylabs/orpheus-v1-english" }, { id: "meta-llama/llama-prompt-guard-2-86m" },
      null, { id: " " }, { id: 7 }, { id: "bad-context", context_window: -1 },
    ] };
    const instance = await create({ url: base });
    await instance.refreshModels?.();
    expect(instance.models).toEqual({ default: "openai/gpt-oss-20b", options: [
      { id: "openai/gpt-oss-20b", label: "GPT OSS 20B", contextWindow: 131072 },
      { id: "new-chat", label: "new-chat", contextWindow: 65536 },
    ] });
    expect(requests.every(request => request.path === "/openai/v1/models" && request.authorization === `Bearer ${fixtureKey}`)).toBe(true);
    const previous = instance.models;
    for (const malformed of [null, { data: "wrong" }, { data: [] }]) {
      models = malformed;
      await instance.refreshModels?.();
      expect(instance.models).toEqual(previous);
    }
  });

  it.each([false, true])("streams the selected model, reasoning and Groq usage (standard usage: %s)", async standardUsage => {
    reply = (_body, res) => stream(res, [
      { choices: [{ delta: { reasoning: "Thinking." } }] },
      { choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] },
      { choices: [], x_groq: { usage: { prompt_tokens: 12, completion_tokens: 3 } },
        ...(standardUsage ? { usage: { prompt_tokens: 14, completion_tokens: 4 } } : {}) },
    ]);
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "stream", text: "Hello", model: "openai/gpt-oss-20b" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true,
        usage: standardUsage ? { input: 14, output: 4 } : { input: 12, output: 3 } });
      expect(recorder.events.some(event => event.type === "content.delta" && event.streamKind === "reasoning_text" && event.delta === "Thinking.")).toBe(true);
      expect(instance.adapter.provider).toBe("groq");
      const request = requests.find(request => request.path.endsWith("/chat/completions"))!;
      expect(request.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(request.body).toMatchObject({ model: "openai/gpt-oss-20b", stream: true, tools: expect.any(Array) });
      expect(request.body).not.toHaveProperty("stream_options");
    } finally { recorder.stop(); }
  });

  it("waits for a question answer and replays reasoning in Groq's accepted field", async () => {
    reply = (body, res) => {
      if (body.messages.some(message => message.role === "tool")) {
        stream(res, [{ choices: [{ delta: { content: "Sunny." }, finish_reason: "stop" }] }]);
      } else {
        stream(res, [
          { choices: [{ delta: { reasoning: "Need the city first." } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "ask-city", type: "function", function: {
            name: "ask_user", arguments: JSON.stringify({ questions: [{ question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }] }] }),
          } }] }, finish_reason: "tool_calls" }] },
        ]);
      }
    };
    const instance = await create({ url: base });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "question", text: "Weather?" });
      const opened = await recorder.until(event => event.type === "request.opened");
      expect(requests.filter(request => request.body)).toHaveLength(1);
      await instance.adapter.respondToRequest("question", opened.requestId!, { behavior: "answer", message: "Pune" });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      const replayed = requests.filter(request => request.body)[1].body!.messages.find(message => message.role === "assistant");
      expect(replayed).toMatchObject({ reasoning: "Need the city first." });
      expect(replayed).not.toHaveProperty("reasoning_content");
    } finally { recorder.stop(); }
  });

  it("reports Groq usage from a non-streaming helper response", async () => {
    reply = (_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "openai/gpt-oss-120b", choices: [{ message: { content: "Short summary." }, finish_reason: "stop" }],
        x_groq: { usage: { prompt_tokens: 10, completion_tokens: 2 } } }));
    };
    const instance = await create({ url: base });
    const onUsage = vi.fn();
    expect(await instance.generateText!("Summarize", { onUsage })).toBe("Short summary.");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-oss-120b", input: 10, output: 2 }));
  });

  it("reports a rejected key without exposing it in canonical errors", async () => {
    reply = (_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Invalid API key: ${fixtureKey}` } }));
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

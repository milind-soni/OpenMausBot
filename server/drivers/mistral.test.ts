import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_USER_TOOL_DEFINITION } from "../../shared/ask-question.ts";
import { recordEvents } from "../testing/events.ts";
import { MistralDriver } from "./mistral.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const create = (config = {}) => MistralDriver.create({
  instanceId: "mistral-test", displayName: "Mistral", enabled: true,
  config: MistralDriver.decodeConfig(config), environment: { MISTRAL_API_KEY: "fixture-key" },
});

describe("Mistral provider", () => {
  it.each([undefined, true, false])("advertises computer capabilities according to tools=%s", async (tools) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    const instance = await create({ tools });
    try {
      expect(instance.adapter.capabilities).toMatchObject({ computerMcp: tools !== false, localComputerMcp: tools !== false });
    } finally { await instance.dispose(); }
  });

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

  it("keeps the desktop store's workspace key away from an instance with its own URL", async () => {
    vi.stubEnv("OMB_DESKTOP_PARENT", "1");
    vi.stubEnv("MISTRAL_API_KEY", "fixture-workspace-key");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const instance = await MistralDriver.create({ instanceId: "own-url", displayName: "Mine", enabled: true,
      config: MistralDriver.decodeConfig({ url: "https://mine.example.test/v1" }), environment: {} });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
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

  it("sends images on loopback only for catalog vision models and aliases, retaining flags after failed refreshes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mistral-images-"));
    const path = join(directory, "input.png");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
    writeFileSync(path, Buffer.from(png, "base64"));
    const catalog = { data: [
      { id: "vision", aliases: ["vision-latest"], capabilities: { completion_chat: true, vision: true } },
      { id: "text", capabilities: { vision: false } }, { id: "unspecified" },
    ] };
    let data: unknown = catalog;
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json(data);
      request = init;
      return new Response('data: {"choices":[{"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create({ url: "http://127.0.0.1:1234/v1", model: "custom" });
    try {
      const cases = [
        { data: catalog, model: "vision", sees: true },
        { data: catalog, model: "vision-latest", sees: true },
        { data: catalog, model: "text", sees: false },
        { data: catalog, model: "unspecified", sees: false },
        { data: catalog, model: "custom", sees: false },
        { data: { error: "offline" }, model: "vision-latest", sees: true },
        { data: { data: [] }, model: "vision", sees: true },
        { data: { data: [{ id: "vision", aliases: ["vision-latest"], capabilities: { vision: false } }] }, model: "vision-latest", sees: false },
      ];
      for (const [index, entry] of cases.entries()) {
        data = entry.data;
        await instance.refreshModels?.();
        const recorder = recordEvents(instance.adapter);
        try {
          await instance.adapter.sendTurn({ threadId: `image-${index}`, text: "Describe", model: entry.model,
            images: [{ path, mime: "image/png", bytes: Buffer.from(png, "base64").length }] });
          expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
          const body = JSON.parse(String(request?.body));
          expect(body.model).toBe(entry.model);
          expect(body.messages[0].content).toEqual(entry.sees ? [
            { type: "text", text: "Describe" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
          ] : expect.stringContaining("Describe\n\n"));
          if (entry.sees) expect(request?.redirect).toBe("error");
        } finally { recorder.stop(); }
      }
    } finally {
      await instance.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, true, false])("streams text and usage with only supported request fields (tools=%s)", async (tools) => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      request = init;
      return new Response('data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hello"},{"type":"reference","reference_ids":[0]}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create({ tools });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "chat", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, usage: { input: 15, output: 2 } });
    expect(JSON.parse(String(request?.body))).toEqual({ model: "mistral-large-latest", stream: true,
      messages: [{ role: "user", content: "hello" }],
      ...(tools === false ? {} : { tools: [ASK_USER_TOOL_DEFINITION] }) });
    recorder.stop(); await instance.dispose();
  });

  it("holds a built-in question until the person answers, then returns the answer verbatim", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const question = { questions: [{ question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }] }] };
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      bodies.push(JSON.parse(String(init?.body)));
      const chunks = bodies.length === 1 ? [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "ask_city", type: "function",
          function: { name: "ask_user", arguments: JSON.stringify(question) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ] : [{ choices: [{ index: 0, delta: { content: "Received." }, finish_reason: "stop" }] }];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await create();
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "question", text: "Plan a visit." });
      const opened = await recorder.until(event => event.type === "request.opened");
      expect(opened).toMatchObject({ requestType: "question", tool: "ask_user", choices: ["Pune", "Mumbai"] });
      expect(bodies).toHaveLength(1);
      const answer = "The user answered your questions.\n\nQ: Which city?\nA: Pune\n\nStay two nights.";
      expect(await instance.adapter.respondToRequest("question", opened.requestId!, { behavior: "answer", message: answer })).toBe("answered");
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      const result = bodies[1]!.messages.find(message => message.role === "tool");
      expect(JSON.parse(result!.content).result).toBe(answer);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
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

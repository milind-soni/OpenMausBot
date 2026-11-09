import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { instanceLook } from "../provider-icon.ts";
import { forgetServedModels } from "./ollama-context.ts";
import {
  answeredAsOllama, findOllama, forgetOllamaAnswers, isOllamaServer, ollamaOrigin, ollamaTags, ollamaUnavailable,
  probeOllama, showCapabilities,
} from "./ollama.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const GB = 1e9;
const running: Server[] = [];

afterEach(async () => {
  forgetOllamaAnswers();
  forgetServedModels();
  for (const server of running.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface FakeModel { name: string; size?: number; details?: Record<string, unknown>; capabilities?: string[] }

/** A server speaking Ollama's own routes and its OpenAI-compatible chat, recording each chat request. */
async function fakeOllama(options: { models?: FakeModel[]; version?: string | null; tags?: boolean } = {}) {
  // Read per request, so a test can change what the server answers.
  const models = options.models ?? [];
  const chats: Array<{ model: string; tools?: unknown[] }> = [];
  const asked: string[] = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const part of request) data += part.toString();
    const path = request.url ?? "";
    asked.push(path);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (path === "/api/tags" && options.tags !== false) return json({ models });
    if (path === "/api/version" && options.version !== null) return json({ version: options.version ?? "0.12.6" });
    if (path === "/api/show") {
      const model = models.find((entry) => entry.name === (JSON.parse(data) as { model: string }).model);
      return model ? json({ capabilities: model.capabilities, model_info: { "llama.context_length": 131_072 } }) : json({ error: "not found" }, 404);
    }
    if (path === "/api/ps") return json({ models: [] });
    if (path === "/api/create") return json({ status: "success" });
    if (path === "/v1/models") return json({ data: models.map((model) => ({ id: model.name })) });
    if (path === "/v1/chat/completions") {
      chats.push(JSON.parse(data) as { model: string; tools?: unknown[] });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\n`);
      return response.end("data: [DONE]\n\n");
    }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats, asked };
}

/** An address nothing listens on. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** A server that takes the connection and never answers. */
async function silentServer(): Promise<string> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const LLAMA: FakeModel = {
  name: "llama3.2:latest", size: 2_019_393_189,
  details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" }, capabilities: ["completion", "tools"],
};
const GEMMA: FakeModel = {
  name: "gemma2:2b", size: 1_629_518_495,
  details: { family: "gemma2", parameter_size: "2.6B", quantization_level: "Q4_0" }, capabilities: ["completion"],
};
const EMBED: FakeModel = { name: "nomic-embed-text:latest", size: 274_302_450, details: { family: "nomic-bert" } };

describe("Ollama's model list", () => {
  it("keeps the chat models with their size, parameters and quantization", () => {
    expect(ollamaTags({ models: [LLAMA, EMBED, { name: "llama3.2:latest-omb-32k", size: GB }, { name: "mxbai-embed-large" }, LLAMA] })).toEqual([
      { name: "llama3.2:latest", bytes: 2_019_393_189, parameters: "3.2B", quantization: "Q4_K_M" },
    ]);
  });

  it("is no list for an answer that is not one", () => {
    expect(ollamaTags({ data: [] })).toBeNull();
    expect(ollamaTags(null)).toBeNull();
    expect(ollamaTags({ models: [] })).toEqual([]);
  });

  it("reads what a model can do, and nothing from a server that does not say", () => {
    expect(showCapabilities({ capabilities: ["completion", "tools", "vision"] })).toEqual({ tools: true, vision: true });
    expect(showCapabilities({ capabilities: ["completion"] })).toEqual({ tools: false, vision: false });
    expect(showCapabilities({ model_info: {} })).toEqual({});
  });

  it("drops the /v1 the OpenAI-compatible routes sit under", () => {
    expect(ollamaOrigin("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
    expect(ollamaOrigin("http://gpu-box.local:11434")).toBe("http://gpu-box.local:11434");
  });
});

describe("finding Ollama", () => {
  it("is ready with the pulled models, and asks each what it can do only when told to", async () => {
    const { url } = await fakeOllama({ models: [LLAMA, GEMMA, EMBED] });
    expect(await probeOllama(`${url}/v1`)).toEqual({
      state: "ready", url, version: "0.12.6",
      models: [
        { name: "llama3.2:latest", bytes: 2_019_393_189, parameters: "3.2B", quantization: "Q4_K_M" },
        { name: "gemma2:2b", bytes: 1_629_518_495, parameters: "2.6B", quantization: "Q4_0" },
      ],
    });
    const asked = await probeOllama(url, { capabilities: true });
    expect(asked.models.map(({ name, tools, vision }) => ({ name, tools, vision }))).toEqual([
      { name: "llama3.2:latest", tools: true, vision: false },
      { name: "gemma2:2b", tools: false, vision: false },
    ]);
    expect(answeredAsOllama(url)).toBe(true);
  });

  it("goes by what a model can do over what it is called, once the server says", async () => {
    const assistant: FakeModel = { name: "embedded-assistant:latest", details: { family: "llama" }, capabilities: ["completion"] };
    const vectors: FakeModel = { name: "search-vectors:latest", details: { family: "custom" }, capabilities: ["embedding"] };
    const { url } = await fakeOllama({ models: [assistant, vectors] });
    expect((await probeOllama(url, { capabilities: true })).models.map((model) => model.name)).toEqual(["embedded-assistant:latest"]);
  });

  it("says when nothing is pulled yet, with the command that pulls a model", async () => {
    const { url } = await fakeOllama({ models: [EMBED] });
    const status = await probeOllama(url);
    expect(status).toMatchObject({ state: "no-models", models: [] });
    expect(ollamaUnavailable(status)).toMatch(/no models yet\. Run `ollama pull llama3\.2`/);
  });

  it("says when nothing listens at the address", async () => {
    const url = await closedPort();
    const status = await probeOllama(url);
    expect(status).toEqual({ state: "not-running", url, models: [] });
    expect(ollamaUnavailable(status)).toBe(`Ollama isn't running at ${url}. Open the Ollama app or run \`ollama serve\`.`);
    expect(answeredAsOllama(url)).toBeUndefined();
  });

  it("is unreachable when the server does not answer in time", async () => {
    const url = await silentServer();
    const status = await probeOllama(url, { timeoutMs: 150 });
    expect(status).toEqual({ state: "unreachable", url, models: [], problem: "timeout" });
    expect(ollamaUnavailable(status)).toMatch(/^Can't reach Ollama at .*: it did not answer in time\./);
  });

  it("is unreachable when the host is unknown", async () => {
    const status = await probeOllama("http://ollama.invalid:11434", { timeoutMs: 2_000 });
    expect(status).toMatchObject({ state: "unreachable", problem: expect.stringMatching(/^(network|timeout)$/) });
  });

  it("tells another server apart, and leaves it to its OpenAI-compatible routes", async () => {
    const other = await fakeOllama({ models: [LLAMA], tags: false });
    expect(await probeOllama(other.url)).toEqual({ state: "unreachable", url: other.url, models: [], problem: "not-ollama" });
    expect(ollamaUnavailable(await probeOllama(other.url))).toBeNull();
    // Some servers imitate /api/tags, but never /api/version.
    const imitation = await fakeOllama({ models: [LLAMA], version: null });
    expect((await probeOllama(imitation.url)).state).toBe("ready");
    expect(answeredAsOllama(imitation.url)).toBe(false);
  });

  it("keeps a yes through a failed version request, but not through a server that stops answering as Ollama", async () => {
    const options: Parameters<typeof fakeOllama>[0] = { models: [LLAMA] };
    const { url } = await fakeOllama(options);
    await probeOllama(url);
    options.version = null;
    await probeOllama(url);
    expect(answeredAsOllama(url)).toBe(true);
    options.tags = false;
    await probeOllama(url);
    expect(answeredAsOllama(url)).toBe(false);
  });

  it("takes the first address that runs, else what the first address said", async () => {
    const { url } = await fakeOllama({ models: [LLAMA] });
    const closed = await closedPort();
    expect(await findOllama([closed], { localUrls: [url] })).toMatchObject({ state: "ready", url });
    const silent = await silentServer();
    expect(await findOllama([closed, silent], { timeoutMs: 150, localUrls: [] })).toMatchObject({ state: "unreachable", url: silent });
  });
});

describe("an OpenAI-compatible server that is really Ollama", () => {
  it("is one when added as Ollama, on Ollama's port, or when it answered as Ollama", async () => {
    expect(isOllamaServer({ url: "http://gpu-box.local:8080/v1", catalog: "ollama" })).toBe(true);
    expect(isOllamaServer({ url: "http://127.0.0.1:11434/v1" })).toBe(true);
    expect(isOllamaServer({ url: "http://127.0.0.1:11434/v1", catalog: "lmstudio" })).toBe(false);
    expect(isOllamaServer({ url: "https://openrouter.ai/api/v1" })).toBe(false);
    const { url } = await fakeOllama({ models: [LLAMA] });
    expect(isOllamaServer({ url: `${url}/v1` })).toBe(false);
    await probeOllama(url);
    expect(isOllamaServer({ url: `${url}/v1` })).toBe(true);
  });

  it("stops being one on Ollama's port once something else has answered there", async () => {
    const config = { url: "http://127.0.0.1:11434/v1" };
    expect(isOllamaServer(config)).toBe(true);
    await probeOllama(config.url, { fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch });
    expect(isOllamaServer(config)).toBe(false);
    expect(instanceLook({ driver: "openai-compat", config })).toEqual({});
  });

  it("shows as Ollama: its mark, and its name unless someone named it", () => {
    const builtIn = { driver: "openai-compat", config: { url: "http://localhost:11434/v1" } };
    expect(instanceLook(builtIn)).toEqual({ icon: { kind: "preset", preset: "ollama" }, serverKind: "ollama", displayName: "Ollama" });
    expect(instanceLook({ ...builtIn, displayName: "Studio box" })).toEqual({ icon: { kind: "preset", preset: "ollama" }, serverKind: "ollama" });
    const custom = { kind: "custom", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } as const;
    expect(instanceLook({ ...builtIn, icon: custom })).toMatchObject({ icon: custom, serverKind: "ollama" });
    expect(instanceLook({ driver: "openai-compat", config: { url: "https://api.deepseek.com/v1" } })).toEqual({ icon: { kind: "preset", preset: "deepseek" } });
  });
});

describe("the chat engine on Ollama", () => {
  const create = (config: Record<string, unknown>, environment: Record<string, string> = {}) => OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: undefined, enabled: true, config: OpenAICompatDriver.decodeConfig(config), environment,
  });

  it("needs no key, lists the pulled models with their facts, and is available", async () => {
    const { url } = await fakeOllama({ models: [LLAMA, GEMMA] });
    const instance = await create({ url: `${url}/v1`, catalog: "ollama" });
    try {
      expect(instance.models).toEqual({
        default: "llama3.2:latest",
        options: [
          { id: "llama3.2:latest", label: "llama3.2:latest", custom: true, local: { bytes: 2_019_393_189, parameters: "3.2B", quantization: "Q4_K_M", tools: true, vision: false } },
          { id: "gemma2:2b", label: "gemma2:2b", custom: true, local: { bytes: 1_629_518_495, parameters: "2.6B", quantization: "Q4_0", tools: false, vision: false } },
        ],
      });
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    } finally { await instance.dispose(); }
  });

  it("is unavailable, saying why, while Ollama is not running or has nothing to run", async () => {
    const closed = await create({ url: `${await closedPort()}/v1`, catalog: "ollama" });
    try {
      expect(await closed.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/^Ollama isn't running at /), ollama: { state: "not-running" } });
      expect(closed.models).toEqual({ default: "", options: [] });
    } finally { await closed.dispose(); }
    const { url } = await fakeOllama({ models: [] });
    const empty = await create({ url: `${url}/v1`, catalog: "ollama" });
    try {
      await empty.refreshModels?.();
      expect(await empty.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("ollama pull llama3.2"), ollama: { state: "no-models", url } });
    } finally { await empty.dispose(); }
  });

  it("says so when a server added as Ollama answers as something else", async () => {
    const { url } = await fakeOllama({ models: [LLAMA], tags: false });
    const instance = await create({ url: `${url}/v1`, catalog: "ollama" });
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("it isn't Ollama"), ollama: { state: "unreachable", problem: "not-ollama" } });
    } finally { await instance.dispose(); }
  });

  it("holds a first turn until the list says what its model can do", async () => {
    const { url, chats } = await fakeOllama({ models: [GEMMA] });
    const real = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", (async (input, init) => {
      if (String(input).endsWith("/api/show")) await held;
      return real(input, init);
    }) as typeof fetch);
    const instance = await create({ url: `${url}/v1`, catalog: "ollama" });
    const recorder = recordEvents(instance.adapter);
    try {
      const threadId = randomUUID();
      const started = instance.adapter.sendTurn({ threadId, text: "hi", model: "gemma2:2b" });
      release();
      await started;
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId);
      expect(chats[0]!.tools).toBeUndefined();
    } finally {
      recorder.stop();
      await instance.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("recognises a server someone added as OpenAI-compatible, and keeps its saved key and model", async () => {
    const { url } = await fakeOllama({ models: [LLAMA, GEMMA] });
    const config = { url: `${url}/v1`, apiKeyEnv: "FIXTURE_KEY", model: "gemma2:2b" };
    const instance = await create(config, { FIXTURE_KEY: "fixture-key" });
    try {
      await instance.refreshModels?.();
      expect(instance.models.default).toBe("gemma2:2b");
      expect(instance.models.options.map((option) => option.id)).toEqual(["llama3.2:latest", "gemma2:2b"]);
      expect(instanceLook({ driver: "openai-compat", displayName: "Local", config })).toMatchObject({ icon: { kind: "preset", preset: "ollama" }, serverKind: "ollama" });
    } finally { await instance.dispose(); }
  });

  it("leaves a server that is not Ollama to its OpenAI-compatible model list", async () => {
    const { url } = await fakeOllama({ models: [LLAMA], tags: false });
    const instance = await create({ url: `${url}/v1`, apiKeyEnv: "FIXTURE_KEY" }, { FIXTURE_KEY: "fixture-key" });
    try {
      await instance.refreshModels?.();
      expect(instance.models.options).toEqual([{ id: "llama3.2:latest", label: "llama3.2:latest", custom: true }]);
      expect(await instance.snapshot()).toMatchObject({ state: "available" });
      expect(instanceLook({ driver: "openai-compat", displayName: "Local", config: { url: `${url}/v1` } })).toEqual({});
    } finally { await instance.dispose(); }
  });

  it("keeps a fixed model list on Ollama, and still knows which of them can call tools", async () => {
    const { url, chats } = await fakeOllama({ models: [LLAMA, GEMMA] });
    const instance = await create({ url: `${url}/v1`, catalog: "ollama", managedModels: ["gemma2:2b"] });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      expect(instance.models).toEqual({ default: "gemma2:2b", options: [{ id: "gemma2:2b", label: "gemma2:2b" }] });
      const threadId = randomUUID();
      await instance.adapter.sendTurn({ threadId, text: "hi", model: "gemma2:2b" });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId);
      expect(chats[0]!.tools).toBeUndefined();
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("tells a text-only model on the network about an attachment instead of refusing the turn", async () => {
    const replies: Record<string, unknown> = {
      "/api/tags": { models: [GEMMA] }, "/api/version": { version: "0.12.6" }, "/api/show": { capabilities: ["completion"] }, "/api/ps": { models: [] }, "/api/create": { status: "success" },
    };
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/chat/completions") {
        bodies.push(String(init!.body));
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify(replies[path] ?? {}), { status: replies[path] ? 200 : 404 });
    }));
    const instance = await create({ url: "http://192.168.1.20:11434/v1", catalog: "ollama" });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      const threadId = randomUUID();
      await instance.adapter.sendTurn({ threadId, text: "what is this?", model: "gemma2:2b", images: [{ path: "/not-read.png", mime: "image/png", bytes: 1 }] });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId);
      expect(bodies[0]).toContain("this model cannot see images");
    } finally {
      recorder.stop();
      await instance.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("never asks another server on this network for Ollama's model list", async () => {
    const { url, asked } = await fakeOllama({ models: [LLAMA], version: null });
    const instance = await create({ url: `${url}/v1`, apiKeyEnv: "FIXTURE_KEY" }, { FIXTURE_KEY: "fixture-key" });
    try {
      await instance.refreshModels?.();
      await instance.snapshot();
      expect(asked).toContain("/api/version");
      expect(asked).not.toContain("/api/tags");
      expect(instance.models.options.map((option) => option.id)).toEqual(["llama3.2:latest"]);
    } finally { await instance.dispose(); }
  });

  it("asks nothing of a server on this network that has a fixed model list", async () => {
    const { url } = await fakeOllama({ models: [LLAMA] });
    const instance = await create({ url: `${url}/v1`, apiKeyEnv: "FIXTURE_KEY", managedModels: ["llama3.2:latest"] }, { FIXTURE_KEY: "fixture-key" });
    try {
      await instance.snapshot();
      expect(answeredAsOllama(url)).toBeUndefined();
    } finally { await instance.dispose(); }
  });

  it("sends tools only to a model that can call them", async () => {
    const { url, chats } = await fakeOllama({ models: [LLAMA, GEMMA] });
    const instance = await create({ url: `${url}/v1`, catalog: "ollama" });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      for (const model of ["llama3.2:latest", "gemma2:2b"]) {
        const threadId = randomUUID();
        await instance.adapter.sendTurn({ threadId, text: "hi", model });
        await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId);
      }
      expect(chats.map((chat) => Boolean(chat.tools?.length))).toEqual([true, false]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

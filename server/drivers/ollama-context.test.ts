import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

import { applyClaudeInject, decodeInjectId, encodeInjectId, injectedContextWindow, localHost, withLocalContext } from "./local-inject.ts";
import { forgetServedModels, isCloudName, isContextName, isOllama, pickedName, servedModel, serveWithWindow, showFacts, windowFor } from "./ollama-context.ts";
import type { ProviderInstance } from "../contracts.ts";

const GB = 1024 ** 3;
const ORIGIN = "http://127.0.0.1:11434";

afterEach(() => forgetServedModels());

/** A server speaking the routes this reads, recording what it was asked to create. */
function ollama(options: { show?: unknown; size?: number; running?: unknown[]; tags?: unknown[]; createStatus?: number; gone?: string[] } = {}) {
  const created: Array<{ model: string; from: string; parameters: { num_ctx: number }; stream: boolean }> = [];
  const asked: string[] = [];
  const server = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/api/version") return reply({ version: "0.40.13" });
    if (path === "/api/show" && options.gone?.includes((JSON.parse(String(init?.body)) as { model: string }).model)) return reply({ error: "not found" }, 404);
    if (path === "/api/show") return reply(options.show ?? { model_info: { "qwen3.context_length": 262_144 }, parameters: "temperature 1" });
    if (path === "/api/ps") return reply({ models: options.running ?? [] });
    if (path === "/api/tags") return reply({ models: options.tags ?? [{ name: "qwen3.5:4b", size: options.size ?? 3 * GB }] });
    if (path === "/api/create") {
      created.push(JSON.parse(String(init?.body)));
      return reply({ status: "success" }, options.createStatus ?? 200);
    }
    return reply({}, 404);
  }) as typeof fetch;
  return { server, created, asked };
}

describe("windowFor", () => {
  it.each([
    ["16 GB laptop, small model", 3, 16, undefined, 65_536],
    ["16 GB laptop, 12 GB model", 12, 16, undefined, 16_384],
    ["24 GB laptop, 2B model", 2.7, 24, undefined, 65_536],
    ["32 GB laptop, 22 GB model", 22, 32, undefined, 32_768],
    ["128 GB workstation", 40, 128, undefined, 65_536],
    ["a model trained on less", 3, 64, 8_192, 8_192],
    ["an unknown size stays small", undefined, 64, undefined, 16_384],
  ])("%s", (_label, model, memory, trained, expected) => {
    expect(windowFor(model === undefined ? undefined : model * GB, trained, memory * GB)).toBe(expected);
  });
});

describe("showFacts", () => {
  it("reads a Modelfile's window and the trained one", () => {
    expect(showFacts({ parameters: "stop \"a\"\nnum_ctx 8192\ntemperature 1", model_info: { "gemma4.context_length": 256_000 } })).toEqual({ pinned: 8192, trained: 256_000, remote: false });
  });

  it("sees a model that runs elsewhere", () => {
    expect(showFacts({ remote_host: "https://ollama.com", remote_model: "x" }).remote).toBe(true);
  });

  it("survives a body with nothing in it", () => {
    expect(showFacts(null)).toEqual({ remote: false });
  });
});

describe("serveWithWindow", () => {
  it("creates one name that carries the window, from the same weights, and remembers it", async () => {
    const lab = ollama();
    const served = await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB);
    expect(served).toEqual({ model: "qwen3.5:4b-omb-64k", window: 65_536 });
    expect(lab.created).toEqual([{ model: "qwen3.5:4b-omb-64k", from: "qwen3.5:4b", parameters: { num_ctx: 65_536 }, stream: false }]);
    await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB);
    expect(lab.created).toHaveLength(1);
    expect(servedModel(ORIGIN, "qwen3.5:4b")?.model).toBe("qwen3.5:4b-omb-64k");
  });

  describe("once our name exists", () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const aMinuteLater = () => { const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 61_000); };

    it("makes it again if someone removed it", async () => {
      const gone: string[] = [];
      const lab = ollama({ gone });
      await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB);
      gone.push("qwen3.5:4b-omb-64k");
      aMinuteLater();
      expect((await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB)).model).toBe("qwen3.5:4b-omb-64k");
      expect(lab.created).toHaveLength(2);
    });

    it("keeps it through a server that is only busy", async () => {
      const lab = ollama();
      await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB);
      aMinuteLater();
      const dead = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
      expect((await serveWithWindow(ORIGIN, "qwen3.5:4b", dead, 24 * GB)).model).toBe("qwen3.5:4b-omb-64k");
      expect(lab.created).toHaveLength(1);
    });

    it("does not ask again within the minute", async () => {
      const lab = ollama();
      await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB);
      const asked = lab.asked.length;
      await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB);
      expect(lab.asked).toHaveLength(asked);
    });
  });

  it("names a model with no tag", async () => {
    expect((await serveWithWindow(ORIGIN, "mymodel", ollama().server, 24 * GB)).model).toBe("mymodel:latest-omb-16k");
  });

  it("shares one decision between turns that start together", async () => {
    const lab = ollama();
    await Promise.all([serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server), serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server)]);
    expect(lab.created).toHaveLength(1);
  });

  it("leaves a window the person set in a Modelfile alone", async () => {
    const lab = ollama({ show: { parameters: "num_ctx 200000" } });
    expect(await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server)).toEqual({ model: "qwen3.5:4b", window: 200_000 });
    expect(lab.created).toEqual([]);
  });

  it("leaves a model already running with enough alone", async () => {
    const lab = ollama({ running: [{ name: "qwen3.5:4b", context_length: 262_144 }] });
    expect(await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 64 * GB)).toEqual({ model: "qwen3.5:4b", window: 262_144 });
    expect(lab.created).toEqual([]);
  });

  it("replaces a model running on the small default", async () => {
    const lab = ollama({ running: [{ name: "qwen3.5:4b", context_length: 4_096 }] });
    expect((await serveWithWindow(ORIGIN, "qwen3.5:4b", lab.server, 24 * GB)).window).toBe(65_536);
    expect(lab.created).toHaveLength(1);
  });

  it("leaves a cloud model alone", async () => {
    const lab = ollama({ show: { remote_host: "https://ollama.com" } });
    expect(await serveWithWindow(ORIGIN, "glm-5:cloud", lab.server)).toEqual({ model: "glm-5:cloud" });
    expect(lab.created).toEqual([]);
  });

  it.each(["deepseek-v4.1-flash:1017-cloud", "gemma4:cloud"])("leaves %s alone when /api/show omits remote_host", async (model) => {
    const lab = ollama({
      show: { model_info: { "deepseek_v41.context_length": 1_048_576 }, capabilities: ["completion"] },
      tags: [{ name: model, size: 336 }],
    });
    expect(await serveWithWindow(ORIGIN, model, lab.server, 64 * GB)).toEqual({ model });
    expect(lab.created).toEqual([]);
  });

  it("leaves a model alone when only its tags row says it is remote", async () => {
    const lab = ollama({
      show: { model_info: { "glm.context_length": 202_752 } },
      tags: [{ name: "glm-5.1:latest", size: 400, remote_host: "https://ollama.com:443", remote_model: "glm-5.1" }],
    });
    expect(await serveWithWindow(ORIGIN, "glm-5.1", lab.server, 64 * GB)).toEqual({ model: "glm-5.1" });
    expect(lab.created).toEqual([]);
  });

  it.each([
    ["a refused create", ollama({ createStatus: 500 }).server],
    ["a dead server", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch],
  ])("falls back to the model as it was on %s", async (_label, server) => {
    expect(await serveWithWindow(ORIGIN, "qwen3.5:4b", server)).toEqual({ model: "qwen3.5:4b" });
  });

  it("never wraps a name that already carries a window", async () => {
    const lab = ollama();
    expect(await serveWithWindow(ORIGIN, "qwen3.5:4b-omb-64k", lab.server)).toEqual({ model: "qwen3.5:4b-omb-64k" });
    expect(lab.asked).toEqual([]);
  });
});

describe("names", () => {
  it.each([
    ["gemma4:cloud", true],
    ["deepseek-v4.1-flash:1017-cloud", true],
    ["qwen3.5:4b", false],
    ["cloudy:latest", false],
    ["my-cloud", false],
  ])("isCloudName(%s) is %s", (model, expected) => {
    expect(isCloudName(model)).toBe(expected);
  });

  it("goes back to the name a person picked", () => {
    expect(pickedName("qwen3.5:4b-omb-64k")).toBe("qwen3.5:4b");
    expect(pickedName("mymodel:latest-omb-16k")).toBe("mymodel:latest");
    expect(pickedName("llama3.2:latest")).toBe("llama3.2:latest");
    expect(isContextName("qwen3.5:4b")).toBe(false);
  });
});

describe("isOllama", () => {
  it("is true only for a server that answers with a version", async () => {
    expect(await isOllama("http://a", ollama().server)).toBe(true);
    expect(await isOllama("http://b", (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch)).toBe(false);
    expect(await isOllama("http://c", (async () => new Response('{"ok":true}')) as unknown as typeof fetch)).toBe(false);
  });
});

describe("every engine picks up the name", () => {
  const pick = encodeInjectId("ollama", "qwen3.5:4b");
  const origin = localHost("ollama")!.baseUrl.replace(/\/v1$/, "");

  it("decodes to the picked name until a turn has decided, then to the one with the window", async () => {
    expect(decodeInjectId(pick)).toEqual({ host: "ollama", model: "qwen3.5:4b" });
    expect(injectedContextWindow(pick)).toBeUndefined();
    await serveWithWindow(origin, "qwen3.5:4b", ollama().server, 24 * GB);
    expect(decodeInjectId(pick)).toEqual({ host: "ollama", model: "qwen3.5:4b-omb-64k" });
    expect(injectedContextWindow(pick)).toBe(65_536);
  });

  it("tells Claude Code the window it really has", async () => {
    await serveWithWindow(origin, "qwen3.5:4b", ollama().server, 24 * GB);
    const env: Record<string, string | undefined> = {};
    expect(applyClaudeInject(env, pick)).toEqual({ model: "qwen3.5:4b-omb-64k", injected: true });
    expect(env).toMatchObject({ ANTHROPIC_MODEL: "qwen3.5:4b-omb-64k", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "65536" });
  });

  it("does not touch another host's pick", async () => {
    const lmstudio = encodeInjectId("lmstudio", "qwen3.5:4b");
    await serveWithWindow(origin, "qwen3.5:4b", ollama().server, 24 * GB);
    expect(decodeInjectId(lmstudio)?.model).toBe("qwen3.5:4b");
    expect(injectedContextWindow(lmstudio)).toBeUndefined();
  });

  it("settles the name before a turn starts, and only for an Ollama pick", async () => {
    const sent: string[] = [];
    const instance = { adapter: { sendTurn: async (input: { model?: string }) => { sent.push(decodeInjectId(input.model)?.model ?? String(input.model)); return { turnId: "t" }; } } } as unknown as ProviderInstance;
    const realFetch = globalThis.fetch;
    const lab = ollama();
    globalThis.fetch = lab.server;
    try {
      const wrapped = withLocalContext(instance);
      await wrapped.adapter.sendTurn({ threadId: "t", text: "hi", model: "claude-opus" });
      expect(lab.asked).toEqual([]);
      await wrapped.adapter.sendTurn({ threadId: "t", text: "hi", model: pick });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent).toEqual(["claude-opus", expect.stringMatching(/^qwen3\.5:4b-omb-\d+k$/)]);
  });
});

describe("the chat engine on a server someone added by URL", () => {
  async function server(routes: "ollama" | "other") {
    const sent: string[] = [];
    const created: string[] = [];
    const http = createServer(async (request, response) => {
      let data = "";
      for await (const part of request) data += part.toString();
      const path = request.url ?? "";
      const json = (body: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
      if (path === "/v1/models") return json({ data: [{ id: "qwen3.5:4b" }, { id: "qwen3.5:4b-omb-64k" }] });
      if (path === "/v1/chat/completions") {
        sent.push((JSON.parse(data) as { model: string }).model);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\n`);
        return response.end("data: [DONE]\n\n");
      }
      // Some other servers answer part of Ollama's API, but never its version.
      if (path === "/api/version" && routes === "ollama") return json({ version: "0.40.13" });
      if (path === "/api/show") return json({ model_info: { "qwen3.context_length": 262_144 } });
      if (path === "/api/ps") return json({ models: [] });
      if (path === "/api/tags") return json({ models: [{ name: "qwen3.5:4b", size: 3 * GB }] });
      if (path === "/api/create") { created.push((JSON.parse(data) as { model: string }).model); return json({ status: "success" }); }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const instance = await OpenAICompatDriver.create({
      instanceId: randomUUID(), displayName: "Fixture", enabled: true,
      config: { url: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "FIXTURE_KEY" }, environment: { FIXTURE_KEY: "k" },
    });
    await instance.refreshModels?.();
    const recorder = recordEvents(instance.adapter);
    const stop = async () => {
      recorder.stop();
      await instance.dispose();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    };
    const turn = async () => {
      await instance.adapter.sendTurn({ threadId: randomUUID(), text: "hi", model: "qwen3.5:4b" });
      await recorder.until((event) => event.type === "turn.completed");
    };
    return { instance, sent, created, stop, turn };
  }

  it("sends the name that carries the window, keeps it out of the picker, and knows the window", async () => {
    const f = await server("ollama");
    try {
      expect(f.instance.models.options.map((option) => option.id)).toEqual(["qwen3.5:4b"]);
      await f.turn();
      expect(f.created).toHaveLength(1);
      expect(f.sent).toEqual(f.created);
      expect(f.sent[0]).toMatch(/^qwen3\.5:4b-omb-\d+k$/);
      expect(f.instance.models.options.find((option) => option.id === "qwen3.5:4b")?.contextWindow).toBeGreaterThanOrEqual(16_384);
    } finally { await f.stop(); }
  });

  it("never asks a server that only imitates Ollama to create anything", async () => {
    const f = await server("other");
    try {
      await f.turn();
      expect(f.sent).toEqual(["qwen3.5:4b"]);
      expect(f.created).toEqual([]);
    } finally { await f.stop(); }
  });
});

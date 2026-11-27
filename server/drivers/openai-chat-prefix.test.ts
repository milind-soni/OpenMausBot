// A conversation's requests must only ever grow at the end: llama.cpp and every provider's prompt cache reuse the longest
// unchanged start, and a hybrid model (Qwen3.6, Granite 4) reuses nothing once anything before the end changes.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

interface ChatRequest { messages: Array<{ role?: string }>; tools?: unknown[]; chat_template_kwargs?: unknown }
type Transcript = NonNullable<SendTurnInput["transcript"]>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function sse(response: ServerResponse, delta: unknown, finish: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

const EMPTY = { type: "object", properties: {}, additionalProperties: false };

async function mcp(name: string, toolsDelayMs = 0): Promise<FakeHttpMcp> {
  const server = await startFakeHttpMcp({ tools: [{ name: "get", description: `Reads ${name}`, inputSchema: EMPTY }], toolsDelayMs });
  cleanups.push(() => server.close());
  return server;
}

const STDIO_MCP = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agents", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: [{ name: "get", description: "Reads agents", inputSchema: ${JSON.stringify(EMPTY)} }] });
  else if (request.method === "tools/call") reply(request.id, { content: [{ type: "text", text: "agents ok" }] });
  else if (request.id !== undefined) reply(request.id, {});
});
`;

/** OpenMausBot's own agents server runs as a local process. */
function agentsServer() {
  const directory = mkdtempSync(join(tmpdir(), "omb-prefix-"));
  cleanups.push(() => removeTempDir(directory));
  const script = join(directory, "agents.mjs");
  writeFileSync(script, STDIO_MCP);
  return { command: process.execPath, args: [script], env: {} };
}

/** Each turn calls `call` once, then answers; the reply is delayed so a server still starting has listed by round two. */
async function conversation(call: string, roundDelayMs = 0) {
  const requests: ChatRequest[] = [];
  let answers = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
      return;
    }
    let data = "";
    for await (const part of request) data += part.toString();
    const body = JSON.parse(data) as ChatRequest;
    requests.push({ messages: body.messages, tools: body.tools, chat_template_kwargs: body.chat_template_kwargs });
    const reply = () => body.messages.at(-1)?.role === "tool"
      ? sse(response, { content: `Answer ${++answers}` }, "stop")
      : sse(response, { reasoning_content: "Looking it up first.", tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: "function", function: { name: call, arguments: "{}" } }] }, "tool_calls");
    setTimeout(reply, body.messages.at(-1)?.role === "tool" ? 0 : roundDelayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const instance: ProviderInstance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: "Prefix fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" },
    environment: { FIXTURE_CHAT_KEY: "fixture-credential-5b0f3c" },
  });
  const recorder = recordEvents(instance.adapter);
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const threadId = randomUUID();
  const transcript: Transcript = [];
  return {
    requests,
    /** One turn as the app sends it: the stored conversation so far, the stable instructions and this turn's changing ones. */
    async turn(text: string, integrations: SendTurnInput["integrations"], model = "fixture-model") {
      const replies: string[] = [];
      const done = recorder.events.length;
      await instance.adapter.sendTurn({
        threadId, botId: "prefix-bot", text, model, approvalMode: "full", integrations,
        transcript: [...transcript], system: "Stable instructions\n\nNow: " + text, systemStable: "Stable instructions", systemVolatile: "Now: " + text,
      });
      const completed = await recorder.until((event) => event.type === "turn.completed" && recorder.events.indexOf(event) >= done);
      expect(completed).toMatchObject({ ok: true });
      for (const event of recorder.events.slice(done)) {
        if (event.type === "item.completed" && event.itemType === "assistant_text") replies.push(event.text!);
      }
      // The app stores a summary of the turn's work after its replies.
      transcript.push({ role: "user", text }, ...replies.map((reply) => ({ role: "assistant" as const, text: `${reply} ` })),
        { role: "assistant", text: `[What the bot did in an earlier turn: tools ×1 · reply: ${replies.at(-1)}]` });
    },
  };
}

/** Where `next` stops repeating `previous`, or null when it starts with all of it. */
function divergence(previous: ChatRequest, next: ChatRequest): string | null {
  if (JSON.stringify(previous.tools ?? []) !== JSON.stringify(next.tools ?? [])) return "tool list changed";
  for (const [index, message] of previous.messages.entries()) {
    if (JSON.stringify(message) !== JSON.stringify(next.messages[index])) return `message ${index} of ${previous.messages.length} changed`;
  }
  return null;
}

const changes = (requests: readonly ChatRequest[]) =>
  requests.slice(1).flatMap((next, index) => {
    const where = divergence(requests[index]!, next);
    return where ? [`request ${index + 2}: ${where}`] : [];
  });

/** llama.cpp b12532's refusal of a prompt past its context per slot. */
const LLAMA_CPP_TOO_LONG = '{"error":{"code":400,"message":"request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":5000,"n_ctx":4096}}';

describe("a conversation's requests to an OpenAI-compatible model", () => {
  it("reports the window a local server refused a request with, so compaction folds before the next refusal", async () => {
    let requests = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
      for await (const _ of request) { /* drain */ }
      if (++requests === 1) { response.writeHead(400, { "content-type": "application/json" }); response.end(LLAMA_CPP_TOO_LONG); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3000, completion_tokens: 2 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const instance = await OpenAICompatDriver.create({
      instanceId: randomUUID(), displayName: "Window fixture", enabled: true,
      config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_CHAT_KEY" }, environment: { FIXTURE_CHAT_KEY: "fixture-credential-5b0f3c" },
    });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(async () => {
      recorder.stop();
      await instance.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await instance.adapter.sendTurn({ threadId: randomUUID(), text: "Next", model: "fixture-model", system: "Rules",
      transcript: Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: `earlier ${index} ${"words ".repeat(400)}` })) });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(requests).toBe(2);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "thread.token-usage.updated", contextTokens: 3002, contextWindow: 4096 }));
  });

  it("only grow at the end across turns that call tools, while the changing instructions move on", async () => {
    const lookup = await mcp("lookup");
    const chat = await conversation("lookup_get");
    const integrations = { custom: { lookup: { type: "http" as const, url: lookup.url, headers: {} } } };
    for (const text of ["First question", "Second question", "Third question"]) await chat.turn(text, integrations);
    expect(chat.requests).toHaveLength(6);
    expect(changes(chat.requests)).toEqual([]);
    // A local server is asked to keep earlier thinking in the prompt (Qwen3.6's template drops it otherwise).
    expect(chat.requests.map((request) => request.chat_template_kwargs)).toEqual(Array(6).fill({ preserve_thinking: true }));
  });

  it("give another model the earlier turns' replies as text, never the first model's reasoning", async () => {
    const lookup = await mcp("lookup");
    const chat = await conversation("lookup_get");
    const integrations = { custom: { lookup: { type: "http" as const, url: lookup.url, headers: {} } } };
    await chat.turn("First question", integrations);
    await chat.turn("Second question", integrations);
    expect(JSON.stringify(chat.requests[2]!.messages)).toContain("Looking it up first.");
    await chat.turn("Third question", integrations, "other-model");
    const switched = chat.requests[4]!.messages;
    expect(JSON.stringify(switched)).not.toContain("Looking it up first.");
    expect(switched.filter((message) => message.role === "tool")).toHaveLength(0);
    expect(switched.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Third question") });
  });

  it("keep one tool list from the first request on a local server, waiting for a slow server to start", async () => {
    const slow = await mcp("slow", 300);
    const chat = await conversation("agents_get", 600);
    const integrations = {
      agents: agentsServer(),
      custom: { slow: { type: "http" as const, url: slow.url, headers: {} } },
    } as SendTurnInput["integrations"];
    for (const text of ["First question", "Second question", "Third question"]) await chat.turn(text, integrations);
    expect(chat.requests).toHaveLength(6);
    expect(chat.requests.map((request) => JSON.stringify(request.tools).includes("slow_get"))).toEqual(Array(6).fill(true));
    expect(changes(chat.requests)).toEqual([]);
  });
});

// A real HTTP server speaking the event stream as OpenAI documents it (developers.openai.com/api/docs/guides/streaming-responses,
// .../function-calling, .../reasoning). No model is called. OpenAI's own address is sent to that server by the fetch stub.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { forgetKey, keyRejected } from "../key-rejections.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { toolBudgetOf } from "../tool-budgets.ts";
import { isOpenAIChatModel, OpenAICompatDriver } from "./openai-compat.ts";
import { createModelRoutes, isOpenAIAddress, responsesRequest, routeRefusal } from "./openai-responses.ts";

const OPENAI = "https://api.openai.com/v1";
const MODEL = "gpt-6.1-sol";
const KEY = "fixture-key-5d0a1c";
const refusalOf = (model: string) => JSON.stringify({ error: {
  message: `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`,
  type: "invalid_request_error", param: "reasoning_effort", code: null,
} });
const NONE_REFUSED = JSON.stringify({ error: { message: `Unsupported value: 'none' is not supported with the '${MODEL}' model.`, type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } });
const MISSING_SCOPE = JSON.stringify({ error: { message: "You have insufficient permissions for this operation. Missing scopes: api.responses.write.", type: "invalid_request_error", param: null, code: null } });

type Call = { path: string; body: Record<string, any> };
type Script = (call: Call, response: ServerResponse, nth: number) => void;

const reject = (response: ServerResponse, status: number, body: string) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};
function events(response: ServerResponse, frames: unknown[], end = true) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    const type = (frame as { type: string }).type;
    response.write(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`);
  }
  if (end) response.end();
}

const usage = { input_tokens: 40, input_tokens_details: { cached_tokens: 8 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 52 };
const created = { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [], instructions: "echoed", tools: [] } };
const completed = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "resp_1", status: "completed", output, usage } });
const reasoningItem = (id = "rs_1", encrypted = `sealed-${id}`) => ({ id, type: "reasoning", summary: [{ type: "summary_text", text: "Thinking it over." }], encrypted_content: encrypted, status: "completed" });
const messageItem = (text: string, id = "msg_1", phase = "final_answer") => ({ id, type: "message", role: "assistant", status: "completed", phase, content: [{ type: "output_text", text, annotations: [], logprobs: [] }] });
const callItem = (name = "audit_write", args = '{"name":"receipt","value":"done"}', callId = "call_1", id = "fc_1") => ({ id, type: "function_call", call_id: callId, name, arguments: args, status: "completed" });
const textDelta = (delta: string, itemId = "msg_1") => ({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta, logprobs: [] });
const done = (item: unknown, outputIndex = 0) => ({ type: "response.output_item.done", output_index: outputIndex, item });

function answer(response: ServerResponse, text = "All done.") {
  events(response, [created, textDelta(text), done(messageItem(text)), completed([messageItem(text)])]);
}
function reasonedCall(response: ServerResponse) {
  const reasoning = reasoningItem();
  const call = callItem();
  events(response, [
    created,
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: "sealed-rs_1-partial", status: "in_progress" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Thinking it over." },
    done(reasoning, 0),
    { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: call.arguments },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: call.arguments },
    done(call, 1),
    completed([reasoning, call]),
  ]);
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
const MCP_SCRIPT = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const schema = { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name"] };
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: [{ name: "write", description: "Synthetic fixture operation", inputSchema: schema }] });
  else if (request.method === "tools/call") reply(request.id, { content: request.params.arguments.value === "shot"
    ? [{ type: "text", text: "Captured." }, { type: "image", mimeType: "image/png", data: "${PNG}" }]
    : [{ type: "text", text: "Stored." }] });
  else if (request.id !== undefined && request.method === "ping") reply(request.id, {});
});
`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetKey(KEY);
});

async function fixture(script: Script, apiUrl = OPENAI) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const directory = mkdtempSync(join(tmpdir(), "omb-responses-"));
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
      return;
    }
    let data = "";
    // Only a turn's POST carries a body; the Ollama probe GETs /api/version first (ollama-context.ts).
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const part of request) data += part.toString();
    const call = { path: request.url ?? "", body: JSON.parse(data) as Record<string, any> };
    calls.push(call);
    script(call, response, calls.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const local = `http://127.0.0.1:${address.port}/v1`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => realFetch(String(url).replace(OPENAI, local), init));
  const helper = join(directory, "mcp.mjs");
  writeFileSync(helper, MCP_SCRIPT);
  const instance: ProviderInstance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: "Responses fixture", enabled: true,
    config: { url: apiUrl === OPENAI ? OPENAI : local, apiKeyEnv: "FIXTURE_CHAT_KEY", ...(apiUrl === OPENAI ? { catalog: "openai" } : {}) },
    environment: { FIXTURE_CHAT_KEY: KEY },
  });
  const recorder = recordEvents(instance.adapter);
  const integrations: SendTurnInput["integrations"] = { custom: { audit: { command: process.execPath, args: [helper], env: {} } } };
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(directory);
  });
  const threadId = randomUUID();
  return {
    instance, recorder, calls, threadId, directory,
    paths: () => calls.map((call) => call.path),
    turn: async (input: Partial<SendTurnInput> = {}) => {
      const seen = recorder.events.length;
      await instance.adapter.sendTurn({ threadId, text: "Store the receipt.", model: MODEL, integrations, approvalMode: "full", ...input });
      const end = await vi.waitFor(() => {
        const found = recorder.events.slice(seen).find((event) => event.type === "turn.completed");
        if (!found) throw new Error("turn still running");
        return found;
      }, { timeout: 10_000, interval: 10 });
      return { end, events: recorder.events.slice(seen) };
    },
  };
}

const failureOf = (events: Array<{ type: string; message?: string }>) => events.find((event) => event.type === "runtime.error")?.message ?? "";
const textOf = (events: Array<Record<string, any>>, kind: string) => events.filter((event) => event.type === "content.delta" && event.streamKind === kind).map((event) => event.delta).join("");

describe("which API a model's turn uses", () => {
  it("names OpenAI's own address, and nothing that only resembles it", () => {
    for (const url of [OPENAI, `${OPENAI}/`, "https://eu.api.openai.com/v1"]) expect(isOpenAIAddress(url)).toBe(true);
    for (const url of ["http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://openrouter.ai/api/v1", "https://example.com/api.openai.com/v1", "https://api.openai.com/openai/v1", "not a url"]) {
      expect(isOpenAIAddress(url)).toBe(false);
    }
  });

  it("only moves a model forward, so a resend cannot loop", () => {
    const own = createModelRoutes(OPENAI);
    expect(own.routeFor(MODEL, true)).toBe("chat");
    expect(own.advance(MODEL, "tools-need-responses")).toBe(true);
    expect(own.routeFor(MODEL, true)).toBe("responses");
    expect(own.routeFor(MODEL, false)).toBe("chat");
    expect(own.routeFor("gpt-5-mini", true)).toBe("chat");
    expect(own.advance(MODEL, "tools-need-responses")).toBe(false);
    expect(own.advance(MODEL, "responses-unavailable")).toBe(true);
    expect(own.routeFor(MODEL, true)).toBe("chat-reasoning-off");
    expect(own.advance(MODEL, "tools-need-responses")).toBe(false);
    expect(own.advance(MODEL, "responses-unavailable")).toBe(false);

    const other = createModelRoutes("https://relay.example/v1");
    expect(other.advance(MODEL, "tools-need-responses")).toBe(true);
    expect(other.routeFor(MODEL, true)).toBe("chat-reasoning-off");
    expect(other.advance(MODEL, "tools-need-responses")).toBe(false);
  });

  it("reads the answer, not the model's name", () => {
    expect(routeRefusal("chat", 400, refusalOf("gpt-9-future"))).toBe("tools-need-responses");
    expect(routeRefusal("chat", 400, JSON.stringify({ detail: { upstream: JSON.parse(refusalOf(MODEL)) } }))).toBe("tools-need-responses");
    expect(routeRefusal("chat", 400, JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'." } }))).toBeNull();
    expect(routeRefusal("chat", 400, JSON.stringify({ error: { message: "Tools are not supported." } }))).toBeNull();
    expect(routeRefusal("chat", 500, refusalOf(MODEL))).toBeNull();
    expect(routeRefusal("chat", 400, NONE_REFUSED)).toBeNull();
    expect(routeRefusal("chat-reasoning-off", 400, NONE_REFUSED)).toBe("tools-need-responses");
    expect(routeRefusal("responses", 404, "<html>not found</html>")).toBe("responses-unavailable");
    expect(routeRefusal("responses", 405, "")).toBe("responses-unavailable");
    expect(routeRefusal("responses", 401, MISSING_SCOPE)).toBe("responses-unavailable");
    expect(routeRefusal("responses", 403, MISSING_SCOPE)).toBe("responses-unavailable");
    expect(routeRefusal("responses", 401, JSON.stringify({ error: { message: "Incorrect API key provided.", code: "invalid_api_key" } }))).toBeNull();
    expect(routeRefusal("responses", 404, JSON.stringify({ error: { message: "The model does not exist.", code: "model_not_found" } }))).toBeNull();
    expect(routeRefusal("responses", 429, JSON.stringify({ error: { message: "Rate limit reached." } }))).toBeNull();
  });
});

describe("the Responses request", () => {
  it("carries instructions, images, tool results and flat non-strict tools", () => {
    const body = responsesRequest({
      model: MODEL,
      summaries: true,
      replay: () => undefined,
      tools: [{ type: "function", function: { name: "audit_write", description: "Writes", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: "Looking.", tool_calls: [{ id: "call_9", type: "function", function: { name: "audit_write", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_9", content: '{"ok":true}' },
        { role: "assistant", content: null },
      ],
    });
    expect(body).toEqual({
      model: MODEL, stream: true, store: false, instructions: "Be brief.",
      reasoning: { summary: "auto" },
      tools: [{ type: "function", name: "audit_write", description: "Writes", parameters: { type: "object" }, strict: false }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" }] },
        { role: "assistant", content: "Looking." },
        { type: "function_call", call_id: "call_9", name: "audit_write", arguments: "{}" },
        { type: "function_call_output", call_id: "call_9", output: '{"ok":true}' },
      ],
    });
  });
});

describe("a model that refuses tools over Chat Completions, at OpenAI's address", () => {
  it("moves to Responses in the same turn and stays there", async () => {
    const f = await fixture((call, response) => {
      if (call.path.endsWith("/chat/completions")) reject(response, 400, refusalOf(MODEL));
      else answer(response, "Hello there.");
    });
    const first = await f.turn();
    expect(first.end).toMatchObject({ ok: true });
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/responses"]);
    expect(f.calls[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(textOf(first.events, "assistant_text")).toBe("Hello there.");
    expect(first.events.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({ input: 40, output: 12 });
    expect(first.end).toMatchObject({ usage: { input: 40, output: 12 } });

    expect(await f.turn()).toMatchObject({ end: { ok: true } });
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/responses", "/v1/responses"]);
  });

  it("leaves a model that accepts tools on Chat Completions", async () => {
    const f = await fixture((_call, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Mini reply." }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    expect(await f.turn({ model: "gpt-5-mini" })).toMatchObject({ end: { ok: true } });
    expect(f.paths()).toEqual(["/v1/chat/completions"]);
    expect(f.calls[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps side calls on Chat Completions, even for a model that moved", async () => {
    const f = await fixture((call, response) => {
      if (call.path.endsWith("/responses")) return answer(response);
      if (call.body.tools) return reject(response, 400, refusalOf(MODEL));
      reject(response, 200, JSON.stringify({ model: MODEL, choices: [{ message: { role: "assistant", content: "A short title" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
    await f.turn();
    const onUsage = vi.fn();
    await expect(f.instance.generateText!("Name this chat", { model: MODEL, onUsage })).resolves.toBe("A short title");
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/responses", "/v1/chat/completions"]);
    expect(f.calls[2]!.body).not.toHaveProperty("reasoning_effort");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ input: 3, output: 2 }));
  });
});

describe("tool rounds over Responses", () => {
  it("replays every output item of the round and stores nothing upstream", async () => {
    const f = await fixture((call, response, nth) => {
      if (call.path.endsWith("/chat/completions")) return reject(response, 400, refusalOf(MODEL));
      if (nth === 2) return reasonedCall(response);
      if (nth === 3) {
        const second = reasoningItem("rs_2");
        const preamble = messageItem("Checking once more.", "msg_2", "commentary");
        const call2 = callItem("audit_write", '{"name":"second"}', "call_2", "fc_2");
        return events(response, [done(second, 0), textDelta("Checking once more.", "msg_2"), done(preamble, 1), done(call2, 2), completed([second, preamble, call2])]);
      }
      answer(response, "Both stored.");
    });
    const { end, events: seen } = await f.turn({ system: "Be brief." });
    expect(end).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(4);
    const [, first, second, third] = f.calls;
    for (const call of [first!, second!, third!]) {
      expect(call.body).toMatchObject({ store: false, stream: true, model: MODEL });
      expect(call.body).not.toHaveProperty("previous_response_id");
      expect(call.body).not.toHaveProperty("reasoning_effort");
      expect(call.body).not.toHaveProperty("messages");
    }
    expect(first!.body.input.map((item: any) => item.type ?? item.role)).toEqual(["user"]);
    expect(first!.body.tools[0]).toMatchObject({ type: "function", name: "audit_write", strict: false, parameters: { required: ["name"] } });
    expect(first!.body.tools[0]).not.toHaveProperty("function");

    expect(second!.body.input.slice(1)).toEqual([
      reasoningItem(),
      callItem(),
      { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ ok: true, result: "Stored." }) },
    ]);
    expect(third!.body.input.slice(1, 3)).toEqual([reasoningItem(), callItem()]);
    expect(third!.body.input.slice(4)).toEqual([
      reasoningItem("rs_2"),
      messageItem("Checking once more.", "msg_2", "commentary"),
      callItem("audit_write", '{"name":"second"}', "call_2", "fc_2"),
      { type: "function_call_output", call_id: "call_2", output: JSON.stringify({ ok: true, result: "Stored." }) },
    ]);
    expect(textOf(seen, "reasoning_text")).toBe("Thinking it over.Thinking it over.");
    expect(seen.filter((event) => event.type === "item.completed" && event.itemType === "tool").map((event) => event.ok)).toEqual([true, true]);
    expect(seen.find((event) => event.type === "turn.completed")).toMatchObject({ usage: { input: 120, output: 36 } });
  });

  it("keeps encrypted reasoning out of everything it logs or shows", async () => {
    ensureDirs();
    const f = await fixture((call, response, nth) => {
      if (call.path.endsWith("/chat/completions")) return reject(response, 400, refusalOf(MODEL));
      if (nth === 2) return reasonedCall(response);
      answer(response);
    });
    const { events: seen } = await f.turn();
    expect(JSON.stringify(seen)).not.toContain("sealed-");
    expect(readFileSync(join(NATIVE_DIR, `${f.threadId}.ndjson`), "utf8")).not.toContain("sealed-");
    expect(JSON.stringify(f.calls[2]!.body)).toContain("sealed-rs_1");
    expect(JSON.stringify(f.calls[2]!.body)).not.toContain("partial");
  });

  it("carries the bot's tool budget and pictures the same way", async () => {
    const f = await fixture((call, response) => {
      if (call.path.endsWith("/chat/completions")) return reject(response, 400, refusalOf(MODEL));
      answer(response);
    });
    const png = join(f.directory, "input.png");
    const bytes = Buffer.from(PNG, "base64");
    writeFileSync(png, bytes);
    const botId = `bot-${randomUUID()}`;
    await f.turn({ botId, images: [{ path: png, mime: "image/png", bytes: bytes.length }] });
    expect(toolBudgetOf(botId)).toMatchObject({ limit: 128, listed: 1 });
    expect(f.calls[1]!.body.input[0].content).toEqual([
      { type: "input_text", text: "Store the receipt." },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
    ]);
  });

  it("sends a tool's screenshot after the tool results, as a person's message", async () => {
    const shot = callItem("audit_write", '{"name":"screen","value":"shot"}');
    const f = await fixture((call, response, nth) => {
      if (call.path.endsWith("/chat/completions")) return reject(response, 400, refusalOf(MODEL));
      if (nth === 2) return events(response, [done(shot), completed([shot])]);
      answer(response);
    });
    expect(await f.turn()).toMatchObject({ end: { ok: true } });
    expect(f.calls[2]!.body.input.slice(1)).toEqual([
      shot,
      { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ ok: true, result: "Captured." }) },
      { role: "user", content: [
        { type: "input_text", text: "Screenshot result from tool call call_1:" },
        { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
      ] },
    ]);
  });

  it("keeps the round's reasoning through a smaller resend", async () => {
    const f = await fixture((call, response, nth) => {
      if (call.path.endsWith("/chat/completions")) return reject(response, 400, refusalOf(MODEL));
      if (nth === 2) return reasonedCall(response);
      if (nth === 3) return reject(response, 413, JSON.stringify({ error: { message: "Request too large for gpt-6.1-sol" } }));
      answer(response);
    });
    const { end } = await f.turn({ transcript: [{ role: "user", text: "Earlier question" }, { role: "assistant", text: "Earlier answer" }] });
    expect(end).toMatchObject({ ok: true });
    expect(JSON.stringify(f.calls[3]!.body.input)).not.toContain("Earlier question");
    expect(f.calls[3]!.body.input).toEqual(expect.arrayContaining([reasoningItem(), callItem()]));
  });

  it("is offered in the model picker", () => {
    expect(isOpenAIChatModel(MODEL)).toBe(true);
  });
});

describe("what Responses can answer", () => {
  const onResponses = (answerWith: (response: ServerResponse, nth: number) => void): Script => (call, response, nth) => {
    if (call.path.endsWith("/chat/completions") && !call.body.reasoning_effort) return reject(response, 400, refusalOf(MODEL));
    answerWith(response, nth);
  };

  it("shows a model's refusal as its reply", async () => {
    const f = await fixture(onResponses((response) => {
      const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] };
      events(response, [{ type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "I can't help with that." }, done(item), completed([item])]);
    }));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: true });
    expect(seen.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({ text: "I can't help with that." });
  });

  it("reads a reply that arrived only as finished items", async () => {
    const f = await fixture(onResponses((response) => {
      events(response, [{ type: "response.completed", response: { status: "completed", output: [reasoningItem(), messageItem("Whole reply.")], usage } }]);
    }));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: true });
    expect(textOf(seen, "assistant_text")).toBe("Whole reply.");
    expect(textOf(seen, "reasoning_text")).toBe("Thinking it over.");
  });

  it("separates summary parts and commentary from the answer", async () => {
    const f = await fixture(onResponses((response) => {
      events(response, [
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First." },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second." },
        textDelta("Note.", "msg_1"), textDelta("Answer.", "msg_2"),
        completed(),
      ]);
    }));
    const { events: seen } = await f.turn();
    expect(textOf(seen, "reasoning_text")).toBe("First.\n\nSecond.");
    expect(textOf(seen, "assistant_text")).toBe("Note.\n\nAnswer.");
  });

  it("does not finish a turn on an incomplete response", async () => {
    const f = await fixture(onResponses((response) => {
      events(response, [textDelta("Half"), { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage } }]);
    }));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(failureOf(seen)).toContain("provider did not finish the response (length)");
  });

  it("refuses a tool call cut off by an incomplete response without running it", async () => {
    const f = await fixture(onResponses((response) => {
      events(response, [done(callItem()), { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [callItem()] } }]);
    }));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(failureOf(seen)).toContain("truncated");
    expect(seen.some((event) => event.type === "item.started")).toBe(false);
  });

  it.each([
    ["response.failed", { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The server had an error." } } }, "upstream HTTP 500: The server had an error. (server_error)"],
    ["response.failed rate limit", { type: "response.failed", response: { status: "failed", error: { code: "rate_limit_exceeded", message: "Rate limit reached." } } }, "upstream HTTP 429: Rate limit reached. (rate_limit_exceeded)"],
    ["an error event", { type: "error", code: "invalid_prompt", message: "Invalid prompt.", param: null }, "upstream HTTP 400: Invalid prompt. (invalid_prompt)"],
  ])("reads %s as the failure Chat Completions would report", async (_name, frame, expected) => {
    const f = await fixture(onResponses((response) => events(response, [created, frame])));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(failureOf(seen)).toBe(expected);
  });

  it("marks a really rejected key and does not fall back", async () => {
    const key = JSON.stringify({ error: { message: "Incorrect API key provided.", code: "invalid_api_key" } });
    const f = await fixture(onResponses((response) => reject(response, 401, key)));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/responses"]);
    expect(failureOf(seen)).toContain("Incorrect API key");
    expect(keyRejected(OPENAI, KEY)).toBe(true);
    expect(await f.instance.snapshot()).toMatchObject({ authenticated: false });
  });

  it("resends a smaller copy when the request is too large", async () => {
    const f = await fixture(onResponses((response, nth) => {
      if (nth === 2) return reject(response, 413, JSON.stringify({ error: { message: "Request too large for gpt-6.1-sol" } }));
      answer(response, "Fits now.");
    }));
    const { end, events: seen } = await f.turn({ transcript: [{ role: "user", text: "Earlier question" }, { role: "assistant", text: "Earlier answer" }] });
    expect(end).toMatchObject({ ok: true });
    expect(seen.some((event) => event.type === "turn.retrying" && event.reason === "request_too_large")).toBe(true);
    expect(JSON.stringify(f.calls[2]!.body.input)).not.toContain("Earlier question");
    expect(f.calls[2]!.path).toBe("/v1/responses");
  });

  it("retries a tool call the provider refused", async () => {
    const f = await fixture(onResponses((response, nth) => {
      if (nth === 2) return reject(response, 400, JSON.stringify({ error: { code: "tool_use_failed", message: "attempted to call tool 'json'" } }));
      answer(response);
    }));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: true });
    expect(seen.some((event) => event.type === "turn.retrying" && event.reason === "tool_use_failed")).toBe(true);
  });

  it("drops an optional ask_user when tools are refused", async () => {
    const f = await fixture((call, response) => {
      if (call.path.endsWith("/responses")) return reject(response, 400, JSON.stringify({ error: { message: "Tools are not supported.", param: "tools", code: "unsupported_parameter" } }));
      if (call.body.tools) return reject(response, 400, refusalOf(MODEL));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Plain." }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    const { end } = await f.turn({ integrations: {} });
    expect(end).toMatchObject({ ok: true });
    expect(f.paths().at(-1)).toBe("/v1/chat/completions");
    expect(f.calls.at(-1)!.body).not.toHaveProperty("tools");
  });

  it("asks for summaries once and stops when the organization can't have them", async () => {
    const f = await fixture(onResponses((response, nth) => {
      if (nth === 2) return reject(response, 400, JSON.stringify({ error: { message: "Your organization must be verified to generate reasoning summaries.", param: "reasoning.summary", code: "unsupported_value" } }));
      answer(response);
    }));
    expect(await f.turn()).toMatchObject({ end: { ok: true } });
    await f.turn();
    expect(f.calls[1]!.body.reasoning).toEqual({ summary: "auto" });
    expect(f.calls[2]!.body).not.toHaveProperty("reasoning");
    expect(f.calls[3]!.body).not.toHaveProperty("reasoning");
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/responses", "/v1/responses", "/v1/responses"]);
  });

  it("stops when the stream is cut short", async () => {
    const f = await fixture(onResponses((response) => events(response, [created, textDelta("Part")])));
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(failureOf(seen)).toContain("Stream ended before completion");
  });

  it("reads frames far larger than a chat chunk", async () => {
    const f = await fixture(onResponses((response) => {
      const echoed = { ...created, response: { ...created.response, instructions: "x".repeat(3_000_000) } };
      events(response, [echoed, textDelta("Fine."), completed()]);
    }));
    expect(await f.turn()).toMatchObject({ end: { ok: true } });
  });

  it("stops when the model goes quiet, and when the person stops it", async () => {
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "1000");
    cleanups.push(() => { vi.unstubAllEnvs(); });
    const f = await fixture(onResponses((response) => events(response, [created, textDelta("Part")], false)));
    const quiet = await f.turn();
    expect(quiet.end).toMatchObject({ ok: false });
    expect(failureOf(quiet.events)).toMatch(/idle timeout/i);

    await f.instance.adapter.sendTurn({ threadId: f.threadId, text: "Again", model: MODEL, integrations: {}, approvalMode: "full" });
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(2));
    await f.instance.adapter.interruptTurn(f.threadId);
    expect(f.recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
  });
});

describe("the fallback when Responses is not an option", () => {
  it.each([
    ["a missing route", 404, "<html>Not found</html>"],
    ["a key without the Responses scope", 401, MISSING_SCOPE],
  ])("turns reasoning off once for %s, and remembers", async (_name, status, body) => {
    const f = await fixture((call, response) => {
      if (call.path.endsWith("/responses")) return reject(response, status, body);
      if (call.body.reasoning_effort !== "none") return reject(response, 400, refusalOf(MODEL));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Plain." }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    expect(await f.turn()).toMatchObject({ end: { ok: true } });
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/responses", "/v1/chat/completions"]);
    expect(f.calls[2]!.body).toMatchObject({ reasoning_effort: "none" });
    expect(keyRejected(OPENAI, KEY)).toBe(false);

    expect(await f.turn()).toMatchObject({ end: { ok: true } });
    expect(f.paths()).toHaveLength(4);
    expect(f.calls[3]!.path).toBe("/v1/chat/completions");
    expect(f.calls[3]!.body).toMatchObject({ reasoning_effort: "none" });
  });

  it("ends in a plain sentence when the model refuses that too, without looping", async () => {
    const f = await fixture((call, response) => {
      if (call.path.endsWith("/responses")) return reject(response, 404, "");
      reject(response, 400, call.body.reasoning_effort === "none" ? NONE_REFUSED : refusalOf(MODEL));
    });
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(3);
    expect(failureOf(seen)).toContain("Choose another model");

    await f.turn();
    expect(f.calls).toHaveLength(4);
  });

  it("does not turn reasoning off for a side call when the fallback is active", async () => {
    const f = await fixture((call, response) => {
      if (call.body.tools) return reject(response, 400, call.body.reasoning_effort === "none" ? NONE_REFUSED : refusalOf(MODEL));
      reject(response, 200, JSON.stringify({ model: MODEL, choices: [{ message: { role: "assistant", content: "Title" }, finish_reason: "stop" }] }));
    }, "relay");
    await f.turn();
    await expect(f.instance.generateText!("Name this", { model: MODEL })).resolves.toBe("Title");
    expect(f.calls.at(-1)!.body).not.toHaveProperty("reasoning_effort");
  });
});

describe("the same refusal from another provider", () => {
  it("stays on Chat Completions with reasoning off, and remembers per model", async () => {
    const f = await fixture((call, response) => {
      if (call.body.reasoning_effort !== "none") return reject(response, 400, refusalOf(MODEL));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Relayed." }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, "relay");
    expect(await f.turn()).toMatchObject({ end: { ok: true } });
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(f.calls[1]!.body).toMatchObject({ reasoning_effort: "none", tools: expect.any(Array), messages: expect.any(Array) });

    await f.turn();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.body).toMatchObject({ reasoning_effort: "none" });

    await f.turn({ model: "other-model" });
    expect(f.calls[3]!.body).not.toHaveProperty("reasoning_effort");
    expect(f.calls[4]!.body).toMatchObject({ reasoning_effort: "none" });
  });

  it("tries once, and never sends anything to /responses", async () => {
    const f = await fixture((_call, response) => reject(response, 400, refusalOf(MODEL)), "relay");
    const { end, events: seen } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(f.paths()).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(failureOf(seen)).toContain("Choose another model");
  });
});

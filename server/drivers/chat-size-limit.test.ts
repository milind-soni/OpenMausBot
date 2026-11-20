import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { requestTooLargeMessage } from "../../shared/request-too-large.ts";
import { IMAGE_OMITTED, refusesRequestSize, shareThatFits, smallerResend, TOOL_OUTPUT_OMITTED, TOOL_OUTPUT_SHORTENED } from "./chat-size-limit.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const NGINX_413 = "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
const CONTEXT_CODE = '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 262142 tokens. Your messages resulted in 555619 tokens."}}';
const CONTEXT_TYPE = '{"error":{"type":"context_length_exceeded","message":"prompt is too long: 300000 tokens > 262144 maximum"}}';
const LLAMA_CPP = '{"error":{"code":400,"message":"request (98312 tokens) exceeds the available context size (98304 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":98312,"n_ctx":98304}}';
const SIZE_REFUSALS = [
  { name: "HTTP 413", status: 413, body: NGINX_413 },
  { name: "HTTP 400 error.code", status: 400, body: CONTEXT_CODE },
  { name: "HTTP 400 error.type", status: 400, body: CONTEXT_TYPE },
];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
const image = (bytes: number) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${"A".repeat(bytes)}` } });
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("refusesRequestSize", () => {
  it.each([
    [413, ""],
    [413, NGINX_413],
    [400, '{"error":{"message":"request entity too large","type":"entity.too.large"}}'],
    [400, '{"error":{"message":"Payload Too Large"}}'],
    [429, '{"error":{"message":"Request too large for gpt-4o in organization org-fixture on tokens per min (TPM): Limit 30000, Requested 45000."}}'],
    [400, CONTEXT_CODE],
    [400, CONTEXT_TYPE],
    [400, LLAMA_CPP],
  ])("reads HTTP %i %j as a size refusal", (status, body) => {
    expect(refusesRequestSize(status, body)).toBe(true);
  });

  it.each([
    [400, '{"error":{"message":"invalid model"}}'],
    [400, '{"error":{"code":"invalid_api_key","message":"Invalid API key provided"}}'],
    [400, "context_length_exceeded"],
    [400, '{"error":{"code":"invalid_request_error","message":"context_length_exceeded"}}'],
    [400, '{"code":"context_length_exceeded"}'],
    [400, '{"error":[{"code":"context_length_exceeded"}]}'],
    [400, '{"error":{"code":"context_length_exceeded_extra"}}'],
    [400, '{"error":{"type":"context_length_exceeded_extra"}}'],
    [400, '{"error":{"message":"exceed_context_size_error"}}'],
    [500, LLAMA_CPP],
    [400, "null"],
    [400, "[]"],
    [400, '{"error":'],
    [200, CONTEXT_CODE],
    [401, CONTEXT_CODE],
    [429, CONTEXT_CODE],
    [500, CONTEXT_CODE],
    [412, "Precondition Failed"],
    [429, '{"error":{"message":"Rate limit reached for requests"}}'],
    [500, "Internal Server Error"],
    [502, NGINX_413.replaceAll("413 Request Entity Too Large", "502 Bad Gateway")],
  ])("leaves HTTP %i %j alone", (status, body) => {
    expect(refusesRequestSize(status, body)).toBe(false);
  });
});

describe("shareThatFits", () => {
  it("keeps what fits the window llama.cpp counted, with room left for the reply", () => {
    expect(shareThatFits(LLAMA_CPP)).toBeCloseTo(0.8, 3);
    expect(shareThatFits('{"error":{"type":"exceed_context_size_error","n_prompt_tokens":400,"n_ctx":100}}')).toBeCloseTo(0.2);
    expect(shareThatFits('{"error":{"type":"exceed_context_size_error","n_prompt_tokens":100,"n_ctx":100}}')).toBeCloseTo(0.8);
  });

  it.each([
    CONTEXT_CODE, CONTEXT_TYPE, NGINX_413, "",
    '{"error":{"type":"exceed_context_size_error","n_prompt_tokens":99,"n_ctx":100}}',
    '{"error":{"type":"exceed_context_size_error","n_prompt_tokens":"98312","n_ctx":"98304"}}',
    '{"error":{"type":"exceed_context_size_error","n_prompt_tokens":98312,"n_ctx":0}}',
    '{"n_prompt_tokens":98312,"n_ctx":98304}',
  ])("says nothing about %j", (body) => {
    expect(shareThatFits(body)).toBeUndefined();
  });
});

describe("smallerResend", () => {
  const history = (count: number, bytes: number): OpenAIChatMessage[] => Array.from({ length: count }, (_, index) =>
    ({ role: index % 2 ? "assistant" : "user", content: `history ${index} ${"h".repeat(bytes)}` }));
  const turn = (earlier: OpenAIChatMessage[], after: OpenAIChatMessage[] = []) => {
    const system: OpenAIChatMessage = { role: "system", content: `system ${"s".repeat(2_000)}` };
    const request: OpenAIChatMessage = { role: "user", content: [{ type: "text", text: "Compare the attached screenshot." }, image(40_000)] };
    const messages = [system, ...earlier, request, ...after];
    return { system, request, messages, refused: bytesOf(messages) + 3_000 };
  };
  const toolRound = (id: string, output: number, screenshot: number): OpenAIChatMessage[] => [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "computer_screenshot", arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, content: JSON.stringify({ ok: true, result: `output ${id} ${"o".repeat(output)}` }) },
    { role: "user", content: [{ type: "text", text: `Screenshot result from tool call ${id}:` }, image(screenshot)] },
  ];

  it("strips this turn's older screenshots first and never touches the system prompt or the request's attachment", () => {
    const { system, request, messages, refused } = turn(history(4, 500), [...toolRound("first", 100, 100_000), ...toolRound("second", 100, 20_000)]);
    const resend = smallerResend(messages, request, refused)!;
    expect(resend.messages[0]).toBe(system);
    expect(resend.messages).toContain(request);
    expect(request.content).toEqual([{ type: "text", text: "Compare the attached screenshot." }, image(40_000)]);
    expect(resend.messages.slice(1, 5)).toEqual(messages.slice(1, 5));
    const screenshots = resend.messages.filter((message) => Array.isArray(message.content) && message !== request);
    expect(screenshots[0]!.content).toEqual([{ type: "text", text: "Screenshot result from tool call first:" }, { type: "text", text: IMAGE_OMITTED }]);
    expect(screenshots[1]).toBe(messages.at(-1));
    expect(resend.before).toMatchObject({ bytes: refused, messages: 12, images: 3 });
    expect(resend.after).toMatchObject({ messages: 12, images: 2 });
    expect(resend.after.bytes).toBeLessThanOrEqual(refused / 2);
  });

  it("drops the oldest earlier messages when the images are not enough, keeping the newest and every tool pairing", () => {
    const { request, messages, refused } = turn(history(10, 4_000), toolRound("only", 20_000, 1_000));
    const resend = smallerResend(messages, request, refused)!;
    const requestAt = resend.messages.indexOf(request);
    const earlier = resend.messages.slice(1, requestAt);
    const dropped = 10 - (earlier.length - 1);
    expect(earlier[0]).toEqual({ role: "assistant", content: `[${dropped} earlier messages omitted to fit the provider's size limit; full history remains in the app.]` });
    expect(earlier.slice(1)).toEqual(messages.slice(1 + dropped, 11));
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThan(10);
    expect(resend.messages.slice(requestAt + 1).map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
    const tool = JSON.parse(String(resend.messages[requestAt + 2]!.content)) as { ok: boolean; result: string };
    expect(tool.ok).toBe(true);
    expect(tool.result.startsWith("output only ")).toBe(true);
    expect(tool.result.endsWith(TOOL_OUTPUT_SHORTENED)).toBe(true);
    expect(resend.after.bytes).toBeLessThanOrEqual(refused / 2);
  });

  it("drops only as much as the provider's own count asks for", () => {
    const { request, messages, refused } = turn(history(10, 4_000));
    const halved = smallerResend(messages, request, refused)!;
    const counted = smallerResend(messages, request, refused, 0.8)!;
    expect(counted.after.bytes).toBeLessThanOrEqual(refused * 0.8);
    expect(counted.after.bytes).toBeGreaterThan(halved.after.bytes);
    expect(counted.after.messages).toBeGreaterThan(halved.after.messages);
  });

  it("counts what an earlier omission note stood for when a second copy drops more", () => {
    const { request, messages, refused } = turn(history(10, 4_000));
    const first = smallerResend(messages, request, refused, 0.8)!;
    const second = smallerResend(first.messages, request, first.after.bytes, 0.6)!;
    const notes = second.messages.filter((message) => typeof message.content === "string" && message.content.includes("omitted to fit"));
    const earlier = second.messages.indexOf(request) - 2;
    expect(notes).toEqual([{ role: "assistant", content: `[${10 - earlier} earlier messages omitted to fit the provider's size limit; full history remains in the app.]` }]);
    expect(second.messages[1]).toBe(notes[0]);
    expect(10 - earlier).toBeGreaterThan(10 - (first.messages.indexOf(request) - 2));
  });

  it("omits this turn's oldest tool output last, keeping every call's pairing and the newest round whole", () => {
    const rounds = Array.from({ length: 6 }, (_, index): OpenAIChatMessage[] => [
      { role: "assistant", content: null, tool_calls: [{ id: `read-${index}`, type: "function", function: { name: "read_page", arguments: `{"page":${index}}` } }] },
      { role: "tool", tool_call_id: `read-${index}`, content: JSON.stringify({ ok: true, result: `page ${index} ${"p".repeat(3_000)}` }) },
    ]).flat();
    const { request, messages, refused } = turn(history(2, 500), rounds);
    const plain = { ...request, content: "Read the six pages." };
    const sent = messages.map((message) => message === request ? plain : message);
    const resend = smallerResend(sent, plain, refused - 40_000, 0.6)!;
    expect(resend.after.bytes).toBeLessThanOrEqual((refused - 40_000) * 0.6);
    expect(resend.messages.indexOf(plain)).toBe(2);
    const outputs = resend.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)) as { ok: boolean; result: string });
    const omitted = outputs.findIndex((output) => output.result !== TOOL_OUTPUT_OMITTED);
    expect(omitted).toBeGreaterThan(0);
    expect(outputs.slice(0, omitted).every((output) => output.ok && output.result === TOOL_OUTPUT_OMITTED)).toBe(true);
    expect(outputs.slice(omitted).map((output) => output.result.slice(0, 6))).toEqual(Array.from({ length: 6 - omitted }, (_, index) => `page ${omitted + index}`));
    expect(resend.messages.slice(3).map((message) => message.role)).toEqual(Array.from({ length: 6 }, () => ["assistant", "tool"]).flat());
    expect(resend.messages.slice(3).filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(Array.from({ length: 6 }, (_, index) => `read-${index}`));
    expect(smallerResend(resend.messages, plain, resend.after.bytes, 0.01)!.messages.at(-1)).toBe(resend.messages.at(-1));
  });

  it("offers nothing to resend when only an omission note stands before the request", () => {
    const { request, messages, refused } = turn(history(4, 4_000));
    const first = smallerResend(messages, request, refused, 0.01)!;
    expect(first.messages).toHaveLength(3);
    expect(smallerResend(first.messages, request, first.after.bytes, 0.01)).toBeNull();
  });

  it("offers nothing to resend when only the system prompt and the request are left", () => {
    const { request, messages, refused } = turn([]);
    expect(smallerResend(messages, request, refused)).toBeNull();
  });
});

describe("an OpenAI-compatible provider that refuses large requests", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  async function provider(refuse: (bytes: number, messages: Array<{ role: string; content: unknown }>) => { status: number; body: string } | null) {
    const requests: Array<{ bytes: number; messages: Array<{ role: string; content: unknown }> }> = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "fixture/flash", name: "Fixture Flash" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      // Only a turn's POST carries a body; the Ollama probe GETs /api/version first (ollama-context.ts).
      if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      const { messages } = JSON.parse(raw.toString("utf8")) as { messages: Array<{ role: string; content: unknown }> };
      requests.push({ bytes: raw.length, messages });
      const refusal = refuse(raw.length, messages);
      if (refusal) {
        res.writeHead(refusal.status, { "content-type": refusal.status === 200 ? "text/event-stream" : "text/html" });
        res.end(refusal.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const instance = await OpenAICompatDriver.create({
      instanceId: "size-limit", displayName: "Size limit fixture", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_KEY", model: "fixture/flash" }),
      environment: { FIXTURE_KEY: "synthetic-fixture-key" },
    });
    await instance.refreshModels?.();
    const recorder = recordEvents(instance.adapter);
    const directory = mkdtempSync(join(tmpdir(), "omb-size-limit-"));
    cleanups.push(async () => {
      recorder.stop();
      await instance.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeTempDir(directory);
    });
    const attachment = join(directory, "attached.png");
    writeFileSync(attachment, Buffer.from(PNG, "base64"));
    return {
      requests, recorder,
      run: async (input: Partial<SendTurnInput>) => {
        await instance.adapter.sendTurn({
          threadId: "size-limit", text: "Summarize our conversation.",
          images: [{ path: attachment, mime: "image/png", bytes: Buffer.from(PNG, "base64").length }], ...input,
        });
        return recorder.until((event) => event.type === "turn.completed");
      },
      errors: () => recorder.events.flatMap((event) => event.type === "runtime.error" ? [event.message] : []),
      retries: () => recorder.events.filter((event) => event.type === "turn.retrying"),
    };
  }

  const transcript = (count: number, bytes: number) => Array.from({ length: count }, (_, index) =>
    ({ role: index % 2 ? "assistant" as const : "user" as const, text: `earlier ${index} ${"x".repeat(bytes)}` }));
  const above = (limit: number, refusal: { status: number; body: string }) => (bytes: number) => bytes > limit ? refusal : null;

  it.each(SIZE_REFUSALS)("$name resends once with the oldest history dropped and finishes the turn", async (refusal) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limit = 40_000;
    const f = await provider(above(limit, refusal));
    const done = await f.run({ system: "Fixture system prompt.", transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(2);
    const [refused, resent] = f.requests;
    expect(refused!.bytes).toBeGreaterThan(limit);
    expect(resent!.bytes).toBeLessThanOrEqual(limit);
    expect(resent!.messages[0]).toEqual(refused!.messages[0]);
    expect(resent!.messages.at(-1)).toEqual(refused!.messages.at(-1));
    expect(resent!.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url" }] });
    const kept = resent!.messages.slice(2, -1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(refused!.messages.slice(-1 - kept.length, -1));
    expect(resent!.messages[1]).toMatchObject({ role: "assistant", content: expect.stringContaining("omitted to fit the provider's size limit") });
    expect(f.retries()).toEqual([expect.objectContaining({ attempt: 1, delayMs: 0, reason: "request_too_large" })]);
    expect(f.errors()).toEqual([]);
    const logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("too large"));
    expect(logged).toEqual([expect.stringContaining(`refused a ${refused!.bytes}-byte request`)]);
    expect(logged[0]).toContain(`→ ${resent!.bytes} bytes, 22 → `);
    expect(logged[0]).not.toMatch(/earlier \d|Summarize|Fixture system/);
  });

  const tokens = (bytes: number) => Math.ceil(bytes / 4);
  /** llama.cpp b7200 on answers HTTP 400; b6500 streamed HTTP 200 with an SSE `error:` event holding the bare error, then [DONE]. */
  const llamaCpp = (window: (firstTokens: number) => number, count: (bytes: number, messages: Array<{ role: string; content: unknown }>) => number = tokens,
    delivery: "http" | "sse" = "http") => {
    let n_ctx: number | undefined;
    return (bytes: number, messages: Array<{ role: string; content: unknown }>) => {
      const n_prompt_tokens = count(bytes, messages);
      n_ctx ??= window(n_prompt_tokens);
      if (n_prompt_tokens < n_ctx) return null;
      const error = { code: 400, message: `request (${n_prompt_tokens} tokens) exceeds the available context size (${n_ctx} tokens), try increasing it`,
        type: "exceed_context_size_error", n_prompt_tokens, n_ctx };
      return delivery === "http" ? { status: 400, body: JSON.stringify({ error }) } : { status: 200, body: `error: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n` };
    };
  };
  const denseSystem = (bytes: number, messages: Array<{ role: string; content: unknown }>) =>
    tokens(bytes) + 2 * tokens(Buffer.byteLength(JSON.stringify(messages.filter((message) => message.role === "system"))));

  it("resends a request llama.cpp counts a few tokens over its window with most of the history kept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(llamaCpp((first) => first - 2));
    const done = await f.run({ system: "Fixture system prompt.", transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(2);
    const [refused, resent] = f.requests;
    expect(resent!.bytes).toBeLessThanOrEqual(refused!.bytes * 0.8);
    expect(resent!.bytes).toBeGreaterThan(refused!.bytes * 0.6);
    expect(resent!.messages.length).toBeGreaterThan(refused!.messages.length / 2);
    expect(resent!.messages.at(-1)).toEqual(refused!.messages.at(-1));
    expect(f.retries()).toEqual([expect.objectContaining({ attempt: 1, delayMs: 0, reason: "request_too_large" })]);
    expect(f.errors()).toEqual([]);
  });

  it("resends a request an older llama.cpp refuses in its stream's error event, with most of the history kept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(llamaCpp((first) => first - 2, tokens, "sse"));
    const done = await f.run({ system: "Fixture system prompt.", transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(2);
    const [refused, resent] = f.requests;
    expect(resent!.bytes).toBeLessThanOrEqual(refused!.bytes * 0.8);
    expect(resent!.bytes).toBeGreaterThan(refused!.bytes * 0.6);
    expect(f.retries()).toEqual([expect.objectContaining({ attempt: 1, reason: "request_too_large" })]);
    expect(f.errors()).toEqual([]);
  });

  it.each([
    ['{"code":400,"message":"invalid grammar","type":"invalid_request_error"}', "upstream HTTP 400: invalid grammar"],
    ["slot unavailable", "provider returned a streaming error: slot unavailable"],
  ])("ends on the provider's own words for a streamed error event that is not about size: %s", async (event, message) => {
    const f = await provider(() => ({ status: 200, body: `error: ${event}\n\ndata: [DONE]\n\n` }));
    const done = await f.run({ transcript: transcript(2, 100) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.errors()).toEqual([message]);
  });

  it("resends a request llama.cpp counts at three times its window small enough to fit, where half would not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(llamaCpp((first) => Math.floor(first / 3)));
    const done = await f.run({ system: "Fixture system prompt.", transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: true });
    expect(f.requests).toHaveLength(2);
    expect(tokens(f.requests[1]!.bytes)).toBeLessThan(Math.floor(tokens(f.requests[0]!.bytes) / 3));
    expect(f.errors()).toEqual([]);
  });

  it("asks llama.cpp again with its fresh count when a dense system prompt keeps the first smaller copy over", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let window = 0;
    const f = await provider(llamaCpp((first) => window = Math.floor(first * 0.6), denseSystem));
    const done = await f.run({ system: `Fixture system prompt. ${"s".repeat(16_000)}`, transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: true });
    expect(f.requests.length).toBeGreaterThan(2);
    const sent = f.requests.at(-1)!;
    expect(denseSystem(sent.bytes, sent.messages)).toBeLessThan(window);
    expect(f.retries().map((retry) => (retry as { attempt: number }).attempt)).toEqual(f.requests.slice(1).map((_, index) => index + 1));
    const notes = sent.messages.filter((message) => typeof message.content === "string" && message.content.includes("omitted to fit"));
    expect(notes).toHaveLength(1);
    const kept = sent.messages.length - 3;
    expect(notes[0]!.content).toMatch(new RegExp(`^\\[${20 - kept} earlier messages omitted`));
    expect(f.errors()).toEqual([]);
  });

  it("stops after as many requests as any retried turn when llama.cpp refuses every smaller copy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(llamaCpp(() => 999, () => 1_000));
    const done = await f.run({ system: "Fixture system prompt.", transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(RETRY_MAX_ATTEMPTS);
    expect(f.retries().map((retry) => (retry as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(f.errors()).toEqual([requestTooLargeMessage("Fixture Flash")]);
  });

  it("fails with one plain message when not even the newest message fits llama.cpp's window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(llamaCpp(() => 100));
    const done = await f.run({ system: "Fixture system prompt.", transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(2);
    expect(f.retries()).toHaveLength(1);
    expect(f.errors()).toEqual([requestTooLargeMessage("Fixture Flash")]);
  });

  it.each(SIZE_REFUSALS)("$name fails with one plain message when the smaller resend is still too large", async (refusal) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(above(10_000, refusal));
    const done = await f.run({ system: `Fixture system prompt. ${"s".repeat(12_000)}`, transcript: transcript(6, 2_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.bytes).toBeLessThan(f.requests[0]!.bytes);
    expect(f.retries()).toHaveLength(1);
    expect(f.errors()).toEqual([requestTooLargeMessage("Fixture Flash")]);
  });

  it.each(SIZE_REFUSALS)("$name does not resend when nothing but the system prompt and the message could shrink", async (refusal) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(above(10_000, refusal));
    const done = await f.run({ system: `Fixture system prompt. ${"s".repeat(12_000)}` });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.retries()).toEqual([]);
    expect(f.errors()).toEqual([requestTooLargeMessage("Fixture Flash")]);
  });

  it.each([
    [400, '{"error":{"message":"invalid model"}}', "upstream HTTP 400: invalid model"],
    [400, '{"error":{"code":"invalid_request_error","message":"context_length_exceeded"}}', "upstream HTTP 400: context_length_exceeded (invalid_request_error)"],
  ])("leaves an HTTP %i failure as it was", async (status, body, message) => {
    const f = await provider(() => ({ status, body }));
    const done = await f.run({ transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.retries()).toEqual([]);
    expect(f.errors()).toEqual([message]);
  });

  it.each([
    [500, "Internal Server Error", "upstream HTTP 500: Internal Server Error", "server_error"],
    [429, '{"error":{"message":"Rate limit reached for requests"}}', "upstream HTTP 429: Rate limit reached for requests", "rate_limited"],
  ])("retries an HTTP %i failure at full size, and doesn't take it for a request that is too large", async (status, body, message, reason) => {
    const f = await provider(() => ({ status, body }));
    const done = await f.run({ transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(3);
    expect(new Set(f.requests.map((request) => request.bytes)).size).toBe(1);
    expect(f.retries()).toEqual([
      expect.objectContaining({ attempt: 1, reason }),
      expect.objectContaining({ attempt: 2, reason }),
    ]);
    expect(f.errors()).toEqual([message]);
  }, 20_000);
});

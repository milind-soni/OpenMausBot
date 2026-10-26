import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { requestTooLargeMessage } from "../../shared/request-too-large.ts";
import { IMAGE_OMITTED, refusesRequestSize, smallerResend, TOOL_OUTPUT_SHORTENED } from "./chat-size-limit.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const NGINX_413 = "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
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
  ])("reads HTTP %i %j as a size refusal", (status, body) => {
    expect(refusesRequestSize(status, body)).toBe(true);
  });

  it.each([
    [400, '{"error":{"message":"invalid model"}}'],
    [412, "Precondition Failed"],
    [429, '{"error":{"message":"Rate limit reached for requests"}}'],
    [500, "Internal Server Error"],
    [502, NGINX_413.replaceAll("413 Request Entity Too Large", "502 Bad Gateway")],
  ])("leaves HTTP %i %j alone", (status, body) => {
    expect(refusesRequestSize(status, body)).toBe(false);
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

  async function provider(refuse: (bytes: number) => { status: number; body: string } | null) {
    const requests: Array<{ bytes: number; messages: Array<{ role: string; content: unknown }> }> = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "fixture/flash", name: "Fixture Flash" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      requests.push({ bytes: raw.length, messages: JSON.parse(raw.toString("utf8")).messages });
      const refusal = refuse(raw.length);
      if (refusal) {
        res.writeHead(refusal.status, { "content-type": "text/html" });
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
  const above = (limit: number) => (bytes: number) => bytes > limit ? { status: 413, body: NGINX_413 } : null;

  it("resends once with the oldest history dropped and finishes the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limit = 40_000;
    const f = await provider(above(limit));
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

  it("fails with one plain message when the smaller resend is still too large", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(above(10_000));
    const done = await f.run({ system: `Fixture system prompt. ${"s".repeat(12_000)}`, transcript: transcript(6, 2_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.bytes).toBeLessThan(f.requests[0]!.bytes);
    expect(f.errors()).toEqual([requestTooLargeMessage("Fixture Flash")]);
  });

  it("does not resend when nothing but the system prompt and the message could shrink", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await provider(above(10_000));
    const done = await f.run({ system: `Fixture system prompt. ${"s".repeat(12_000)}` });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.retries()).toEqual([]);
    expect(f.errors()).toEqual([requestTooLargeMessage("Fixture Flash")]);
  });

  it.each([
    [400, '{"error":{"message":"invalid model"}}', "upstream HTTP 400: invalid model"],
    [500, "Internal Server Error", "upstream HTTP 500: Internal Server Error"],
    [429, '{"error":{"message":"Rate limit reached for requests"}}', "upstream HTTP 429: Rate limit reached for requests"],
  ])("leaves an HTTP %i failure as it was", async (status, body, message) => {
    const f = await provider(() => ({ status, body }));
    const done = await f.run({ transcript: transcript(20, 3_000) });
    expect(done).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.retries()).toEqual([]);
    expect(f.errors()).toEqual([message]);
  });
});

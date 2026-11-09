// The chat runtime may resend a stream the provider closed before any completion marker; these
// tests pin that one protocol error's retry and the guards that keep a resend side-effect free.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

// The backoff between attempts is covered by retry.ts itself; here it would only slow the suite.
vi.mock("./retry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./retry.ts")>();
  return { ...actual, computeBackoff: () => 0 };
});

afterEach(() => vi.unstubAllGlobals());

const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
/** Closes with no [DONE], no finish_reason and nothing streamed: the truncation under test. */
const truncated = () => sse("");
const answer = () => sse('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'
  + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');

/** `bodies` is one SSE response per chat completion; the last repeats for any further attempt. */
async function runTurn(bodies: Array<() => Response>): Promise<{ events: RuntimeEvent[]; requests: number }> {
  let chatRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) =>
    String(url).endsWith("/chat/completions")
      ? (chatRequests++, bodies[Math.min(chatRequests - 1, bodies.length - 1)]())
      : new Response("", { status: 404 })));
  const instance = await OpenAICompatDriver.create({
    instanceId: "compat", displayName: "Compat", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://compat.example/v1", apiKeyEnv: "COMPAT_API_KEY", model: "compat-m3" }),
    environment: { COMPAT_API_KEY: "secret" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
  await vi.waitFor(() => {
    if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
  });
  await instance.dispose();
  return { events, requests: chatRequests };
}

describe("createOpenAIChatRuntime stream truncation retry", () => {
  it("resends a stream that ended before completion and finishes the turn on the next attempt", async () => {
    const { events, requests } = await runTurn([truncated, answer]);
    expect(events.filter((event) => event.type === "turn.retrying"))
      .toEqual([expect.objectContaining({ attempt: 1, reason: "stream_truncated" })]);
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "hi" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(requests).toBe(2);
  });

  it("gives up after three truncated attempts and reports the last error", async () => {
    const { events, requests } = await runTurn([truncated]);
    expect(events.filter((event) => event.type === "turn.retrying").map((event) => event.type === "turn.retrying" && event.attempt))
      .toEqual([1, 2]);
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: "Stream ended before completion" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
    expect(requests).toBe(3);
  });

  it("does not resend once answer text streamed, even with a clean retry available", async () => {
    const { events, requests } = await runTurn([
      () => sse('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'),
      answer,
    ]);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: "Stream ended before completion" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
    expect(requests).toBe(1);
  });
});

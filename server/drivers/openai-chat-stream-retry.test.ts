// The chat runtime may resend a stream the provider closed before any completion marker; these
// tests pin that one protocol error's retry and the guards that keep a resend side-effect free.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("does not resend a truncation after a tool call ran, so its effect happens once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-chat-trunc-tool-"));
    const script = join(dir, "fake-mcp.mjs");
    const receipt = join(dir, "receipt.log");
    writeFileSync(script, `#!/usr/bin/env node
      import { appendFileSync } from "node:fs";
      const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          const m = JSON.parse(line);
          if (m.method === "initialize") send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}}}});
          else if (m.method === "tools/list") send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"write",description:"Fixture write",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}});
          else if (m.method === "tools/call") { appendFileSync(${JSON.stringify(receipt)}, "write\\n"); send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"ok"}]}}); }
        }
      });
    `);
    chmodSync(script, 0o755);
    const callBody = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"fx_write","arguments":"{}"}}]}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const bodies: Array<{ messages: Array<{ role: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      if (!String(input).endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
      bodies.push(JSON.parse(String(init?.body)));
      // The tool result goes back up, and that second attempt's stream is the truncation.
      return new Response(bodies.length === 1 ? callBody : "", { headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "trunc", displayName: "Synthetic", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.test/v1", apiKeyEnv: "K", model: "fixture" }),
      environment: { K: "synthetic" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    try {
      await instance.adapter.sendTurn({
        threadId: "trunc", text: "Use the tool, then answer.", approvalMode: "full",
        integrations: { custom: { fx: { command: script, args: [], env: {} } } },
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === "turn.completed")).toBe(true), { timeout: 10_000 });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.messages.some((message) => message.role === "tool")).toBe(true);
      expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: "Stream ended before completion" });
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
      expect(readFileSync(receipt, "utf8").trim().split("\n")).toEqual(["write"]);
    } finally {
      await instance.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

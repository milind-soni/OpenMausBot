// Stream-termination contract of the shared chat-completions runtime, driven
// through the openai-compat driver. MiniMax's api.minimax.io/v1 closes the
// connection after the finish_reason chunk without ever sending `data: [DONE]`,
// and reports account failures as HTTP 200 with a JSON `base_resp` body.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { MinimaxDriver } from "./minimax.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => vi.unstubAllGlobals());

async function runTurn(body: string, driver: "openai-compat" | "minimax" = "openai-compat") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
  const instance = driver === "minimax"
    ? await MinimaxDriver.create({
        instanceId: "minimax", displayName: "MiniMax", enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      })
    : await OpenAICompatDriver.create({
        instanceId: "minimax", displayName: "MiniMax", enabled: true,
        config: OpenAICompatDriver.decodeConfig({ url: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", model: "MiniMax-M3" }),
        environment: { MINIMAX_API_KEY: "secret" },
      });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
  await vi.waitFor(() => {
    if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
  });
  await instance.dispose();
  return events;
}

describe("createOpenAIChatRuntime tool approvals", () => {
  // A bot on an OpenAI-compatible engine used to stop for a card on EVERY
  // tool call, with no way out: this family has no provider reviewer, so
  // Auto behaves like Ask; the card offers no session-wide allow; and the
  // "Always allowed" list only ever fills from peer-comms grants. Full
  // access is the person's explicit grant to answer every prompt, and with
  // no provider to hand it to, the runtime has to honour it itself.
  const mcpDir: string[] = [];
  afterEach(() => { for (const d of mcpDir.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const toolServer = () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-chat-approval-"));
    mcpDir.push(dir);
    const script = join(dir, "fake-mcp.mjs");
    writeFileSync(script, `#!/usr/bin/env node
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
          else if (m.method === "tools/call") send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"done"}]}});
        }
      });
    `);
    chmodSync(script, 0o755);
    return { command: script, args: [], env: {} };
  };

  const cardRaisedFor = async (approvalMode: "ask" | "full") => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"fx_write","arguments":"{}"}}]}}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await OpenAICompatDriver.create({
      instanceId: "compat", displayName: "Compat", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.com/v1", apiKeyEnv: "K", model: "m" }),
      environment: { K: "secret" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({
      threadId: "thread", text: "hi", approvalMode,
      integrations: { custom: { fx: toolServer() } },
    });
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "request.opened" || e.type === "item.started" || e.type === "turn.completed")) {
        throw new Error("waiting");
      }
    }, { timeout: 10_000 });
    const opened = events.some((event) => event.type === "request.opened");
    await instance.adapter.interruptTurn("thread").catch(() => {});
    await instance.dispose();
    return opened;
  };

  it("holds a card for every tool call when the bot is on Ask", async () => {
    expect(await cardRaisedFor("ask")).toBe(true);
  }, 20_000);

  it("answers for the person under Full access, so no card is raised", async () => {
    expect(await cardRaisedFor("full")).toBe(false);
  }, 20_000);

  it("still holds an ask_user card for a person under Full access and returns the reply verbatim", async () => {
    const askBody = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"ask1","type":"function","function":{"name":"ask_user","arguments":'
      + JSON.stringify(JSON.stringify({ questions: [{ question: "Ship the fixture?", options: [{ label: "Yes" }, { label: "No" }] }] }))
      + '}}]}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const finalBody = 'data: {"choices":[{"index":0,"delta":{"content":"Shipped."}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      bodies.push(String(init?.body));
      return new Response(bodies.length === 1 ? askBody : finalBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "compat", displayName: "Compat", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.com/v1", apiKeyEnv: "K", model: "m" }),
      environment: { K: "secret" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi", approvalMode: "full" });
    const opened = await vi.waitFor(() => {
      const found = events.find((event) => event.type === "request.opened");
      if (!found) throw new Error("waiting for the question card");
      return found;
    }, { timeout: 10_000 });
    expect(opened).toMatchObject({
      requestType: "question", tool: "ask_user", summary: "Ship the fixture?",
      questions: [{ question: "Ship the fixture?", options: [{ label: "Yes" }, { label: "No" }] }],
      choices: ["Yes", "No"],
    });
    expect(bodies[0]).toContain('"ask_user"');
    const reply = "The user answered your questions.\n\nQ: Ship the fixture?\nA: Yes";
    expect(await instance.adapter.respondToRequest("thread", opened.requestId!, { behavior: "answer", message: reply })).toBe("answered");
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
    }, { timeout: 10_000 });
    await instance.dispose();
    // Full access answered every permission on this turn; it must not have
    // touched the question, and no permission card may stand in for it.
    expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    expect(events.filter((event) => event.type === "request.resolved")).toEqual([
      expect.objectContaining({ behavior: "answer", source: "user" }),
    ]);
    const toolMessage = JSON.parse(bodies[1]!).messages.at(-1);
    expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "ask1" });
    expect(JSON.parse(toolMessage.content)).toEqual({ ok: true, result: reply });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  }, 20_000);
});

describe("createOpenAIChatRuntime stream termination", () => {
  it("treats EOF after a finish_reason chunk as a clean completion when [DONE] never arrives", async () => {
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"<think>\\nuser said hi\\n</think>Hello!"}}]}\n\n' +
        'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":" How can I help?"}}],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({
      text: "<think>\nuser said hi\n</think>Hello! How can I help?",
    });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });

  it("parses a final finish_reason+usage frame with no trailing newline before the socket closes", async () => {
    // No trailing \n\n after the last frame -- the connection just closes,
    // the way it does against several real OpenAI-compatible local servers.
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });

  it("splits a final unterminated frame across two stream chunks", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const instance = await OpenAICompatDriver.create({
      instanceId: "minimax", displayName: "MiniMax", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY", model: "MiniMax-M3" }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    // The final frame's closing brace and its usage object arrive in a
    // second chunk, after the first chunk already delivered a complete
    // earlier frame -- proves the leftover-buffer flush on EOF works
    // whether the split content arrived in one decoder.decode() call or
    // accumulated across several.
    controller!.enqueue(
      encoder.encode(
        'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"comple',
      ),
    );
    controller!.enqueue(encoder.encode('tion_tokens":9}}'));
    controller!.close();
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "turn.completed")) throw new Error("turn still running");
    });
    await instance.dispose();
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });

  it("does not misfire on an empty final flush when the stream ends cleanly on a newline", async () => {
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "hi" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 1, output: 1 } });
  });

  it("settles a turn whose stream was cut mid-frame instead of failing it", async () => {
    // A person stopping a turn (or a dropped connection) leaves a partial
    // frame in the buffer. Before the EOF flush was guarded this was parsed,
    // failed JSON.parse, set malformedFrame, and turned a clean stop into a
    // hard non-retryable failure -- caught by delta-context.e2e on Windows.
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{"content":" wor',
    );
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello" });
    expect(events.find((event) => event.type === "runtime.error")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("still honors data: [DONE]", async () => {
    const events = await runTurn('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "hi" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("surfaces an HTTP 200 whose body is a MiniMax base_resp error instead of finishing silently", async () => {
    const events = await runTurn('{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}');
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "provider returned a completion error: upstream error 1008: insufficient balance",
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
  });

  it("surfaces an OpenAI-style error object returned with HTTP 200", async () => {
    const events = await runTurn('{"error":{"message":"token is unusable (1004)","type":"authorized_error"}}');
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "provider returned a completion error: token is unusable (1004)",
    });
  });

  it("reports a stream truncated before finish_reason as an error, not an interrupt", async () => {
    const events = await runTurn('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n');
    expect(events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "Stream ended before completion",
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
  });

  it("lets the MiniMax driver finish a [DONE]-less reasoning_split stream and stream its reasoning", async () => {
    const events = await runTurn(
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"user said hi"}}]}\n\n' +
        'data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":"Hello!"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
      "minimax",
    );
    expect(events.filter((event) => event.type === "content.delta").map((event) => event.streamKind))
      .toEqual(["reasoning_text", "assistant_text"]);
    expect(events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello!" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 5, output: 9 } });
  });
});

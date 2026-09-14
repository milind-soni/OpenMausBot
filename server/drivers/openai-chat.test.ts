// Stream-termination contract of the shared chat-completions runtime, driven
// through the openai-compat driver. MiniMax's api.minimax.io/v1 closes the
// connection after the finish_reason chunk without ever sending `data: [DONE]`,
// and reports account failures as HTTP 200 with a JSON `base_resp` body.
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

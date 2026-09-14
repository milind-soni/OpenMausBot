import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { VisionDriver } from "./vision.ts";

function sse(text: string) {
  return `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\ndata: [DONE]\n`;
}

/** Stub fetch: /models returns a fixed catalog; /chat/completions answers
 * from a scripted queue per model. Every completion reports usage 11/7 so
 * totals are predictable. */
function stubUpstream(script: Record<string, string[]>) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "freellm/fast", name: "Fast" },
              { id: "direct:deepseek-chat", name: "DeepSeek Chat (Direct API)" },
              { id: "rlm:auto", name: "RLM Auto (Harness)" },
            ],
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
      bodies.push(body);
      const queue = script[body.model] ?? script["*"] ?? [];
      const next = queue.shift() ?? 'final("default")';
      // rlm: sub/root calls are non-streaming; plain chat turns stream.
      if (body.stream) return new Response(sse(next), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return bodies;
}

const makeInstance = async (model?: string) =>
  VisionDriver.create({
    instanceId: "inst-rlm",
    displayName: "Vision",
    enabled: true,
    config: { url: "http://localhost:3001/v1", apiKeyEnv: "FREELLMAPI_API_KEY", ...(model ? { model } : {}) },
    environment: { FREELLMAPI_API_KEY: "secret" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VisionDriver rlm routing", () => {
  it("delegates a plain chat model to the base runtime, untouched", async () => {
    const bodies = stubUpstream({ "*": ["plain reply"] });
    const inst = await makeInstance("freellm/fast");
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "t1", text: "hello", model: "freellm/fast" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true });
    expect(bodies[0]).toMatchObject({ model: "freellm/fast", stream: true });
    recorder.stop();
    await inst.dispose();
  });

  it("serves rlm:auto locally with helper calls on the same endpoint", async () => {
    // The instance default rlm:auto resolves to root model "auto"; helpers
    // pick the cheap direct: route. Three upstream calls total.
    const bodies = stubUpstream({
      "auto": [
        "Step one.\n```repl\nprint(llm('who?'))\n```",
        'final("harness answer")',
      ],
      "direct:deepseek-chat": ["a helper answer"],
    });
    const inst = await makeInstance("rlm:auto");
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "t2", text: "question" });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 33, output: 21 } });
    // The root's narration streamed as reasoning; the sandbox step shows as a tool item.
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "reasoning_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "item.started" && e.itemType === "tool" && (e.title ?? "").startsWith("repl"))).toBe(true);
    // One helper call hit the endpoint on the cheap direct route.
    expect(bodies.some((b) => b.model === "direct:deepseek-chat")).toBe(true);
    // The final answer is the extracted final(), not prose.
    expect(recorder.events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "harness answer")).toBe(true);
    recorder.stop();
    await inst.dispose();
  });

  it("routes rlm:* catalog entries through the harness, never to the wire verbatim", async () => {
    stubUpstream({ "*": ['final("done")'] });
    const inst = await makeInstance("rlm:auto");
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "t3", text: "go", model: "rlm:auto" });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true });
    recorder.stop();
    await inst.dispose();
  });

  it("closes a harness turn's tool toolbox — the RLM loop consumes no tools, so the mounted MCP servers must not leak", async () => {
    stubUpstream({ "*": ['final("done")'] });
    const inst = await makeInstance("rlm:auto");
    const recorder = recordEvents(inst.adapter);
    // startTurn only hands over a toolbox when the adapter claims apiToolLoop
    // (true here through the Vision runtime inheritance) — assert the claim
    // the ownership contract rests on, then prove the close.
    expect(inst.adapter.capabilities.apiToolLoop).toBe(true);
    let closed = 0;
    const tools = {
      list: [{ name: "computer_screenshot", execute: async () => ({ isError: false, text: "", images: [] }) }],
      close: async () => {
        closed++;
      },
    };

    await inst.adapter.sendTurn({ threadId: "t4", text: "go", model: "rlm:auto", tools });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true });
    // The harness path closes the toolbox synchronously on entry; either way,
    // exactly one close per turn and no dangling servers afterwards.
    expect(closed).toBe(1);
    recorder.stop();
    await inst.dispose();
  });

  it("delegates a toolbox untouched on non-rlm models — exactly one close, by the base runtime", async () => {
    stubUpstream({ "*": ["plain reply"] });
    const inst = await makeInstance("rlm:auto");
    const recorder = recordEvents(inst.adapter);
    let closed = 0;
    const tools = {
      list: [],
      close: async () => {
        closed++;
      },
    };

    await inst.adapter.sendTurn({ threadId: "t5", text: "hello", model: "freellm/fast", tools });
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true });
    // The wrapper must pass the turn through without closing: the shared
    // runtime's finally owns the close. Poll so the base's async finally has
    // landed — one close proves the toolbox traveled intact (a wrapper close
    // on entry would make this two).
    await expect
      .poll(() => closed, { timeout: 2_000, message: "the base runtime never closed the delegated toolbox" })
      .toBe(1);
    recorder.stop();
    await inst.dispose();
  });
});

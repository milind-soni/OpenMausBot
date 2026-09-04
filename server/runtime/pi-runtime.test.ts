// The owned loop against a scripted model: what it does, and what the model
// is shown. Every case runs through the real Pi agent core; only the
// provider call is faked.
import { describe, expect, it } from "vitest";

import type { TurnContextPlan } from "../context/types.ts";
import type { OwnedRuntimeEvent, OwnedTool, OwnedTurnInput } from "./contracts.ts";
import { makeFakeModel, type FakeResponse } from "./fake-model.ts";
import { createPiRuntime, toPiMessages, toPiModel } from "./pi-runtime.ts";

const plan = (over: Partial<TurnContextPlan> = {}): TurnContextPlan => ({
  ownership: "omb-loop",
  mode: "replay-required",
  currentPrompt: "what now?",
  replayPrompt: "what now?",
  messages: [
    { kind: "user-text", messageId: "m1", text: "my dog is Biscuit" },
    { kind: "assistant-text", messageId: "m2", text: "Noted — Biscuit." },
  ],
  budget: { contextWindow: 200_000, historyTokens: 80_000, limitsSource: "pattern" },
  diagnostics: { sourceItems: 2, sentItems: 2, estimatedInputTokens: 20, compacted: false, clipped: false },
  ...over,
});

const echoTool = (calls: Array<Record<string, unknown>> = []): OwnedTool => ({
  name: "echo",
  description: "Echo the input back",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  async execute(callId, args) {
    calls.push(args);
    return {
      text: `echoed: ${String(args.text)}`,
      ok: true,
      observation: { callId, name: "echo", inputSummary: String(args.text), outputSummary: `echoed: ${String(args.text)}`, ok: true },
    };
  },
});

/** Run one turn and collect everything it reported. */
async function turn(script: FakeResponse[], over: Partial<OwnedTurnInput> = {}) {
  const fake = makeFakeModel(script);
  const runtime = createPiRuntime({ streamFn: fake.streamFn });
  const events: OwnedRuntimeEvent[] = [];
  const abort = new AbortController();
  const input: OwnedTurnInput = {
    threadId: "t1",
    turnId: "turn-1",
    plan: plan(),
    system: "You are Wren.",
    model: { id: "test-model", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test-key", contextWindow: 200_000, maxOutputTokens: 4_096, reasoning: true },
    tools: [],
    signal: abort.signal,
    limits: { maxModelCalls: 32, maxToolCalls: 64, toolTimeoutMs: 5_000 },
    ...over,
  };
  await runtime.run(input, (e) => events.push(e));
  return { events, fake, runtime, abort };
}

const types = (events: OwnedRuntimeEvent[]) => events.map((e) => e.type);

describe("createPiRuntime", () => {
  it("streams text and reports the final answer, then completes", async () => {
    const { events } = await turn([{ text: "Hello there", usage: { input: 12, output: 3 } }]);
    expect(events.filter((e) => e.type === "delta" && e.kind === "text").map((e) => (e as { text: string }).text).join(""))
      .toBe("Hello there");
    expect(events).toContainEqual({ type: "assistant", text: "Hello there" });
    expect(events).toContainEqual({ type: "usage", input: 12, output: 3 });
    expect(events.at(-1)).toEqual({ type: "completed", ok: true, stopReason: "end_turn" });
  });

  it("streams reasoning separately from text", async () => {
    const { events } = await turn([{ reasoning: "thinking hard", text: "answer" }]);
    const reasoning = events.filter((e) => e.type === "delta" && e.kind === "reasoning").map((e) => (e as { text: string }).text).join("");
    expect(reasoning).toBe("thinking hard");
    expect(events).toContainEqual({ type: "assistant", text: "answer" });
  });

  it("rebuilds the model's view from the plan — the plan is the only history", async () => {
    const { fake } = await turn([{ text: "ok" }]);
    const shown = fake.calls[0]!;
    expect(shown.systemPrompt).toBe("You are Wren.");
    // user content is a string OR a content array (Pi's prompt(string)
    // stores the array form); read both the same way
    const textOf = (content: string | Array<{ type: string; text?: string }>) =>
      typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
    const texts = shown.messages.map((m) => (m.role === "toolResult" ? "" : textOf(m.content)));
    expect(texts).toEqual(["my dog is Biscuit", "Noted — Biscuit.", "what now?"]);
  });

  it("passes the API key explicitly on every call and gives Pi an empty env", async () => {
    // the key must ride on the request and only there; an empty env means
    // Pi has nowhere else to look for one
    const { fake } = await turn([{ toolCalls: [{ name: "echo", args: { text: "a" } }] }, { text: "done" }], { tools: [echoTool()] });
    expect(fake.keys).toEqual(["sk-test-key", "sk-test-key"]);
  });

  it("runs one tool call and feeds the result back into a second model call", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { events, fake } = await turn(
      [{ toolCalls: [{ name: "echo", args: { text: "ping" } }] }, { text: "it said pong" }],
      { tools: [echoTool(calls)] },
    );
    expect(calls).toEqual([{ text: "ping" }]);
    expect(types(events)).toContain("tool.started");
    const done = events.find((e) => e.type === "tool.completed") as Extract<OwnedRuntimeEvent, { type: "tool.completed" }>;
    expect(done.ok).toBe(true);
    expect(done.observation).toMatchObject({ name: "echo", inputSummary: expect.stringContaining("ping") });
    // the second call saw the tool result
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.messages.some((m) => m.role === "toolResult")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "completed", ok: true, stopReason: "end_turn" });
  });

  it("runs several tool calls from one model turn", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { events } = await turn(
      [{ toolCalls: [{ name: "echo", args: { text: "one" } }, { name: "echo", args: { text: "two" } }] }, { text: "both done" }],
      { tools: [echoTool(calls)] },
    );
    expect(calls).toEqual([{ text: "one" }, { text: "two" }]);
    expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(2);
  });

  it("stores a bounded, redacted observation — never the raw result", async () => {
    const leaky: OwnedTool = {
      ...echoTool(),
      async execute(callId) {
        const output = `token=sk-ant-abcdefghijklmnop0123456789 ${"x".repeat(20_000)}`;
        return { text: output, ok: true, observation: { callId, name: "echo", ok: true } };
      },
    };
    const { events } = await turn([{ toolCalls: [{ name: "echo", args: { text: "a" } }] }, { text: "ok" }], { tools: [leaky] });
    const done = events.find((e) => e.type === "tool.completed") as Extract<OwnedRuntimeEvent, { type: "tool.completed" }>;
    expect(done.observation.outputSummary).not.toContain("sk-ant-abcdefghijklmnop");
    expect(done.observation.outputSummary!.length).toBeLessThanOrEqual(6_000);
    expect(done.observation.clipped).toBe(true);
  });

  it("reports a provider error and completes as failed, without throwing", async () => {
    const { events } = await turn([{ error: "upstream 503" }]);
    expect(events).toContainEqual({ type: "error", message: "upstream 503" });
    expect(events.at(-1)).toEqual({ type: "completed", ok: false, stopReason: "error" });
  });

  it("interrupts a hanging model call and completes as interrupted", async () => {
    const fake = makeFakeModel([{ hang: true }]);
    const runtime = createPiRuntime({ streamFn: fake.streamFn });
    const events: OwnedRuntimeEvent[] = [];
    const abort = new AbortController();
    const running = runtime.run({
      threadId: "t1", turnId: "turn-1", plan: plan(), system: "", tools: [], signal: abort.signal,
      model: { id: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", contextWindow: 8_000, maxOutputTokens: 1_000, reasoning: false },
      limits: { maxModelCalls: 32, maxToolCalls: 64, toolTimeoutMs: 5_000 },
    }, (e) => events.push(e));
    expect(runtime.hasTurn("t1")).toBe(true);
    runtime.interrupt("t1");
    await running;
    expect(events.at(-1)).toEqual({ type: "completed", ok: false, stopReason: "interrupted" });
    expect(runtime.hasTurn("t1")).toBe(false);
  });

  it("stops at the model-call limit", async () => {
    // a model that always asks for another tool would loop forever
    const endless = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "echo", args: { text: "again" } }] }));
    const { events } = await turn(endless, { tools: [echoTool()], limits: { maxModelCalls: 3, maxToolCalls: 64, toolTimeoutMs: 5_000 } });
    expect(events.filter((e) => e.type === "model.call")).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "completed", ok: true, stopReason: "max_model_calls" });
  });

  it("stops at the tool-call limit", async () => {
    const endless = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: "echo", args: { text: "again" } }] }));
    const { events } = await turn(endless, { tools: [echoTool()], limits: { maxModelCalls: 32, maxToolCalls: 2, toolTimeoutMs: 5_000 } });
    expect(events.at(-1)).toEqual({ type: "completed", ok: true, stopReason: "max_tool_calls" });
  });

  it("delivers a steered message before the next model call", async () => {
    const fake = makeFakeModel([{ toolCalls: [{ name: "echo", args: { text: "a" } }] }, { text: "done" }]);
    const runtime = createPiRuntime({ streamFn: fake.streamFn });
    const events: OwnedRuntimeEvent[] = [];
    const steerOnce: OwnedTool = {
      ...echoTool(),
      async execute(callId) {
        runtime.steer("t1", "actually, stop after this");
        return { text: "ok", ok: true, observation: { callId, name: "echo", ok: true } };
      },
    };
    await runtime.run({
      threadId: "t1", turnId: "turn-1", plan: plan(), system: "", tools: [steerOnce], signal: new AbortController().signal,
      model: { id: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", contextWindow: 8_000, maxOutputTokens: 1_000, reasoning: false },
      limits: { maxModelCalls: 32, maxToolCalls: 64, toolTimeoutMs: 5_000 },
    }, (e) => events.push(e));
    const second = fake.calls[1]!;
    expect(second.messages.some((m) => m.role === "user" && m.content === "actually, stop after this")).toBe(true);
  });

  it("steer returns false when nothing is running", () => {
    const runtime = createPiRuntime({ streamFn: makeFakeModel([]).streamFn });
    expect(runtime.steer("nope", "hi")).toBe(false);
  });

  it("starts every turn from the plan alone — nothing survives a previous turn", async () => {
    // the second turn must see exactly its own plan, not the first turn's
    // tool results
    const fake = makeFakeModel([{ toolCalls: [{ name: "echo", args: { text: "a" } }] }, { text: "one" }, { text: "two" }]);
    const runtime = createPiRuntime({ streamFn: fake.streamFn });
    const base = {
      threadId: "t1", system: "", tools: [echoTool()], signal: new AbortController().signal,
      model: { id: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", contextWindow: 8_000, maxOutputTokens: 1_000, reasoning: false },
      limits: { maxModelCalls: 32, maxToolCalls: 64, toolTimeoutMs: 5_000 },
    };
    await runtime.run({ ...base, turnId: "turn-1", plan: plan() }, () => {});
    await runtime.run({ ...base, turnId: "turn-2", plan: plan() }, () => {});
    const third = fake.calls[2]!;
    expect(third.messages.some((m) => m.role === "toolResult")).toBe(false);
    expect(third.messages).toHaveLength(3);
  });
});

describe("toPiMessages", () => {
  it("renders portable tool observations as descriptive text, never fabricated tool calls", () => {
    const messages = toPiMessages([{ kind: "tool-observation", messageId: "m1", observation: { name: "Edit", ok: true } }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("keeps room speakers attributed", () => {
    const [m] = toPiMessages([{ kind: "assistant-text", messageId: "m1", text: "on it", speaker: "Fig" }]);
    expect(m!.role === "assistant" && m!.content[0]!.type === "text" ? m!.content[0]!.text : "").toBe("Fig: on it");
  });
});

describe("toPiModel", () => {
  it("routes an OpenRouter target through the pinned provider without fallbacks", () => {
    const model = toPiModel({ id: "x", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 1, maxOutputTokens: 1, reasoning: false, openRouterProvider: "groq" });
    expect(model.provider).toBe("openrouter");
    expect(model.compat).toEqual({ openRouterRouting: { order: ["groq"], allow_fallbacks: false } });
  });

  it("ignores a provider pin for a non-OpenRouter endpoint", () => {
    const model = toPiModel({ id: "x", baseUrl: "http://127.0.0.1:8080/v1", contextWindow: 1, maxOutputTokens: 1, reasoning: false, openRouterProvider: "groq" });
    expect(model.provider).toBe("openmaus");
    expect(model.compat).toBeUndefined();
  });
});

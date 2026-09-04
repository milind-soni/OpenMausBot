// The driver over the owned loop: how OwnedRuntimeEvents become canonical
// RuntimeEvents, and what the adapter refuses. The runtime itself is faked
// here — pi-runtime.test.ts covers the loop; this covers the seam.
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import type { TurnContextPlan } from "../context/types.ts";
import type { OwnedAgentRuntime, OwnedRuntimeEmit, OwnedRuntimeEvent, OwnedTurnInput } from "../runtime/contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenMausRuntimeDriver, createOpenMausRuntimeInstance } from "./openmaus-runtime.ts";

const plan: TurnContextPlan = {
  ownership: "omb-loop",
  mode: "replay-required",
  currentPrompt: "what now?",
  replayPrompt: "what now?",
  messages: [{ kind: "user-text", messageId: "m1", text: "hi" }],
  budget: { contextWindow: 200_000, historyTokens: 80_000, limitsSource: "pattern" },
  diagnostics: { sourceItems: 1, sentItems: 1, estimatedInputTokens: 5, compacted: false, clipped: false },
};

/** A runtime that replays a script of events for each run() and records
 * what it was asked to do. */
function fakeRuntime(script: OwnedRuntimeEvent[]) {
  const runs: OwnedTurnInput[] = [];
  const runtime: OwnedAgentRuntime & { runs: OwnedTurnInput[]; steered: string[]; interrupted: string[] } = {
    runs,
    steered: [],
    interrupted: [],
    async run(input, emit: OwnedRuntimeEmit) {
      runs.push(input);
      for (const event of script) emit(event);
    },
    steer(threadId, text) {
      runtime.steered.push(`${threadId}:${text}`);
      return true;
    },
    interrupt(threadId) {
      runtime.interrupted.push(threadId);
    },
    hasTurn: () => false,
    dispose: async () => {},
  };
  return runtime;
}

const instanceWith = (runtime: OwnedAgentRuntime, key = "sk-test") =>
  createOpenMausRuntimeInstance(
    {
      instanceId: "owned-test",
      displayName: "Owned",
      environment: key ? { OPENAI_COMPAT_API_KEY: key } : {},
      enabled: true,
      config: OpenMausRuntimeDriver.decodeConfig({ url: "http://127.0.0.1:1/v1", model: "test-model" }),
    },
    { runtime },
  );

describe("OpenMausRuntimeDriver", () => {
  it("declares ownership of the loop, queueing, and no MCP capability yet", () => {
    const inst = instanceWith(fakeRuntime([]));
    const caps = inst.adapter.capabilities;
    expect(caps.contextOwnership).toBe("omb-loop");
    expect(caps.queueing).toBe(true);
    // advertised only after each integration test passes (Task 9)
    for (const cap of ["agentsMcp", "computerMcp", "composioMcp", "phoneMcp", "browserMcp", "customMcp", "localComputerMcp"] as const) {
      expect(caps[cap], cap).toBeFalsy();
    }
  });

  it("is available and metered with a key, unavailable without one", async () => {
    await expect(instanceWith(fakeRuntime([])).snapshot()).resolves.toMatchObject({ state: "available", billing: "metered" });
    await expect(instanceWith(fakeRuntime([]), "").snapshot()).resolves.toMatchObject({ state: "unavailable" });
  });

  it("refuses a turn without a key, and never calls the runtime", async () => {
    const runtime = fakeRuntime([]);
    await expect(instanceWith(runtime, "").adapter.sendTurn({ threadId: "t", text: "hi", context: plan })).rejects.toThrow(/no API key/);
    expect(runtime.runs).toHaveLength(0);
  });

  it("refuses a turn without a context plan — for this engine the plan is the only history", async () => {
    const runtime = fakeRuntime([]);
    await expect(instanceWith(runtime).adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/requires SendTurnInput.context/);
    expect(runtime.runs).toHaveLength(0);
  });

  it("hands the runtime the plan, the model target, and the loop limits", async () => {
    const runtime = fakeRuntime([{ type: "completed", ok: true, stopReason: "end_turn" }]);
    const inst = instanceWith(runtime);
    const rec = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", system: "You are Wren.", model: "test-model", effort: "high", context: plan });
    await rec.until((e) => e.type === "turn.completed");
    const run = runtime.runs[0]!;
    expect(run.plan).toBe(plan);
    expect(run.system).toBe("You are Wren.");
    expect(run.effort).toBe("high");
    expect(run.model).toMatchObject({ id: "test-model", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test" });
    expect(run.limits).toEqual({ maxModelCalls: 32, maxToolCalls: 64, toolTimeoutMs: 180_000 });
    expect(run.tools).toEqual([]);
    rec.stop();
  });

  it("maps every runtime event onto the canonical bus", async () => {
    const runtime = fakeRuntime([
      { type: "model.call", call: 1 },
      { type: "delta", kind: "reasoning", text: "hm" },
      { type: "delta", kind: "text", text: "Hel" },
      { type: "delta", kind: "text", text: "lo" },
      { type: "tool.started", callId: "c1", name: "echo", inputSummary: "{}" },
      { type: "tool.completed", callId: "c1", name: "echo", ok: true, observation: { name: "echo", ok: true } },
      { type: "assistant", text: "Hello" },
      { type: "usage", input: 10, output: 2, cachedInput: 4 },
      { type: "completed", ok: true, stopReason: "end_turn" },
    ]);
    const inst = instanceWith(runtime);
    const rec = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", context: plan });
    await rec.until((e) => e.type === "turn.completed");
    const seen = rec.events.map((e: RuntimeEvent) => e.type);
    expect(seen).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "content.delta",
      "item.started",
      "item.completed",
      "item.completed",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(rec.events[2]).toMatchObject({ type: "content.delta", streamKind: "reasoning_text", delta: "hm" });
    expect(rec.events[5]).toMatchObject({ type: "item.started", itemType: "tool", title: "echo", itemId: "c1" });
    expect(rec.events[6]).toMatchObject({ type: "item.completed", itemType: "tool", ok: true });
    expect(rec.events[7]).toMatchObject({ type: "item.completed", itemType: "assistant_text", text: "Hello" });
    expect(rec.events[8]).toMatchObject({ type: "thread.token-usage.updated", input: 10, output: 2, cachedInput: 4 });
    expect(rec.events[9]).toMatchObject({ type: "turn.completed", ok: true, stopReason: null });
    rec.stop();
  });

  it("surfaces a loop cap as the turn's stop reason", async () => {
    const runtime = fakeRuntime([{ type: "completed", ok: true, stopReason: "max_tool_calls" }]);
    const inst = instanceWith(runtime);
    const rec = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", context: plan });
    const done = await rec.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "max_tool_calls" });
    rec.stop();
  });

  it("reports a runtime error and settles the turn as failed", async () => {
    const runtime = fakeRuntime([{ type: "error", message: "upstream 503" }, { type: "completed", ok: false, stopReason: "error" }]);
    const inst = instanceWith(runtime);
    const rec = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", context: plan });
    await rec.until((e) => e.type === "turn.completed");
    expect(rec.events.some((e) => e.type === "runtime.error" && e.message === "upstream 503")).toBe(true);
    expect(rec.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
    expect(inst.adapter.hasSession("t")).toBe(false);
    rec.stop();
  });

  it("never leaves a thread busy when the adapter itself throws", async () => {
    // run() is contracted not to reject; this is the belt for a bug in it
    const runtime = fakeRuntime([]);
    runtime.run = async () => {
      throw new Error("adapter bug");
    };
    const inst = instanceWith(runtime);
    const rec = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", context: plan });
    const done = await rec.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "error" });
    expect(inst.adapter.hasSession("t")).toBe(false);
    rec.stop();
  });

  it("allows one turn per thread at a time", async () => {
    const runtime = fakeRuntime([]);
    runtime.run = () => new Promise(() => {});
    const inst = instanceWith(runtime);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", context: plan });
    await expect(inst.adapter.sendTurn({ threadId: "t", text: "again", context: plan })).rejects.toThrow(/already running/);
  });

  it("delegates steer and interrupt to the runtime", async () => {
    const runtime = fakeRuntime([]);
    runtime.run = () => new Promise(() => {});
    const inst = instanceWith(runtime);
    await inst.adapter.sendTurn({ threadId: "t", text: "hi", context: plan });
    await expect(inst.adapter.steer!("t", "stop")).resolves.toBe(true);
    expect(runtime.steered).toEqual(["t:stop"]);
    await inst.adapter.interruptTurn("t");
    expect(runtime.interrupted).toEqual(["t"]);
  });

  it("reuses openai-compat's config envelope so the two engines are interchangeable", () => {
    const decoded = OpenMausRuntimeDriver.decodeConfig({ url: "https://openrouter.ai/api/v1/", apiKeyEnv: "MY_KEY", model: "m", provider: "groq" });
    expect(decoded).toEqual({ url: "https://openrouter.ai/api/v1", apiKeyEnv: "MY_KEY", key: undefined, model: "m", provider: "groq" });
  });

  it("says plainly that it is not a subscription login", () => {
    expect(OpenMausRuntimeDriver.metadata.access).toBe("custom");
    expect(OpenMausRuntimeDriver.install?.signInCommand).toMatch(/not a Claude or Codex login/);
    expect(OpenMausRuntimeDriver.install?.signInCommand).toMatch(/billed/);
  });
});

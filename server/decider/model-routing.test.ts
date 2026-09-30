import { describe, expect, it, vi } from "vitest";

import { STATIC_CLAUDE_MODELS } from "../drivers/claude.ts";
import { GrokDriver } from "../drivers/grok.ts";
import { MistralDriver } from "../drivers/mistral.ts";
import type { Decider } from "./index.ts";
import { MODEL_ROUTING } from "./jobs.ts";
import {
  LIGHTER_MODELS, MODEL_ROUTING_MIN_PROBABILITY, decideModelRoute, lighterModelFor, modelRoutingRequest, type ModelRoutingInput,
} from "./model-routing.ts";
import { relayAccepts } from "./relay.ts";
import type { DeciderResult, ScoreAnswer } from "./types.ts";

const INPUT: ModelRoutingInput = {
  message: "thanks! what's the capital of Portugal?",
  recent: [
    { from: "Milind", text: "Draft the launch post." },
    { from: "Maya", text: "Here is the draft." },
  ],
};

type Score = Decider["score"];

function answering(result: DeciderResult<ScoreAnswer>) {
  const score = vi.fn(async () => result) as unknown as Score & ReturnType<typeof vi.fn>;
  return { score };
}

const scored = (probabilities: number[]): DeciderResult<ScoreAnswer> => ({
  ok: true, provider: "jev", latencyMs: 250,
  answers: { type: "score", score: probabilities[1]! + 2 * probabilities[2]!, level: probabilities.indexOf(Math.max(...probabilities)), probabilities },
});

const claude = {
  driverKind: "claudeAgent",
  model: "claude-sonnet-5",
  catalog: STATIC_CLAUDE_MODELS,
  capabilities: { sessionModelSwitch: "in-session" as const },
  contextTokens: 2_000,
};

describe("lighterModelFor", () => {
  it("names the engine's lighter model from its table", () => {
    expect(lighterModelFor(claude)).toBe("claude-haiku-4-5");
    expect(lighterModelFor({ ...claude, model: "claude-opus-5-5" })).toBe("claude-haiku-4-5");
  });

  it("every lighter model is really in its engine's built-in catalog", () => {
    const catalogs: Record<string, { options: Array<{ id: string }> }> = {
      claudeAgent: STATIC_CLAUDE_MODELS, grok: GrokDriver.models, mistral: MistralDriver.models,
    };
    for (const [kind, entry] of Object.entries(LIGHTER_MODELS)) {
      const ids = catalogs[kind]!.options.map((option) => option.id);
      expect(ids).toContain(entry.light);
      for (const from of entry.from) expect(ids).toContain(from);
    }
  });

  it("does not apply to an engine that cannot switch in-session, or one with no table", () => {
    expect(lighterModelFor({ ...claude, capabilities: { sessionModelSwitch: "unsupported" } })).toBeNull();
    expect(lighterModelFor({ ...claude, driverKind: "codex", model: "gpt-5.5" })).toBeNull();
  });

  it("never swaps a custom, local or already-light model", () => {
    expect(lighterModelFor({ ...claude, model: "claude-haiku-4-5" })).toBeNull();
    expect(lighterModelFor({ ...claude, model: "ollama::qwen3:32b" })).toBeNull();
    expect(lighterModelFor({ ...claude, model: undefined })).toBeNull();
  });

  it("needs the lighter model in this engine's catalog (a managed catalog may leave it out)", () => {
    const managed = { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }] };
    expect(lighterModelFor({ ...claude, catalog: managed })).toBeNull();
  });

  it("keeps a long conversation on the bot's own model", () => {
    expect(lighterModelFor({ ...claude, contextTokens: 99_000 })).toBe("claude-haiku-4-5");
    expect(lighterModelFor({ ...claude, contextTokens: 150_000 })).toBeNull();
  });
});

describe("model routing request", () => {
  it("sends the message and the last four lines, clipped, with the contract's levels", () => {
    const recent = Array.from({ length: 7 }, (_, i) => ({ from: "Milind", text: `line ${i} ${"x".repeat(500)}` }));
    const { state, question } = modelRoutingRequest({ message: `${"m".repeat(3_000)}`, recent });
    expect(state.message.length).toBe(2_000);
    expect(state.recent_messages).toHaveLength(4);
    expect(state.recent_messages![0]!.text.startsWith("line 3")).toBe(true);
    expect(state.recent_messages!.every((line) => line.text.length <= 300)).toBe(true);
    expect(question).toEqual({ instructions: MODEL_ROUTING.instructions, levels: [...MODEL_ROUTING.levels!] });
    expect(relayAccepts("modelRouting", state, { answer: { type: "score", ...question } })).toBe(true);
  });

  it("leaves recent_messages out when there are none", () => {
    expect(modelRoutingRequest({ message: "hi", recent: [] }).state).toEqual({ message: "hi" });
  });

  it("a long non-ASCII worst case still fits Cloud Pro's relay", () => {
    const recent = Array.from({ length: 4 }, () => ({ from: "Приянка ".repeat(20), text: "長い返信です。".repeat(200) }));
    const { state, question } = modelRoutingRequest({ message: "请帮我重写这段话，".repeat(400), recent });
    expect(relayAccepts("modelRouting", state, { answer: { type: "score", ...question } })).toBe(true);
  });
});

describe("decideModelRoute", () => {
  it("Light at 0.8 or above runs on the lighter model", async () => {
    const decider = answering(scored([0.86, 0.12, 0.02]));
    await expect(decideModelRoute(decider, INPUT)).resolves.toEqual({ kind: "light", probability: 0.86 });
    expect(decider.score).toHaveBeenCalledWith("modelRouting", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: MODEL_ROUTING.timeoutMs }));
  });

  it("exactly 0.8 is enough; below stays on the bot's model, even when Light is the likeliest level", async () => {
    await expect(decideModelRoute(answering(scored([MODEL_ROUTING_MIN_PROBABILITY, 0.15, 0.05])), INPUT)).resolves.toMatchObject({ kind: "light" });
    await expect(decideModelRoute(answering(scored([0.79, 0.2, 0.01])), INPUT)).resolves.toEqual({ kind: "fallback", reason: "not_light" });
    await expect(decideModelRoute(answering(scored([0.05, 0.25, 0.7])), INPUT)).resolves.toEqual({ kind: "fallback", reason: "not_light" });
  });

  it("any failure, or a decider that throws, keeps the bot's model", async () => {
    for (const reason of ["timeout", "overloaded", "disabled", "job_off"] as const) {
      await expect(decideModelRoute(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ kind: "fallback", reason });
    }
    const score = vi.fn(async () => { throw new Error("boom"); }) as unknown as Score;
    await expect(decideModelRoute({ score }, INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("does not ask about an empty message", async () => {
    const decider = answering(scored([0.9, 0.1, 0]));
    await expect(decideModelRoute(decider, { message: " ", recent: [] })).resolves.toEqual({ kind: "fallback", reason: "no_message" });
    expect(decider.score).not.toHaveBeenCalled();
  });
});

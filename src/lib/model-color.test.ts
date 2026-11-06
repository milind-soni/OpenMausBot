import { describe, expect, it } from "vitest";
import { contrastRatio, toOklch } from "./color-contrast";
import { MODEL_PALETTE, modelColor, modelFamily, modelIdOf } from "./model-color";

const HEX = /^#[0-9a-f]{6}$/i;
const SURFACES = ["#ffffff", "#3a322d"] as const;
const hueGap = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function distance(a: string, b: string): number {
  const left = rgb(a);
  const right = rgb(b);
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

describe("model colours", () => {
  it("strips the driver from a group key, including a model id that carries a slash of its own", () => {
    expect(modelIdOf("model:codex/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(modelIdOf("model:opencodeGo/opencode-go/deepseek-v4.1-flash")).toBe("opencode-go/deepseek-v4.1-flash");
    expect(modelIdOf("model:claude-no-driver")).toBe("claude-no-driver");
    expect(modelIdOf("bot:b1")).toBe("bot:b1");
  });

  it("keeps the same colour for a model on every driver and period", () => {
    expect(modelColor("model:codex/gpt-6.1-sol")).toBe(modelColor("model:openai/gpt-6.1-sol"));
    expect(modelColor("model:opencodeGo/opencode-go/deepseek-v4.1-flash")).toBe(modelColor("model:deepseek/deepseek-v4.1-flash"));
    expect(modelColor("model:opencode/beam-free")).toBe(modelColor("model:opencode/beam"));
  });

  it("names the provider of the models seen in the ledger", () => {
    expect(modelFamily("model:opencodeGo/opencode-go/deepseek-v4.1-flash").id).toBe("deepseek");
    expect(modelFamily("model:codex/gpt-6.1-sol").id).toBe("openai");
    expect(modelFamily("model:opencodeGo/opencode/crouton-alpha-free").id).toBe("opencode");
    expect(modelFamily("model:grok/grok-4").id).toBe("xai");
    expect(modelFamily("model:claude/claude-sonnet-5").id).toBe("anthropic");
    expect(modelFamily("model:test/aya").id).toBe("cohere");
    expect(modelFamily("model:test/playa").id).toBe("unknown");
    expect(modelFamily("model:test/mystery-model").id).toBe("unknown");
  });

  it("gives each provider family its own colour", () => {
    const colors = [
      "model:claude/claude-sonnet-5",
      "model:codex/gpt-6.1-sol",
      "model:grok/grok-4",
      "model:opencode-go/deepseek-v4.1-flash",
      "model:opencode-go/glm-5.3-flash",
    ].map(modelColor);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("shades models from one provider close together but apart", () => {
    const pairs = [
      ["model:codex/gpt-6.1-sol", "model:codex/gpt-6-luna"],
      ["model:claude/claude-sonnet-5", "model:claude/claude-opus-5-5"],
      ["model:opencode/beam", "model:opencode/big-pickle"],
    ];
    for (const [left, right] of pairs) {
      const a = modelColor(left!);
      const b = modelColor(right!);
      expect(a, `${left} and ${right} should not share a tone`).not.toBe(b);
      const oa = toOklch(a);
      const ob = toOklch(b);
      expect(Math.abs(oa.l - ob.l), `${left} and ${right} should stay in one family`).toBeLessThan(0.09);
      expect(hueGap(oa.h, ob.h), `${left} and ${right} should stay in one family`).toBeLessThan(15);
      expect(distance(a, b), `${left} and ${right} should be visible side by side`).toBeGreaterThan(20);
    }
  });

  it("falls back to a stable tone for an unknown model", () => {
    const color = modelColor("model:acme/mystery-model");
    expect(color).toMatch(HEX);
    expect(modelColor("model:acme/mystery-model")).toBe(color);
    expect(modelColor("model:acme/Mystery-Model")).toBe(color);
  });

  it("keeps every family colour and every shade readable on the light and the dark ground", () => {
    for (const base of MODEL_PALETTE) {
      expect(base).toMatch(HEX);
      for (const surface of SURFACES) expect(contrastRatio(base, surface)).toBeGreaterThanOrEqual(3);
    }
    const models = [
      "claude-sonnet-5", "claude-opus-5-5", "gpt-6.1-sol", "gpt-6-luna", "grok-4", "deepseek-v4.1-flash",
      "gemini-3.8-pro", "qwen3", "mistral-large", "llama-4", "kimi-k2", "glm-5.3-flash", "minimax-m2",
      "command-r", "sonar-pro", "nova-pro", "phi-5", "nemotron", "crouton-alpha", "beam", "big-pickle", "mystery-model",
    ];
    for (const model of models) {
      const color = modelColor(`model:test/${model}`);
      expect(color, model).toMatch(HEX);
      for (const surface of SURFACES) expect(contrastRatio(color, surface), `${model} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});

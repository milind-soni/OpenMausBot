import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color-contrast";
import { MODEL_PALETTE, modelColor, modelIdOf } from "./model-color";

const HEX = /^#[0-9a-f]{6}$/i;

describe("model colours", () => {
  it("strips the driver from a group key, including a model id that carries a slash of its own", () => {
    expect(modelIdOf("model:codex/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(modelIdOf("model:opencodeGo/opencode-go/deepseek-v4.1-flash")).toBe("opencode-go/deepseek-v4.1-flash");
    expect(modelIdOf("model:claude-no-driver")).toBe("claude-no-driver");
    expect(modelIdOf("bot:b1")).toBe("bot:b1");
  });

  it("keeps the same colour for a model on every driver and period", () => {
    expect(modelColor("model:codex/gpt-6.1-sol")).toBe(modelColor("model:openai/gpt-6.1-sol"));
    expect(modelColor("model:opencodeGo/opencode-go/deepseek-v4.1-flash")).toBe("#4C7DFF");
  });

  it("gives the models seen in the ledger distinct family colours", () => {
    const colors = [
      modelColor("model:opencodeGo/opencode-go/deepseek-v4.1-flash"),
      modelColor("model:codex/gpt-6.1-sol"),
      modelColor("model:opencode/crouton-alpha-free"),
    ];
    expect(new Set(colors).size).toBe(3);
  });

  it("falls back to a stable palette tone for an unknown model", () => {
    const hue = modelColor("model:acme/mystery-model");
    expect(MODEL_PALETTE).toContain(hue);
    expect(modelColor("model:acme/mystery-model")).toBe(hue);
    expect(modelColor("model:acme/Mystery-Model")).toBe(hue);
  });

  it("keeps every tone a valid hex that reads on the light and the dark ground", () => {
    // The brightest bar track is white; the lightest one on a dark skin is #3a322d, the harder end for a bright tone.
    for (const color of MODEL_PALETTE) {
      expect(color).toMatch(HEX);
      expect(contrastRatio(color, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color, "#3a322d")).toBeGreaterThanOrEqual(3);
    }
  });
});

import { describe, expect, it } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  REPLAY_FLOOR,
  REPLAY_SHARE,
  budgetFor,
  contextLimitsFor,
  contextWindowFor,
  estimateTextTokens,
  makeContextBudget,
} from "./budget.ts";

describe("contextWindowFor", () => {
  it("prefers what the driver declared on the catalog entry", () => {
    const catalog: ModelCatalog = { default: "x", options: [{ id: "x", label: "X", contextWindow: 42_000 }] };
    expect(contextWindowFor("x", catalog)).toBe(42_000);
    expect(contextLimitsFor("x", catalog).limitsSource).toBe("catalog");
  });

  it("falls back to the pattern table, then a conservative default", () => {
    expect(contextWindowFor("claude-sonnet-5")).toBe(200_000);
    expect(contextWindowFor("gemini-3.6-flash")).toBe(1_000_000);
    expect(contextWindowFor("gpt-5.4")).toBe(200_000);
    expect(contextWindowFor("grok-4-fast")).toBe(256_000);
    expect(contextWindowFor("ollama/qwen3:8b")).toBe(32_000);
    expect(contextWindowFor("something-new")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("matches on the model part of an injected local id", () => {
    // local-inject.ts carries the host in the id
    expect(contextWindowFor("lmstudio/qwen3-ipv6")).toBe(32_000);
  });

  it("reports where the window came from, for diagnostics only", () => {
    expect(contextLimitsFor("claude-opus-5").limitsSource).toBe("pattern");
    expect(contextLimitsFor("something-new").limitsSource).toBe("default");
    expect(contextLimitsFor(undefined).limitsSource).toBe("default");
  });

  it("honours the OMB_CONTEXT_WINDOW dev override", () => {
    // how a short thread is made to compact during development
    process.env.OMB_CONTEXT_WINDOW = "10000";
    try {
      expect(contextWindowFor("claude-opus-5")).toBe(10_000);
    } finally {
      delete process.env.OMB_CONTEXT_WINDOW;
    }
  });
});

describe("budgetFor", () => {
  it("gives the replay a share of the window, not the remainder", () => {
    // a flat reserve would leave a small model permanently over the line
    expect(budgetFor(200_000)).toBe(200_000 * REPLAY_SHARE);
    expect(budgetFor(1_000_000)).toBe(1_000_000 * REPLAY_SHARE);
  });

  it("keeps a floor so a tiny window still gets the last few turns", () => {
    expect(budgetFor(8_000)).toBe(REPLAY_FLOOR);
    expect(budgetFor(1_000)).toBe(REPLAY_FLOOR);
  });

  it("assumes an unknown window is smallish rather than frontier", () => {
    expect(budgetFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW * REPLAY_SHARE);
  });

  it("gives a small model materially less than a large one", () => {
    expect(budgetFor(200_000)).toBeGreaterThan(budgetFor(32_000) * 2);
  });
});

describe("estimateTextTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTextTokens("12345678")).toBe(2);
    expect(estimateTextTokens("")).toBe(0);
  });

  it("is a heuristic, not a billing figure", () => {
    // provider-reported usage anchors the real number later
    expect(estimateTextTokens("a".repeat(4_000))).toBe(1_000);
  });
});

describe("makeContextBudget", () => {
  it("carries the window, the replay budget, and where the window came from", () => {
    expect(makeContextBudget({ limits: contextLimitsFor("claude-opus-5") })).toEqual({
      contextWindow: 200_000,
      historyTokens: 80_000,
      limitsSource: "pattern",
    });
  });
});

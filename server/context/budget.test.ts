import { describe, expect, it } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  contextLimitsFor,
  estimateContextTokens,
  makeContextBudget,
} from "./budget.ts";

const catalog = (over: Partial<ModelCatalog["options"][number]> & { id: string }): ModelCatalog => ({
  default: over.id,
  options: [{ label: over.id, ...over }],
});

describe("contextLimitsFor", () => {
  it("prefers what the driver declares, and says so", () => {
    const limits = contextLimitsFor("MiniMax-M3", catalog({ id: "MiniMax-M3", contextWindow: 1_000_000, maxOutputTokens: 8_192 }));
    expect(limits).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 8_192, limitsSource: "catalog" });
  });

  it("falls back to a family floor when the catalog is silent", () => {
    const limits = contextLimitsFor("claude-opus-5");
    expect(limits.contextWindow).toBe(200_000);
    expect(limits.limitsSource).toBe("pattern");
  });

  it("reads an explicit size out of the model id", () => {
    expect(contextLimitsFor("kimi-code/k3-256k").contextWindow).toBe(256_000);
  });

  it("does not mistake a parameter count for a context size", () => {
    // `llama-3.3-70b-instruct` is 70 BILLION PARAMETERS, not 70k of context
    const limits = contextLimitsFor("meta-llama/llama-3.3-70b-instruct");
    expect(limits.contextWindow).toBe(128_000);
    expect(limits.limitsSource).toBe("pattern");
  });

  it("says `default` rather than guessing at a model it does not recognise", () => {
    const limits = contextLimitsFor("some-vendor/brand-new-thing");
    expect(limits).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      limitsSource: "default",
    });
  });

  it("ignores a catalog entry for a different model", () => {
    expect(contextLimitsFor("claude-opus-5", catalog({ id: "gpt-5.4", contextWindow: 999 })).limitsSource).toBe("pattern");
  });

  it("treats a zero or missing window as undeclared", () => {
    expect(contextLimitsFor("claude-opus-5", catalog({ id: "claude-opus-5", contextWindow: 0 })).limitsSource).toBe("pattern");
  });

  it("resolves every shipped default model except the ones that name no model", () => {
    // The pattern table is the PRIMARY path — only two drivers declare a
    // window — so a real model reaching the 32k default is a regression, not
    // a harmless fallback. These two are the honest exceptions: they are
    // placeholders for "whatever the agent picks", so there is no identity
    // to size against and under-filling is the correct answer. They show as
    // limitsSource "default", which is exactly what diagnostics should say.
    const NAMES_NO_MODEL = new Set(["cursorAgent:auto", "customAcp:agent-default"]);
    const unresolved: string[] = [];
    for (const driver of BUILT_IN_DRIVERS) {
      const models = driver.models;
      if (!models?.default) continue;
      if (contextLimitsFor(models.default, models).limitsSource === "default") {
        unresolved.push(`${driver.driverKind}:${models.default}`);
      }
    }
    expect(unresolved.filter((entry) => !NAMES_NO_MODEL.has(entry))).toEqual([]);
  });

  it("under-fills rather than guessing when the id names no model", () => {
    for (const placeholder of ["auto", "agent-default"]) {
      const limits = contextLimitsFor(placeholder);
      expect(limits.limitsSource).toBe("default");
      expect(limits.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });
});

describe("estimateContextTokens", () => {
  it("approximates ASCII prose at three characters per token", () => {
    expect(estimateContextTokens("abcdef")).toBe(2);
  });

  it("never under-counts CJK, where a character is about a token", () => {
    const cjk = "这是一个很长的中文句子";
    expect(estimateContextTokens(cjk)).toBeGreaterThanOrEqual(cjk.length);
  });

  it("never under-counts Devanagari or Cyrillic", () => {
    for (const text of ["नमस्ते दुनिया", "привет мир"]) {
      const nonAscii = [...text].filter((c) => (c.codePointAt(0) ?? 0) > 127).length;
      expect(estimateContextTokens(text)).toBeGreaterThanOrEqual(nonAscii);
    }
  });

  it("counts an emoji at more than one token", () => {
    expect(estimateContextTokens("🙂")).toBe(2);
  });

  it("counts a CJK string far above what chars/3 would have", () => {
    const cjk = "中".repeat(300);
    expect(estimateContextTokens(cjk)).toBe(300);
    expect(estimateContextTokens(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 3));
  });

  it("is zero for an empty string", () => {
    expect(estimateContextTokens("")).toBe(0);
  });
});

describe("makeContextBudget", () => {
  const limits = { contextWindow: 200_000, maxOutputTokens: 8_192, limitsSource: "catalog" as const };

  it("leaves history what is left after system, tools, output, and safety", () => {
    const budget = makeContextBudget({ limits, systemTokens: 2_000, toolTokens: 3_000 });
    // output 8_192 (under the 25% cap), safety 10_000 (5%)
    expect(budget.historyTokens).toBe(200_000 - 2_000 - 3_000 - 8_192 - 10_000);
    expect(budget.limitsSource).toBe("catalog");
  });

  it("caps the output reserve at a quarter of the window", () => {
    // a model claiming 64k of output against an 8k window would otherwise
    // leave nothing at all for the conversation
    const budget = makeContextBudget({
      limits: { contextWindow: 8_000, maxOutputTokens: 64_000, limitsSource: "pattern" },
      systemTokens: 500,
      toolTokens: 0,
    });
    expect(budget.historyTokens).toBe(8_000 - 500 - 2_000 - 1_024);
    expect(budget.historyTokens).toBeGreaterThan(0);
  });

  it("keeps a floor of 1024 on the safety reserve for small windows", () => {
    const budget = makeContextBudget({
      limits: { contextWindow: 8_000, maxOutputTokens: 1_000, limitsSource: "pattern" },
      systemTokens: 0,
      toolTokens: 0,
    });
    expect(budget.historyTokens).toBe(8_000 - 1_000 - 1_024);
  });

  it("gives a small model materially less history than a large one", () => {
    const small = makeContextBudget({
      limits: { contextWindow: 8_000, maxOutputTokens: 4_096, limitsSource: "pattern" },
      systemTokens: 1_000,
      toolTokens: 500,
    });
    const large = makeContextBudget({ limits, systemTokens: 1_000, toolTokens: 500 });
    expect(large.historyTokens).toBeGreaterThan(small.historyTokens * 20);
  });

  it("never goes negative when the overheads exceed the window", () => {
    const budget = makeContextBudget({
      limits: { contextWindow: 8_000, maxOutputTokens: 4_096, limitsSource: "default" },
      systemTokens: 50_000,
      toolTokens: 20_000,
    });
    expect(budget.historyTokens).toBe(0);
  });
});

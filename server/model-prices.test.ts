import { describe, expect, it } from "vitest";
import { estimatePriceFor, ledgerCost, listPriceFor, listPrices } from "./model-prices.ts";
import type { PriceList } from "./prices.ts";

const OFFICIAL = [
  "https://developers.openai.com/",
  "https://platform.claude.com/",
  "https://docs.x.ai/",
  "https://ai.google.dev/",
  "https://platform.minimax.io/",
  "https://openrouter.ai/",
];

describe("built-in list prices", () => {
  it("names an official source and the day it was read for every entry, with sane numbers", () => {
    expect(Object.keys(listPrices()).length).toBeGreaterThan(20);
    for (const [model, entry] of Object.entries(listPrices())) {
      expect(model, "keys are lower-case").toBe(model.toLowerCase());
      expect(entry.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(OFFICIAL.some((prefix) => entry.source.startsWith(prefix)), `${model}: ${entry.source}`).toBe(true);
      for (const period of [entry, ...(entry.changes ?? [])]) {
        expect(period.inputPerMillion).toBeGreaterThan(0);
        expect(period.outputPerMillion).toBeGreaterThan(0);
        expect(period.cachedInputPerMillion ?? 0).toBeLessThanOrEqual(period.inputPerMillion);
      }
    }
  });

  it("looks models up case-insensitively, through catalog aliases, and follows announced price changes", () => {
    expect(listPriceFor("MiniMax-M3")).toEqual({ inputPerMillion: 0.3, cachedInputPerMillion: 0.06, outputPerMillion: 1.2 });
    expect(listPriceFor("gpt-5.5")).toEqual({ inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 });
    for (const fable of ["claude-fable-5-2", "anthropic/claude-fable-5.2"]) {
      expect(listPriceFor(fable), fable).toEqual({ inputPerMillion: 8, cachedInputPerMillion: 0.2, outputPerMillion: 40 });
    }
    expect(listPriceFor("gemini-3.8-flash-high", new Date("2026-12-31T23:00:00Z"))?.inputPerMillion).toBe(0.75);
    expect(listPriceFor("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))).toEqual({ inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 7.5 });
  });

  it("leaves models without a published price unpriced rather than guessing from a sibling", () => {
    for (const model of ["gpt-5.3-codex-spark", "grok-4", "grok-4-fast", "grok-3-mini", "meta-llama/llama-3.3-70b-instruct", "kimi-code/k3", "claude-fake", ""]) {
      expect(listPriceFor(model), model).toBeNull();
    }
  });
});

describe("what the ledger books for a settled turn", () => {
  const codex = { driverKind: "codex", model: "gpt-5.5", input: 1_000_000, cachedInput: 400_000, output: 100_000 };
  // 600k fresh at $5, 400k cached at $0.50, 100k out at $30
  const codexListCost = 0.6 * 5 + 0.4 * 0.5 + 0.1 * 30;

  it("keeps an engine's own cost as reported", () => {
    expect(ledgerCost({ ...codex, costUsd: 0.42 }, null)).toEqual({ costUsd: 0.42, costSource: "reported" });
    expect(ledgerCost({ ...codex, costUsd: 0 }, null)).toEqual({ costUsd: 0, costSource: "reported" });
  });

  it("estimates a turn that reported tokens but no price from the list", () => {
    const booked = ledgerCost({ ...codex, costUsd: null }, null);
    expect(booked.costSource).toBe("estimated");
    expect(booked.costUsd).toBeCloseTo(codexListCost, 9);
    expect(ledgerCost({ ...codex, costUsd: Number.NaN }, null).costUsd).toBeCloseTo(codexListCost, 9);
    expect(ledgerCost({ ...codex, costUsd: -1 }, null).costSource).toBe("estimated");
    expect(ledgerCost({ driverKind: "openaiCompat", model: "x-ai/grok-4.7", input: 1_000_000, output: 1_000_000, costUsd: null }, null).costUsd).toBeCloseTo(1.6 + 4.8, 9);
  });

  it("lets the operator's price for that model replace the list, and uses their default only for unlisted models", () => {
    const operator: PriceList = {
      "codex/gpt-5.5": { inputPerMillion: 1, outputPerMillion: 2 },
      "grok-4.7": { inputPerMillion: 3, outputPerMillion: 3 },
      default: { inputPerMillion: 10, outputPerMillion: 10 },
    };
    expect(ledgerCost({ ...codex, costUsd: null }, operator).costUsd).toBeCloseTo(1 * 1 + 0.1 * 2, 9);
    expect(estimatePriceFor({ driverKind: "grok", model: "grok-4.7" }, operator)).toEqual({ inputPerMillion: 3, outputPerMillion: 3 });
    expect(estimatePriceFor({ driverKind: "codex", model: "gpt-5.4" }, operator)?.inputPerMillion).toBe(2.5);
    expect(ledgerCost({ driverKind: "acp", model: "fake-model", input: 1_000_000, output: 0, costUsd: null }, operator)).toEqual({ costUsd: 10, costSource: "estimated" });
  });

  it("prices a Codex Fast row as its base model", () => {
    const fast = { ...codex, model: "gpt-5.5+priority", costUsd: null };
    expect(ledgerCost(fast, null)).toEqual(ledgerCost({ ...codex, costUsd: null }, null));
    const operator: PriceList = { "codex/gpt-5.5": { inputPerMillion: 1, outputPerMillion: 2 }, default: { inputPerMillion: 10, outputPerMillion: 10 } };
    expect(ledgerCost(fast, operator).costUsd).toBeCloseTo(1 * 1 + 0.1 * 2, 9);
    expect(estimatePriceFor({ driverKind: "codex", model: "gpt-5.5+priority" }, { "codex/gpt-5.5+priority": { inputPerMillion: 7, outputPerMillion: 7 } })?.inputPerMillion).toBe(7);
    expect(estimatePriceFor({ driverKind: "acp", model: "gpt-5.5+priority" }, null)).toBeNull();
    // A provider-qualified custom model keeps its `+`: it is not a Fast row, so another model's price must not apply.
    expect(estimatePriceFor({ driverKind: "codex", model: "local::foo+priority" }, { "codex/local::foo": { inputPerMillion: 9, outputPerMillion: 9 } })).toBeNull();
  });

  it("books an unpriced model as unpriced, not as free", () => {
    expect(ledgerCost({ driverKind: "grokAgent", model: "fake-model", input: 5000, output: 100, costUsd: null }, null)).toEqual({ costUsd: null });
    expect(ledgerCost({ driverKind: "codex", model: "gpt-5.3-codex-spark", input: 5000, output: 100, costUsd: undefined }, { "claude-sonnet-5": { inputPerMillion: 1, outputPerMillion: 1 } })).toEqual({ costUsd: null });
  });
});

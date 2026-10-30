import type { ModelPrice, PriceList, PricedTurn } from "./prices.ts";
import { billableFor } from "./prices.ts";

export interface ListPrice extends ModelPrice {
  asOf: string;
  source: string;
  changes?: ReadonlyArray<ModelPrice & { from: string }>;
}

const AS_OF = "2026-09-23";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const XAI = "https://docs.x.ai/developers/models";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";
const MINIMAX = "https://platform.minimax.io/docs/guides/pricing-paygo";
// OpenRouter's live list discounts some models despite its FAQ, so these are read from that list, not copied from vendors.
const OPENROUTER = "https://openrouter.ai/api/v1/models";

const price = (source: string, input: number, cached: number, output: number, extra: Partial<ListPrice> = {}): ListPrice => ({
  inputPerMillion: input,
  cachedInputPerMillion: cached,
  outputPerMillion: output,
  asOf: AS_OF,
  source,
  ...extra,
});

export const LIST_PRICES: Readonly<Record<string, ListPrice>> = {
  // OpenAI, Standard tier, short context (<272K input tokens).
  "gpt-6-astra": price(OPENAI, 10, 1, 50),
  // Labelled promotional pricing on the source page, with no end date given.
  "gpt-5.6-sol": price(OPENAI, 4, 0.4, 20),
  "gpt-5.6-terra": price(OPENAI, 2, 0.2, 12),
  "gpt-5.6-luna": price(OPENAI, 0.2, 0.02, 1.2),
  "gpt-5.5": price(OPENAI, 5, 0.5, 30),
  "gpt-5.4": price(OPENAI, 2.5, 0.25, 15),
  "gpt-5.4-mini": price(OPENAI, 0.75, 0.075, 4.5),
  "gpt-5.3-codex": price(OPENAI, 1.75, 0.175, 14),
  // gpt-5.3-codex-spark has no published API price: unpriced.

  // Anthropic: base input, cache hit, output. No long-context tier, except that a Haiku 5.5 prompt over 100,000 tokens costs 5x.
  "claude-fable-5-1": price(ANTHROPIC, 10, 0.25, 50),
  "claude-fable-5": price(ANTHROPIC, 10, 1, 50),
  "claude-opus-5": price(ANTHROPIC, 5, 0.5, 25),
  "claude-sonnet-5": price(ANTHROPIC, 2, 0.2, 10),
  "claude-haiku-5-5": price(ANTHROPIC, 0.1, 0.01, 0.5, { asOf: "2026-10-27" }),
  "claude-haiku-4-5": price(ANTHROPIC, 1, 0.1, 5),
  "claude-haiku-4-5-20251001": price(ANTHROPIC, 1, 0.1, 5),

  // xAI, under 200k prompt tokens. grok-4, grok-4-fast and grok-3-mini are retired or unlisted: unpriced.
  "grok-4.7": price(XAI, 2, 0.5, 6),
  "grok-4.6": price(XAI, 2, 0.5, 6),
  "grok-4.5": price(XAI, 2, 0.3, 6),

  // Google Gemini API, paid tier, prompts up to 200k tokens.
  "gemini-2.5-pro": price(GOOGLE, 1.25, 0.125, 10),
  "gemini-2.5-flash": price(GOOGLE, 0.3, 0.03, 2.5),
  "gemini-3.1-pro-preview": price(GOOGLE, 2, 0.2, 12),
  "gemini-3.8-flash": price(GOOGLE, 0.75, 0.075, 3.75, {
    changes: [{ from: "2027-01-01", inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 7.5 }],
  }),

  // MiniMax, international pay-as-you-go, Standard, M3 up to 512k input tokens, at the price charged (shown as 50% off).
  "minimax-m3": price(MINIMAX, 0.3, 0.06, 1.2),
  "minimax-m2.7": price(MINIMAX, 0.3, 0.06, 1.2),
  "minimax-m2.7-highspeed": price(MINIMAX, 0.6, 0.06, 2.4),

  // OpenRouter ids, as its live model list prices them.
  "openai/gpt-6-astra": price(OPENROUTER, 10, 1, 50),
  "openai/gpt-5.6-sol": price(OPENROUTER, 2, 0.2, 10),
  "openai/gpt-5.6-terra": price(OPENROUTER, 2, 0.2, 12),
  "openai/gpt-5.6-luna": price(OPENROUTER, 0.2, 0.02, 1.2),
  "openai/gpt-5.5": price(OPENROUTER, 5, 0.5, 30),
  "openai/gpt-5.4": price(OPENROUTER, 2.5, 0.25, 15),
  "openai/gpt-5.4-mini": price(OPENROUTER, 0.75, 0.075, 4.5),
  "openai/gpt-5.3-codex": price(OPENROUTER, 1.75, 0.175, 14),
  "anthropic/claude-fable-5.1": price(OPENROUTER, 10, 0.25, 50),
  "anthropic/claude-fable-5": price(OPENROUTER, 10, 1, 50),
  "anthropic/claude-opus-5": price(OPENROUTER, 5, 0.5, 25),
  "anthropic/claude-sonnet-5": price(OPENROUTER, 2, 0.2, 10),
  "anthropic/claude-haiku-4.5": price(OPENROUTER, 1, 0.1, 5),
  "x-ai/grok-4.7": price(OPENROUTER, 1.6, 0.4, 4.8),
  "x-ai/grok-4.6": price(OPENROUTER, 2, 0.5, 6),
  "x-ai/grok-4.5": price(OPENROUTER, 2, 0.3, 6),
  "google/gemini-2.5-pro": price(OPENROUTER, 1.25, 0.125, 10),
  "google/gemini-2.5-flash": price(OPENROUTER, 0.3, 0.03, 2.5),
  "google/gemini-3.1-pro-preview": price(OPENROUTER, 2, 0.2, 12),
  "google/gemini-3.8-flash": price(OPENROUTER, 0.75, 0.075, 3.75),
  "minimax/minimax-m3": price(OPENROUTER, 0.3, 0.06, 1.2),
  "minimax/minimax-m2.7": price(OPENROUTER, 0.3, 0.06, 1.2),
};

/** The Antigravity picker offers Gemini 3.8 Flash at three thinking levels. */
const ALIASES: Readonly<Record<string, string>> = {
  "gemini-3.8-flash-high": "gemini-3.8-flash",
  "gemini-3.8-flash-medium": "gemini-3.8-flash",
  "gemini-3.8-flash-low": "gemini-3.8-flash",
};

export function listPriceFor(model: string, at: Date = new Date()): ModelPrice | null {
  const key = model.trim().toLowerCase();
  const entry = LIST_PRICES[ALIASES[key] ?? key];
  if (!entry) return null;
  const day = at.toISOString().slice(0, 10);
  const change = entry.changes?.filter((candidate) => candidate.from <= day).at(-1);
  const current = change ?? entry;
  return {
    inputPerMillion: current.inputPerMillion,
    outputPerMillion: current.outputPerMillion,
    ...(current.cachedInputPerMillion !== undefined ? { cachedInputPerMillion: current.cachedInputPerMillion } : {}),
  };
}

export type CostSource = "reported" | "estimated";

export function estimatePriceFor(turn: Pick<PricedTurn, "driverKind" | "model">, operatorPrices: PriceList | null, at: Date = new Date()): ModelPrice | null {
  return operatorPrices?.[`${turn.driverKind}/${turn.model}`] ?? operatorPrices?.[turn.model] ??
    listPriceFor(turn.model, at) ?? operatorPrices?.default ?? null;
}

export function ledgerCost(
  turn: PricedTurn & { costUsd: number | null | undefined },
  operatorPrices: PriceList | null,
  at: Date = new Date(),
): { costUsd: number | null; costSource?: CostSource } {
  if (typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) && turn.costUsd >= 0) {
    return { costUsd: turn.costUsd, costSource: "reported" };
  }
  const unit = estimatePriceFor(turn, operatorPrices, at);
  if (!unit) return { costUsd: null };
  return { costUsd: billableFor(turn, { [turn.model]: unit }), costSource: "estimated" };
}

/** Exact per-model pricing metadata. Missing metadata is meaningful: callers
 * must show an unknown cost instead of borrowing another model's rate. */
export interface ModelPricing {
  readonly inputUsdPerMillion: number;
  /** Rate for input tokens the provider reports as a cache read. */
  readonly cachedInputUsdPerMillion?: number;
  readonly outputUsdPerMillion: number;
  readonly source: string;
  /** Long-context pricing applies to the whole request once this boundary is crossed. */
  readonly longContext?: {
    readonly thresholdTokens: number;
    readonly inputMultiplier: number;
    readonly outputMultiplier: number;
  };
}

export interface TokenUsageDetails {
  readonly input: number;
  readonly output: number;
  /** Cache-read input tokens, when the provider exposes the breakdown. */
  readonly cachedInput?: number;
  /** Prompt/context size when the provider reports it separately. */
  readonly contextTokens?: number;
}

export interface ModelCostEstimate {
  readonly usd: number;
  /** False means a provider detail needed for exact billing was absent. */
  readonly precision: "exact" | "qualified";
  readonly qualification?: "cached_input_not_reported" | "long_context_not_reported";
}

function finiteNonNegative(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Calculate a model estimate without pretending absent provider detail is zero. */
export function estimateModelCost(pricing: ModelPricing, usage: TokenUsageDetails): ModelCostEstimate | null {
  const input = finiteNonNegative(usage.input);
  const output = finiteNonNegative(usage.output);
  if (input === null || output === null) return null;
  const inputRate = finiteNonNegative(pricing.inputUsdPerMillion);
  const cachedRate = finiteNonNegative(pricing.cachedInputUsdPerMillion);
  const outputRate = finiteNonNegative(pricing.outputUsdPerMillion);
  if (inputRate === null || outputRate === null) return null;
  const cached = finiteNonNegative(usage.cachedInput);
  const cacheBreakdownKnown = cached !== null && cached <= input && cachedRate !== null;
  const uncached = cacheBreakdownKnown ? input - cached : input;
  const longContext = pricing.longContext;
  const contextTokens = finiteNonNegative(usage.contextTokens);
  const isLong = longContext !== undefined && (contextTokens ?? input) >= longContext.thresholdTokens;
  const inputMultiplier = isLong ? longContext!.inputMultiplier : 1;
  const outputMultiplier = isLong ? longContext!.outputMultiplier : 1;
  const inputUsd = (uncached * inputRate + (cacheBreakdownKnown ? cached * cachedRate : 0)) * inputMultiplier;
  const outputUsd = output * outputRate * outputMultiplier;
  // Input tokens are the prompt size for the long-context boundary; a
  // separate contextTokens field merely makes that provenance explicit.
  const qualification = !cacheBreakdownKnown && cachedRate !== null ? "cached_input_not_reported" : undefined;
  const usd = (inputUsd + outputUsd) / 1_000_000;
  if (qualification) return { usd, precision: "qualified", qualification };
  return { usd, precision: "exact" };
}

export const GPT_5_6_SOL_PRICING: ModelPricing = {
  inputUsdPerMillion: 4,
  cachedInputUsdPerMillion: 0.4,
  outputUsdPerMillion: 20,
  longContext: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  source: "Shane rate card · 2026-08-28",
};

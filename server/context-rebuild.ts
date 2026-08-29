import type { ModelCatalog } from "./contracts.ts";

const CHARS_PER_TOKEN = 4;
const FALLBACK_CONTEXT_TOKENS = 200_000;
const MIN_CONTEXT_TOKENS = 32_000;
const MAX_CONTEXT_TOKENS = 2_000_000;

export interface ContextReplayBudget {
  contextWindowTokens: number;
  triggerChars: number;
  targetChars: number;
  source: "catalog" | "label" | "fallback";
}

function boundedTokens(value: number): number {
  return Math.max(MIN_CONTEXT_TOKENS, Math.min(MAX_CONTEXT_TOKENS, Math.trunc(value)));
}

function tokensFromLabel(value: string): number | null {
  const normalized = value.toLowerCase().replaceAll(",", "");
  const million = normalized.match(/(?:^|\D)(\d+(?:\.\d+)?)\s*(?:m|million)(?:\D|$)/);
  if (million) return boundedTokens(Number(million[1]) * 1_000_000);
  const thousand = normalized.match(/(?:^|\D)(\d+(?:\.\d+)?)\s*k(?:\D|$)/);
  return thousand ? boundedTokens(Number(thousand[1]) * 1_000) : null;
}

/**
 * Resolve a deliberately late replay-compaction threshold. The full chat is
 * always retained in storage; this budget only bounds a fresh provider replay
 * after a model switch, rewind, or lost native session.
 */
export function contextReplayBudget(model: string, catalog: ModelCatalog): ContextReplayBudget {
  const option = catalog.options.find((candidate) => candidate.id === model);
  const catalogTokens = option?.contextWindow;
  let contextWindowTokens: number;
  let source: ContextReplayBudget["source"];
  if (typeof catalogTokens === "number" && Number.isFinite(catalogTokens) && catalogTokens > 0) {
    contextWindowTokens = boundedTokens(catalogTokens);
    source = "catalog";
  } else {
    const labelled = tokensFromLabel(`${model} ${option?.label ?? ""}`);
    contextWindowTokens = labelled ?? FALLBACK_CONTEXT_TOKENS;
    source = labelled === null ? "fallback" : "label";
  }

  // Leave 20% for system instructions, tools, current input, and output. Once
  // pressure is real, compact to 65% to avoid doing it again on every turn.
  return {
    contextWindowTokens,
    triggerChars: Math.trunc(contextWindowTokens * CHARS_PER_TOKEN * 0.8),
    targetChars: Math.trunc(contextWindowTokens * CHARS_PER_TOKEN * 0.65),
    source,
  };
}

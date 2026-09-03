// How much of a model's window the rebuild may take, and how big that
// window is.
//
// This is the original pi.dev-derived logic, restored deliberately: the
// budget is a SHARE of the window rather than a subtraction of measured
// parts. A flat reserve would leave an 8k model permanently over the line,
// and an unknown model is assumed small-ish rather than frontier — over-
// estimating a window puts a rebuild over the limit, while under-estimating
// only summarizes earlier.
import type { ModelCatalog } from "../contracts.ts";
import type { ContextBudget, ContextLimitsSource } from "./types.ts";

/** ~4 chars per token plus a little per entry for role framing. A heuristic
 * on purpose: provider-reported usage anchors it later. */
const CHARS_PER_TOKEN = 4;
export const ENTRY_OVERHEAD = 4;

export const estimateTextTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** The replay may take this much of the window; the rest is the system
 * prompt, the tools, and room to answer. */
export const REPLAY_SHARE = 0.4;
export const REPLAY_FLOOR = 4_000;
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function budgetFor(contextWindow: number | undefined): number {
  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return Math.max(REPLAY_FLOOR, Math.floor(window * REPLAY_SHARE));
}

/** Drivers can declare a window on their catalog entries; most don't, so a
 * small pattern table over the model id covers the engines OpenMausBot
 * ships with. */
const TABLE: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/claude/i, 200_000],
  [/^(gpt-5|o[34]|codex)/i, 200_000],
  [/^gpt-4\.1/i, 1_000_000],
  [/^gpt-4o/i, 128_000],
  [/grok-4/i, 256_000],
  [/grok/i, 128_000],
  [/kimi|moonshot/i, 128_000],
  [/minimax/i, 200_000],
  [/qwen|deepseek|llama|mistral|gemma|phi/i, 32_000],
];

/** Dev/test override: pretend every model has this window, to watch
 * compaction happen on a short thread. */
const forcedWindow = () => Number(process.env.OMB_CONTEXT_WINDOW) || 0;

export interface ContextLimits {
  contextWindow: number;
  /** whether the window was declared, matched, forced, or defaulted —
   * diagnostics only, it does not change the budget. */
  limitsSource: ContextLimitsSource;
}

export function contextLimitsFor(modelId: string | undefined, catalog?: ModelCatalog): ContextLimits {
  const forced = forcedWindow();
  if (forced > 0) return { contextWindow: forced, limitsSource: "catalog" };
  if (!modelId) return { contextWindow: DEFAULT_CONTEXT_WINDOW, limitsSource: "default" };
  const declared = catalog?.options.find((option) => option.id === modelId)?.contextWindow;
  if (declared) return { contextWindow: declared, limitsSource: "catalog" };
  // injected local models carry the host in the id (see local-inject.ts);
  // match on the model part too
  const bare = modelId.split("/").pop() ?? modelId;
  for (const [pattern, size] of TABLE) {
    if (pattern.test(modelId) || pattern.test(bare)) return { contextWindow: size, limitsSource: "pattern" };
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, limitsSource: "default" };
}

export function contextWindowFor(modelId: string | undefined, catalog?: ModelCatalog): number {
  return contextLimitsFor(modelId, catalog).contextWindow;
}

/** The budget as the rest of the context layer consumes it. */
export function makeContextBudget(input: { limits: ContextLimits }): ContextBudget {
  return {
    contextWindow: input.limits.contextWindow,
    historyTokens: budgetFor(input.limits.contextWindow),
    limitsSource: input.limits.limitsSource,
  };
}

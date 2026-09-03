// How much history a turn may carry, and how confident we are about it.
//
// Everything here is planning-only and deliberately biased to UNDER-fill the
// window. Over-filling is a hard provider error that costs the user their
// turn; under-filling costs some history the next turn can carry instead.
import type { ModelCatalog } from "../contracts.ts";
import type { ContextBudget, ContextLimitsSource } from "./types.ts";

/** Used when nothing else is known. Small enough to be safe on any engine. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/** Per-item overhead: role marker, separators, and the framing a driver adds
 * when rendering one semantic unit into its own protocol. */
export const FRAMING_TOKENS_PER_ITEM = 8;

export interface ContextLimits {
  contextWindow: number;
  maxOutputTokens: number;
  limitsSource: ContextLimitsSource;
}

/** Conservative FLOORS by model family — not spec sheets.
 *
 * A driver that knows its real window declares `contextWindow` in its
 * catalog, and the catalog always wins. These exist for the majority of
 * engines that declare nothing, where the only safe guess is a low one: a
 * floor that is too low loses some history, a ceiling that is too high loses
 * the whole turn. Ordered most specific first. */
const FAMILY_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude|anthropic/i, 200_000],
  [/^gpt-5|codex/i, 128_000],
  [/^gpt-4|gpt-oss/i, 128_000],
  [/^gemini/i, 128_000],
  [/^grok/i, 128_000],
  [/kimi|moonshot/i, 128_000],
  [/minimax/i, 128_000],
  [/^glm|zai/i, 128_000],
  [/llama-?3\.[23]|llama-?4/i, 128_000],
  [/^qwen|qwen3/i, 32_768],
  [/mistral|mixtral/i, 32_768],
  [/^gemma/i, 8_192],
];

/** An explicit size in the id — `kimi-code/k3-256k`, `some-model-32k`. The
 * negative lookahead keeps parameter counts out: `llama-3.3-70b` has no `k`
 * suffix, and `27B` never matches. */
const EXPLICIT_SIZE = /(?:^|[^a-z0-9])(\d{1,4})k(?![a-z0-9])/i;

function windowFromPattern(modelId: string): number | undefined {
  const explicit = EXPLICIT_SIZE.exec(modelId);
  if (explicit) {
    const thousands = Number(explicit[1]);
    // 8k-1024k is the plausible range; anything else is a coincidence in
    // the id rather than a declared size
    if (thousands >= 8 && thousands <= 1_024) return thousands * 1_000;
  }
  for (const [pattern, window] of FAMILY_WINDOWS) {
    if (pattern.test(modelId)) return window;
  }
  return undefined;
}

/** What the target model can take, and where that came from. */
export function contextLimitsFor(modelId: string | undefined, catalog?: ModelCatalog): ContextLimits {
  const id = modelId?.trim() ?? "";
  const declared = catalog?.options.find((option) => option.id === id);

  if (declared?.contextWindow && declared.contextWindow > 0) {
    return {
      contextWindow: declared.contextWindow,
      maxOutputTokens: declared.maxOutputTokens && declared.maxOutputTokens > 0
        ? declared.maxOutputTokens
        : DEFAULT_MAX_OUTPUT_TOKENS,
      limitsSource: "catalog",
    };
  }

  const patterned = id ? windowFromPattern(id) : undefined;
  if (patterned) {
    return { contextWindow: patterned, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, limitsSource: "pattern" };
  }

  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    limitsSource: "default",
  };
}

/** A planning estimate of the tokens a string costs. Never a billing figure.
 *
 * `chars / 3` holds for ASCII prose and badly under-counts everything else:
 * in CJK, Devanagari, Thai, and Cyrillic one character is frequently a whole
 * token, and an emoji is often two or more. Under-counting is the dangerous
 * direction — it overflows the real window — so non-ASCII is counted at
 * full weight and astral code points at double. */
export function estimateContextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 128) ascii += 1;
    else if (codePoint > 0xff_ff) wide += 2;
    else wide += 1;
  }
  return Math.ceil(ascii / 3) + wide;
}

export interface BudgetInput {
  limits: ContextLimits;
  /** measured cost of the system prompt, persona, and memory section. */
  systemTokens: number;
  /** measured or estimated cost of the tool schemas this turn mounts. */
  toolTokens: number;
}

/** Split the window into what is spoken for and what history may use. */
export function makeContextBudget(input: BudgetInput): ContextBudget {
  const { contextWindow, maxOutputTokens, limitsSource } = input.limits;
  // Never reserve more than a quarter of the window for output: a model that
  // declares a large maxOutputTokens against a small window would otherwise
  // leave no room for the conversation it is answering.
  const outputReserve = Math.min(maxOutputTokens, Math.floor(contextWindow * 0.25));
  const safetyReserve = Math.max(1_024, Math.floor(contextWindow * 0.05));
  const spokenFor = Math.max(0, input.systemTokens) + Math.max(0, input.toolTokens) + outputReserve + safetyReserve;
  return {
    contextWindow,
    maxOutputTokens,
    historyTokens: Math.max(0, contextWindow - spokenFor),
    limitsSource,
  };
}

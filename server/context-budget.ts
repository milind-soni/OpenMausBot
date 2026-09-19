// Context budget (docs/superpowers/specs/2026-09-15-phase-1-long-threads-design.md).
//
// How much context a thread may carry before the harness compacts it, and
// whether the last turn crossed that line. The size is the input tokens the
// engine reported for the last turn (Phase 0 books them per task); only an
// engine that reports nothing falls back to a byte estimate. The window and
// the share-of-window rule are lifted from #759 (closed): a share rather
// than a subtraction keeps an 8k local model above water, and an unknown
// model is assumed mid-sized rather than frontier — over-estimating a window
// overflows, under-estimating only compacts earlier.
import type { ModelCatalog } from "./contracts.ts";
import { modelContextWindow } from "./model-context-window.ts";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Measured, not guessed. A compaction is the most expensive turn in a
 * thread: it starts a fresh session, so the provider's prompt cache is
 * thrown away and that turn pays full price for a prefix the turns around
 * it were reading at a steep discount. On a real Sonnet thread the
 * compaction turns cost about 3x their neighbours (cache hit 72% against
 * 99%) and took two to three turns to earn it back. Compacting early is
 * therefore not free, which is what the original 0.6 assumed — so the
 * share sits high enough that a thread only pays when it has to. */
export const DEFAULT_COMPACT_SHARE = 0.8;
export const COMPACT_FLOOR = 8_000;

export interface ContextWindow {
  contextWindow: number;
  source: "forced" | "reported" | "catalog" | "pattern" | "default";
}

/** Forced for tests; else what the engine itself reported for this task
 * (usage.context.window, main's reading); else the catalog; else main's
 * pattern table over the model id (model-context-window.ts); else 128k. */
export function contextWindowFor(modelId: string | undefined, catalog?: ModelCatalog, reported?: number): ContextWindow {
  const forced = Number(process.env.OMB_CONTEXT_WINDOW) || 0;
  if (forced > 0) return { contextWindow: forced, source: "forced" };
  if (reported && reported > 0) return { contextWindow: reported, source: "reported" };
  if (!modelId) return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
  const declared = catalog?.options.find((option) => option.id === modelId)?.contextWindow;
  if (declared) return { contextWindow: declared, source: "catalog" };
  // injected local models carry the host in the id; try the model part too
  const bare = modelId.split("/").pop() ?? modelId;
  const pattern = modelContextWindow(modelId) ?? modelContextWindow(bare);
  if (pattern) return { contextWindow: pattern, source: "pattern" };
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
}

/** How far under an engine's own compaction point the harness aims, so the
 * two can never land on the same turn. */
export const NATIVE_COMPACT_MARGIN = 0.9;

/** `compactAt` below 1 is a share of the window; at or above 1 it is an
 * absolute token count. Never under the floor.
 *
 * `nativeCompactAt` is where the ENGINE compacts its own session, when it
 * does (Claude's `--autocompact`, a fixed 200k by default). The share is a
 * share of the MODEL's window, so on a large-window model it lands well
 * above that fixed point — the engine then compacts first, the harness never
 * runs, and no record is written. The thread's history exists only inside
 * that provider session after that: invisible in the app, and gone when the
 * thread moves to another model. So the budget is held under it. */
export function compactBudget(compactAt: number | undefined, contextWindow: number, nativeCompactAt?: number): number {
  const raw = compactAt === undefined ? contextWindow * DEFAULT_COMPACT_SHARE
    : compactAt < 1 ? contextWindow * compactAt
    : compactAt;
  const bounded = nativeCompactAt && nativeCompactAt > 0
    ? Math.min(raw, nativeCompactAt * NATIVE_COMPACT_MARGIN)
    : raw;
  return Math.max(COMPACT_FLOOR, Math.floor(bounded));
}

/** ~4 bytes per token: a fallback for engines that report no usage. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** `contextTokens` is what filled the model's window on the last model
 * call (main's usage.context.tokens): the figure that predicts the next
 * message. `lastTurnInput` (the last turn's summed input) stands in where a
 * driver reports no context reading; the byte estimate only where it
 * reports no usage at all. */
/** After a compaction the thread's context has a floor: the system prompt
 * and the kept exchanges. A budget below that floor would compact on every
 * turn for nothing, so a second compaction waits until the context has
 * grown this much past the first reading after the last one. */
export const REGROWTH_FACTOR = 1.25;

export function shouldCompact(input: { contextTokens?: number; lastTurnInput?: number; estimatedTokens: number; budget: number; floor?: number }): boolean {
  const size = input.contextTokens && input.contextTokens > 0 ? input.contextTokens
    : input.lastTurnInput && input.lastTurnInput > 0 ? input.lastTurnInput
    : input.estimatedTokens;
  if (size < input.budget) return false;
  if (input.floor && input.floor > 0 && size < input.floor * REGROWTH_FACTOR) return false;
  return true;
}

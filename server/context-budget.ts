import type { ModelCatalog, ProviderInstance } from "./contracts.ts";
import { modelContextWindow } from "./model-context-window.ts";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function contextWindowFor(model: string | undefined, catalog?: ModelCatalog, reported?: number): number {
  if (positive(reported)) return reported;
  const declared = catalog?.options.find((option) => option.id === model)?.contextWindow;
  if (positive(declared)) return declared;
  const inferred = model ? modelContextWindow(model) : undefined;
  return positive(inferred) ? inferred : DEFAULT_CONTEXT_WINDOW;
}

/** Compatible usage snapshots can outlive a changed endpoint override;
 * compaction must consult that endpoint's current serving catalog. */
export function compactionContextWindow(model: string, instance: Pick<ProviderInstance, "driverKind" | "models">, reported?: number): number {
  return contextWindowFor(model, instance.models, instance.driverKind === "openai-compat" ? undefined : reported);
}

/** A "meter" reading (an ACP agent's own usage_update) is shown only; it never times OpenMausBot's compaction. */
export function compactionReading<T>(capabilities: { contextReading?: "meter" } | undefined, reading: T | undefined): T | undefined {
  return capabilities?.contextReading === "meter" ? undefined : reading;
}

/** Leave headroom even for a small local model: an 8k floor would make compaction unreachable on an 8k window. */
export function compactBudget(window: number, compactAt?: number, nativeCompactAt?: number): number {
  if (!positive(window)) throw new Error("invalid model context window");
  const configured = positive(compactAt) ? (compactAt < 1 ? window * compactAt : compactAt) : window * 0.8;
  return Math.max(1, Math.floor(Math.min(configured, window * 0.9, positive(nativeCompactAt) ? nativeCompactAt * 0.9 : Infinity)));
}

export function shouldCompact(input: { contextTokens?: number; estimatedBytes: number; budget: number; floor?: number; window: number; nativeCompactAt?: number }): boolean {
  // Summed input across tool rounds is NOT a context-window measurement.
  const size = positive(input.contextTokens) ? input.contextTokens : Math.ceil(input.estimatedBytes / 4);
  const ceiling = compactBudget(input.window, input.window, input.nativeCompactAt);
  const threshold = Math.min(ceiling, positive(input.floor) ? Math.max(input.budget, input.floor * 1.25) : input.budget);
  return size >= threshold;
}

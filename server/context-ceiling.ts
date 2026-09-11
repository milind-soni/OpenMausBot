// Real context ceiling for the model on this machine.
//
// Advertised n_ctx (catalog / host /api/ps / OPENMAUSBOT_CONTEXT_CEILING) is
// the hard architectural cap. RAM is a clamp, not a tape measure: KV bytes
// per token vary by architecture, and Apple unified memory mixes weights
// with the rest of the OS. The result is always the min of those signals.
import { cpus, freemem, totalmem } from "node:os";

import { AUTO_COMPACT_AROUND_TOKENS, COMPACTION_RATIO } from "../shared/compact-around.ts";
import { decodeInjectId } from "./drivers/local-inject.ts";

export { AUTO_COMPACT_AROUND_TOKENS, COMPACTION_RATIO };
export const MIN_CONTEXT_WINDOW = 2_048;
export const DEFAULT_LOCAL_WINDOW = 8_192;
export const DEFAULT_CLOUD_WINDOW = 128_000;
/** Conservative KV estimate: under-count tokens (compact earlier) rather
 * than over-count and OOM. */
export const KV_BYTES_PER_TOKEN = 512;
export const RAM_SAFETY_BYTES = 1.5 * 1024 * 1024 * 1024;
export const RAM_PRESSURE_FREE_BYTES = 1024 * 1024 * 1024;
export const RAM_PRESSURE_FREE_RATIO = 0.08;

export interface MemoryProbe {
  totalBytes: number;
  freeBytes: number;
}

export interface MachineProbe {
  totalBytes: number;
  cpuBrand: string;
}

export interface ContextCeiling {
  tokens: number;
  /** What bound the result. `clamped` means RAM was tighter than advertised.
   * `compact` is the Auto huge-window cap or a Compact around preset. */
  source: "advertised" | "default" | "ram" | "clamped" | "override" | "compact";
}

export function probeMemory(
  impl: { totalmem: () => number; freemem: () => number } = { totalmem, freemem },
): MemoryProbe {
  const totalBytes = Math.max(0, impl.totalmem());
  const freeBytes = Math.max(0, Math.min(totalBytes, impl.freemem()));
  return { totalBytes, freeBytes };
}

export function probeMachine(
  impl: { totalmem?: () => number; cpuBrand?: () => string } = {},
): MachineProbe {
  const totalBytes = Math.max(0, (impl.totalmem ?? totalmem)());
  const cpuBrand = (impl.cpuBrand ?? (() => cpus()[0]?.model ?? ""))();
  return { totalBytes, cpuBrand };
}

export function memoryPressure(memory: MemoryProbe): boolean {
  if (memory.totalBytes <= 0) return false;
  if (memory.freeBytes < RAM_PRESSURE_FREE_BYTES) return true;
  return memory.freeBytes / memory.totalBytes < RAM_PRESSURE_FREE_RATIO;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Tokens the KV cache could grow into, given free RAM minus a safety
 * reserve and optional already-resident weights. */
export function ramTokenRoom(memory: MemoryProbe, weightBytes = 0): number | undefined {
  const usable = memory.freeBytes - RAM_SAFETY_BYTES - Math.max(0, weightBytes);
  if (usable < KV_BYTES_PER_TOKEN) return undefined;
  return Math.floor(usable / KV_BYTES_PER_TOKEN);
}

export function defaultWindow(modelId: string | null | undefined): number {
  return decodeInjectId(modelId) ? DEFAULT_LOCAL_WINDOW : DEFAULT_CLOUD_WINDOW;
}

export function envCeilingOverride(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.OPENMAUSBOT_CONTEXT_CEILING?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return positiveInt(parsed);
}

export function contextCeiling(input: {
  advertisedWindow?: number | null;
  modelId?: string | null;
  weightBytes?: number | null;
  memory?: MemoryProbe | null;
  machine?: MachineProbe | null;
  env?: Record<string, string | undefined>;
  /** Compact around preset from Settings. Null/absent = Auto. */
  compactAround?: number | null;
}): ContextCeiling {
  const override = envCeilingOverride(input.env);
  if (override) {
    return { tokens: override, source: "override" };
  }
  const advertised = positiveInt(input.advertisedWindow ?? undefined);
  const fallback = defaultWindow(input.modelId);
  const userCap = positiveInt(input.compactAround ?? undefined);
  // Keep chatting radio is a cap, never a raise. RAM-probe KV estimates are
  // too jumpy (Apple compressed memory + loaded weights) and were recycling
  // every turn at ~14k while the chip still said 32k — Auto and presets both
  // ignore RAM for the ceiling. Live RAM pressure still fires compact at 50%.
  const cap = userCap ?? AUTO_COMPACT_AROUND_TOKENS;
  if (advertised) {
    const tokens = Math.max(MIN_CONTEXT_WINDOW, Math.min(advertised, cap));
    return { tokens, source: tokens === advertised ? "advertised" : "compact" };
  }
  if (userCap) {
    return { tokens: Math.max(MIN_CONTEXT_WINDOW, userCap), source: "compact" };
  }
  const tokens = Math.max(MIN_CONTEXT_WINDOW, fallback);
  if (tokens > AUTO_COMPACT_AROUND_TOKENS) {
    return { tokens: AUTO_COMPACT_AROUND_TOKENS, source: "compact" };
  }
  return { tokens, source: "default" };
}

export function advertisedWindowFor(
  catalog: { options: Array<{ id: string; contextWindow?: number }> } | undefined,
  modelId: string | null | undefined,
): number | undefined {
  if (!catalog || !modelId) return undefined;
  const exact = catalog.options.find((option) => option.id === modelId);
  if (positiveInt(exact?.contextWindow)) return exact!.contextWindow;
  const inject = decodeInjectId(modelId);
  if (!inject) return undefined;
  const byApiId = catalog.options.find((option) => option.id === inject.model || option.id.endsWith(`::${inject.model}`));
  return positiveInt(byApiId?.contextWindow);
}

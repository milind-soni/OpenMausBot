// The decision model's model routing: an easy message goes to the engine's
// lighter model for this one turn, and everything else stays on the bot's
// own model.
//
// One Score (MODEL_ROUTING in jobs.ts) over Light / Moderate / Heavy, with
// the message and the last few lines of the conversation. Asked only where a
// lighter model exists for the bot's model (LIGHTER_MODELS below), the
// engine switches models inside a session, the lighter model is in the
// engine's own catalog, and the conversation fits comfortably in its window.
//
// Acting on it: Light at p >= 0.8 runs this turn on the lighter model; the
// bot's saved selection is never changed. Anything less sure, and any
// failure at all, runs the bot's own model. Nothing here throws.
import type { ModelCatalog, ProviderAdapter } from "../contracts.ts";
import { contextWindowFor } from "../context-budget.ts";
import type { Decider } from "./index.ts";
import { MODEL_ROUTING } from "./jobs.ts";
import type { DeciderFailure } from "./types.ts";

export const MODEL_ROUTING_MIN_PROBABILITY = 0.8;

/** Per engine: the lighter model, and the models a turn may be moved off.
 * Only the engine's own first-party ids are listed, so a custom, local or
 * proxied model is never swapped for one on another provider. Codex and ACP
 * engines cannot switch models inside a session and are not here. */
export const LIGHTER_MODELS: Readonly<Record<string, { light: string; from: readonly string[] }>> = {
  claudeAgent: {
    light: "claude-haiku-4-5",
    from: ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5"],
  },
  grok: { light: "grok-4-fast", from: ["grok-4.7", "grok-4"] },
  mistral: { light: "mistral-small-latest", from: ["mistral-large-latest"] },
};

/** The conversation must fill at most this share of the lighter model's
 * window, so a long thread is never pushed past what it can read. */
const CONTEXT_SHARE = 0.5;
const MESSAGE_MAX = 2_000;
const RECENT_LINES = 4;
const LINE_MAX = 300;
const NAME_MAX = 80;

/** The lighter model this turn could run on, or null when routing does not
 * apply: no lighter model for this engine and model, an engine that cannot
 * switch in-session, a lighter model missing from its catalog, or a
 * conversation too long for it. */
export function lighterModelFor(input: {
  driverKind: string;
  model: string | undefined;
  catalog: ModelCatalog;
  capabilities: Pick<ProviderAdapter["capabilities"], "sessionModelSwitch">;
  /** The conversation's size in tokens, measured or estimated. */
  contextTokens: number;
}): string | null {
  const entry = LIGHTER_MODELS[input.driverKind];
  if (!entry || input.capabilities.sessionModelSwitch !== "in-session") return null;
  if (!input.model || input.model === entry.light || !entry.from.includes(input.model)) return null;
  if (!input.catalog.options.some((option) => option.id === entry.light)) return null;
  if (input.contextTokens > contextWindowFor(entry.light, input.catalog) * CONTEXT_SHARE) return null;
  return entry.light;
}

export interface ModelRoutingInput {
  message: string;
  /** Oldest first; only the last few are sent. */
  recent: ReadonlyArray<{ from: string; text: string }>;
}

export type ModelRoute =
  | { kind: "light"; probability: number }
  | { kind: "fallback"; reason: DeciderFailure | "not_light" | "no_message" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function modelRoutingRequest(input: ModelRoutingInput) {
  const recent = input.recent
    .map((line) => ({ from: clip(line.from, NAME_MAX), text: clip(line.text, LINE_MAX) }))
    .filter((line) => line.text)
    .slice(-RECENT_LINES);
  return {
    state: { message: clip(input.message, MESSAGE_MAX), ...(recent.length ? { recent_messages: recent } : {}) },
    question: { instructions: MODEL_ROUTING.instructions, levels: [...MODEL_ROUTING.levels!] },
  };
}

/** Ask once: Light enough for the lighter model? Never throws. */
export async function decideModelRoute(
  decider: Pick<Decider, "score">,
  input: ModelRoutingInput,
  options: { signal?: AbortSignal } = {},
): Promise<ModelRoute> {
  try {
    if (!input.message.trim()) return { kind: "fallback", reason: "no_message" };
    const { state, question } = modelRoutingRequest(input);
    const result = await decider.score("modelRouting", state, question, { timeoutMs: MODEL_ROUTING.timeoutMs, signal: options.signal });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const light = result.answers.probabilities[0];
    if (typeof light !== "number" || !Number.isFinite(light)) return { kind: "fallback", reason: "malformed" };
    if (light < MODEL_ROUTING_MIN_PROBABILITY) return { kind: "fallback", reason: "not_light" };
    return { kind: "light", probability: light };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}

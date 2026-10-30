// OpenRouter refuses every paid model with HTTP 402 for an account that never bought credit (its /key reports
// `is_free_tier`), so such a key defaults to a free model that can call tools. OpenRouter names free models "<id>:free".
import { createHash } from "node:crypto";
import type { ModelCatalog, ProviderInstance } from "../contracts.ts";
import { checkProviderKey } from "../provider-key-check.ts";
import { httpStatusOf } from "./engine-errors.ts";

/** Free models that call tools well, best first; when none is listed, the first free tool-capable model wins. */
export const FREE_MODEL_PREFERENCE: readonly string[] = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3.5-lightning:free",
];

export const OPENROUTER_FAILURES = {
  credits: "This model needs OpenRouter credit (HTTP 402). Pick a model marked (free), or add credit at openrouter.ai/credits.",
  privacy: "OpenRouter's privacy settings block this free model (HTTP 404). Allow free model endpoints at openrouter.ai/settings/privacy, or pick another model.",
  tools: "This model can't use tools, which bots need (HTTP 404). Pick another model, such as one marked (free).",
  freeLimit: "OpenRouter's limit for free models is used up for now (HTTP 429). Free models allow a set number of requests each day: wait for it to reset, or add credit at openrouter.ai/credits to raise it.",
} as const;

const TIER_TIMEOUT_MS = 5_000;
const FIRST_TURN_WAIT_MS = 4_000;
const REMEMBERED_KEYS = 32;

type Option = ModelCatalog["options"][number];

export interface OpenRouterModelRow {
  id?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
}

export function isOpenRouterOrigin(url: string): boolean {
  try {
    return new URL(url).origin === "https://openrouter.ai";
  } catch {
    return false;
  }
}

const freeId = (id: unknown): id is string => typeof id === "string" && id.endsWith(":free");

export function isFreeModel(row: OpenRouterModelRow): boolean {
  const pricing = row.pricing && typeof row.pricing === "object" ? (row.pricing as { prompt?: unknown; completion?: unknown }) : null;
  return freeId(row.id) || (pricing?.prompt === "0" && pricing.completion === "0");
}

export function freeLabel(label: string, row: OpenRouterModelRow): string {
  return isFreeModel(row) && !/\(free\)\s*$/i.test(label) ? `${label} (free)` : label;
}

/** Free models that take tools, in OpenRouter's order. */
export function freeToolModels(rows: readonly OpenRouterModelRow[]): string[] {
  return rows.flatMap((row) =>
    freeId(row.id) && Array.isArray(row.supported_parameters) && row.supported_parameters.includes("tools") ? [row.id] : []);
}

export function freeDefault(freeTools: readonly string[]): string | undefined {
  return FREE_MODEL_PREFERENCE.find((id) => freeTools.includes(id)) ?? freeTools[0];
}

export function freeToolsFirst(options: readonly Option[], freeTools: readonly string[]): Option[] {
  const free = new Set(freeTools);
  return [...options.filter((option) => free.has(option.id)), ...options.filter((option) => !free.has(option.id))];
}

/** Before OpenRouter's catalog arrives, a free-tier key already defaults to the first preferred free model. */
export function freeFallbackCatalog(seeded: ModelCatalog): ModelCatalog {
  const id = FREE_MODEL_PREFERENCE[0]!;
  return { default: id, options: [{ id, label: freeLabel(id, { id }), custom: true }, ...seeded.options] };
}

const tiers = new Map<string, Promise<boolean | null>>();

/** Security invariant: only the key's SHA-256 is remembered, and the key goes nowhere but OpenRouter's /key over TLS.
 * Asked once per key; an unknown answer (null) is asked again next time. */
export function openRouterFreeTier(key: string, url?: string): Promise<boolean | null> {
  const hash = createHash("sha256").update(key).digest("hex");
  const known = tiers.get(hash);
  if (known) return known;
  const asked = checkProviderKey({ provider: "openrouter", key, url }, undefined, TIER_TIMEOUT_MS)
    .then((verdict) => (verdict.ok ? verdict.freeTier ?? null : null));
  if (tiers.size >= REMEMBERED_KEYS) tiers.delete(tiers.keys().next().value!);
  tiers.set(hash, asked);
  void asked.then((tier) => {
    if (tier === null && tiers.get(hash) === asked) tiers.delete(hash);
  });
  return asked;
}

/** OpenRouter's refusal in plain words, or null when it is none of these. */
export function openRouterFailure(text: string, model: string): string | null {
  const status = httpStatusOf(text);
  const free = model.endsWith(":free");
  if (status === 402 || /\binsufficient credits\b|\brequires more credits\b/i.test(text)) return OPENROUTER_FAILURES.credits;
  if (/\bno endpoints found matching your data policy\b/i.test(text) && (free || /\bfree model/i.test(text))) {
    return OPENROUTER_FAILURES.privacy;
  }
  if (/\bno endpoints found that support tool use\b/i.test(text)) return OPENROUTER_FAILURES.tools;
  if ((status === 429 || /\brate limit exceeded\b/i.test(text)) && (free || /\bfree-models-per-/i.test(text))) {
    return OPENROUTER_FAILURES.freeLimit;
  }
  return null;
}

/** A turn or helper call without a chosen model waits briefly for `loading` (the key's tier and the catalog), so it
 * runs on the free default; OpenRouter's refusals reach the chat in plain words. */
export function withOpenRouterTurns(instance: ProviderInstance, loading: Promise<unknown>): ProviderInstance {
  const settled = async () => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([loading, new Promise((resolve) => { timer = setTimeout(resolve, FIRST_TURN_WAIT_MS); })]);
    clearTimeout(timer);
  };
  const { adapter } = instance;
  const send = adapter.sendTurn;
  const listen = adapter.onEvent;
  const generate = instance.generateText;
  const turnModels = new Map<string, string>();
  listen((event) => {
    if (event.type === "turn.completed") turnModels.delete(event.threadId);
  });
  adapter.sendTurn = async (turn) => {
    if (!turn.model) await settled();
    turnModels.set(turn.threadId, turn.model || instance.models.default);
    return send(turn);
  };
  adapter.onEvent = (listener) => listen((event) => listener(event.type === "runtime.error"
    ? { ...event, message: openRouterFailure(event.message, turnModels.get(event.threadId) ?? "") ?? event.message }
    : event));
  if (generate) {
    instance.generateText = async (prompt, options) => {
      if (!options?.model) await settled();
      return generate(prompt, options);
    };
  }
  return Object.assign(instance, { startupModelRefresh: loading.then(() => {}) });
}

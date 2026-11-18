import { OPENROUTER_MODEL_ID, OPENROUTER_MODEL_ID_MAX } from "./config.ts";
import { OPENROUTER_DEFAULT_MODEL, openrouterEndpoint } from "./openrouter.ts";

export interface OpenRouterModel {
  id: string;
  name: string;
  group: "recommended" | "more" | "chat";
  /** `chat`: a chat model answering through the JSON schema, not calibrated like a decisions model. */
  api: CatalogOutput | "chat";
}

/** The OpenRouter output modality a catalog lists; it also tags each model. */
export type CatalogOutput = "decisions" | "image";

export interface OpenRouterModelList {
  source: "openrouter" | "builtin";
  models: OpenRouterModel[];
}

export const OPENROUTER_DECIDER_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: OPENROUTER_DEFAULT_MODEL, name: "TypeSafe: Jev 1.13" },
  { id: "perplexity/pplx-decider-v1.1-27b", name: "Perplexity: Decider V1.1 27B" },
  { id: "openai/gpt-6-luna-decisions", name: "OpenAI: GPT-6 Luna Decisions" },
  { id: "nace-ai/drex-v1.5", name: "Nace.AI: Drex v1.5" },
  { id: "microsoft/microsoft-decision-1", name: "Microsoft: Microsoft-Decision-1" },
  { id: "cloudflare/clef-flash", name: "Cloudflare: Clef Flash" },
  { id: "inception/mercury-decide", name: "Inception: Mercury Decide" },
  { id: "cloudflare/clef", name: "Cloudflare: Clef" },
  { id: "nace-ai/drex-v2.0", name: "Nace.AI: Drex v2.0" },
  { id: "google/gemini-decision-1", name: "Google: Gemini Decision 1" },
];

/** Gemini chat models: the fast Flash tier only (a decision must answer within 1.5 s), no `:batch` or other variant. */
const GEMINI_CHAT_ID = /^google\/gemini-[^:]*flash[^:]*$/;
/** Every parameter the chat request sends (`openrouterRequestBody`); it asks OpenRouter for hosts that honour them all. */
const CHAT_PARAMETERS = ["max_tokens", "temperature", "response_format", "structured_outputs"];

const FETCH_TIMEOUT_MS = 3_000;
const OK_TTL_MS = 60 * 60_000;
const FAILED_TTL_MS = 60_000;
const MORE_MAX = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

type Curated = ReadonlyArray<{ id: string; name: string }>;

const builtin = (curated: Curated, api: CatalogOutput): OpenRouterModelList => ({
  source: "builtin",
  models: curated.map((model) => ({ ...model, group: "recommended" as const, api })),
});

/** Decisions models take no JSON schema (`supported_parameters` is empty), so the only test is that Settings can save the id. */
export function decisionsModels(body: unknown): Map<string, string> | null {
  return modelsWithOutput(body, "decisions");
}

/** OpenRouter's own routers (`openrouter/auto`) list every modality but pick a text model. */
export function modelsWithOutput(body: unknown, output: CatalogOutput): Map<string, string> | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const found = new Map<string, string>();
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) continue;
    if (entry.id.length > OPENROUTER_MODEL_ID_MAX || !OPENROUTER_MODEL_ID.test(entry.id) || entry.id.startsWith("openrouter/")) continue;
    const outputs = isRecord(entry.architecture) ? entry.architecture.output_modalities : undefined;
    if (!Array.isArray(outputs) || !outputs.includes(output)) continue;
    found.set(entry.id, typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id);
  }
  return found;
}

/** Gemini chat models for the decision picker: text out only (no image or video makers), and every parameter
 * the chat path sends. Listed apart because their probabilities are not calibrated. */
export function geminiChatModels(body: unknown): OpenRouterModel[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const found: OpenRouterModel[] = [];
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !GEMINI_CHAT_ID.test(entry.id)) continue;
    if (entry.id.length > OPENROUTER_MODEL_ID_MAX || !OPENROUTER_MODEL_ID.test(entry.id)) continue;
    const outputs = isRecord(entry.architecture) ? entry.architecture.output_modalities : undefined;
    if (!Array.isArray(outputs) || outputs.length === 0 || outputs.some((output) => output !== "text")) continue;
    const parameters = entry.supported_parameters;
    if (!Array.isArray(parameters) || !CHAT_PARAMETERS.every((parameter) => parameters.includes(parameter))) continue;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id;
    found.push({ id: entry.id, name, group: "chat", api: "chat" });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MORE_MAX);
}

export function mergeModels(found: Map<string, string>, curated: Curated = OPENROUTER_DECIDER_MODELS, api: CatalogOutput = "decisions"): OpenRouterModelList {
  const recommended = curated
    .filter((model) => found.has(model.id))
    .map((model) => ({ id: model.id, name: found.get(model.id)!, group: "recommended" as const, api }));
  const ids = new Set(curated.map((model) => model.id));
  const more = [...found]
    .filter(([id]) => !ids.has(id))
    .map(([id, name]) => ({ id, name, group: "more" as const, api }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MORE_MAX);
  return recommended.length ? { source: "openrouter", models: [...recommended, ...more] } : builtin(curated, api);
}

export interface OpenRouterModelCatalogDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Which models to list; decisions by default. */
  output?: CatalogOutput;
  /** Shown first, and alone when OpenRouter cannot be reached. */
  curated?: Curated;
}

/** Cached an hour after an answer, a minute after a failure. Never throws and never sends a key. */
export function createOpenRouterModelCatalog(deps: OpenRouterModelCatalogDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const output = deps.output ?? "decisions";
  const curated = deps.curated ?? OPENROUTER_DECIDER_MODELS;
  const cache = new Map<string, { until: number; value: unknown }>();

  async function fetchBody(endpoint: URL): Promise<unknown> {
    try {
      const response = await fetchImpl(endpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return await response.json();
    } catch {
      return null;
    }
  }

  /** One catalog modality, read by `read` (null = unusable): cached an hour, or a minute as `fallback` when unusable. */
  async function cachedLoad<T>(baseUrl: string | null | undefined, modality: string, read: (body: unknown) => T | null, fallback: T): Promise<T> {
    const endpoint = openrouterEndpoint(baseUrl, "models");
    if (!endpoint) return fallback;
    endpoint.searchParams.set("output_modalities", modality);
    const cached = cache.get(endpoint.href);
    if (cached && cached.until > now()) return cached.value as T;
    const read_ = read(await fetchBody(endpoint));
    const value = read_ ?? fallback;
    cache.set(endpoint.href, { until: now() + (read_ === null ? FAILED_TTL_MS : OK_TTL_MS), value });
    return value;
  }

  const readList = (body: unknown): OpenRouterModelList | null => {
    const found = modelsWithOutput(body, output);
    const list = found ? mergeModels(found, curated, output) : null;
    return list?.source === "openrouter" ? list : null;
  };
  return {
    async load(baseUrl?: string | null): Promise<OpenRouterModelList> {
      const list = cachedLoad(baseUrl, output, readList, builtin(curated, output));
      if (output !== "decisions") return list;
      // The Gemini chat models come after the live decisions list; none beside the built-in one.
      const [decisions, chat] = await Promise.all([list, cachedLoad(baseUrl, "text", geminiChatModels, [])]);
      if (decisions.source !== "openrouter" || !chat.length) return decisions;
      const ids = new Set(decisions.models.map((model) => model.id));
      return { ...decisions, models: [...decisions.models, ...chat.filter((model) => !ids.has(model.id))] };
    },
  };
}

export type OpenRouterModelCatalog = ReturnType<typeof createOpenRouterModelCatalog>;

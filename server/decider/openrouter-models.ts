import { OPENROUTER_MODEL_ID, OPENROUTER_MODEL_ID_MAX } from "./config.ts";
import { OPENROUTER_DEFAULT_MODEL, openrouterEndpoint } from "./openrouter.ts";

export interface OpenRouterModel {
  id: string;
  name: string;
  group: "recommended" | "more";
  api: CatalogOutput;
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
];

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
  const cache = new Map<string, { until: number; list: OpenRouterModelList }>();

  async function fetchList(endpoint: URL): Promise<OpenRouterModelList | null> {
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
      const found = modelsWithOutput(await response.json(), output);
      return found ? mergeModels(found, curated, output) : null;
    } catch {
      return null;
    }
  }

  return {
    async load(baseUrl?: string | null): Promise<OpenRouterModelList> {
      const endpoint = openrouterEndpoint(baseUrl, "models");
      if (!endpoint) return builtin(curated, output);
      endpoint.searchParams.set("output_modalities", output);
      const cached = cache.get(endpoint.href);
      if (cached && cached.until > now()) return cached.list;
      const fetched = await fetchList(endpoint);
      const list = fetched?.source === "openrouter" ? fetched : builtin(curated, output);
      cache.set(endpoint.href, { until: now() + (list.source === "openrouter" ? OK_TTL_MS : FAILED_TTL_MS), list });
      return list;
    },
  };
}

export type OpenRouterModelCatalog = ReturnType<typeof createOpenRouterModelCatalog>;

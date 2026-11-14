// OpenCode expands `{env:NAME}` and `{file:path}` anywhere in its config text, and escaping the brace in JSON does not
// stop it (verified on OpenCode 1.18.27): any provider or model with a brace in any string or key is dropped here.
// The trimmed shape keeps models.dev's field names, so trimming is idempotent.
import { normalizeApiUrl } from "../cli-api-setup.ts";

export const MODEL_CATALOG_SCHEMA = 1;

export type CatalogModelStatus = "alpha" | "beta";

/** US dollars per million tokens. */
export interface CatalogCost {
  input?: number;
  output?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  tool_call: true;
  reasoning: boolean;
  attachment: boolean;
  modalities: { input: string[] };
  release_date?: string;
  limit?: { context: number };
  cost?: CatalogCost;
  status?: CatalogModelStatus;
}

export interface CatalogProvider {
  id: string;
  name: string;
  env: string[];
  npm?: string;
  /** https, or http on loopback. */
  api?: string;
  /** Documentation link; https only. */
  doc?: string;
  models: Record<string, CatalogModel>;
}

export type CatalogProviders = Record<string, CatalogProvider>;

export type StoredCatalogModel = Omit<CatalogModel, "id" | "tool_call">;
export type StoredCatalogProviders = Record<string, Omit<CatalogProvider, "models"> & { models: Record<string, StoredCatalogModel> }>;

export interface ModelCatalogDocument {
  schema: typeof MODEL_CATALOG_SCHEMA;
  /** When this data was last known to match models.dev (ISO 8601). */
  updatedAt: string;
  source: {
    name: "models.dev";
    url: string;
    repository?: string;
    commit?: string;
    etag?: string;
    license?: string;
    licenseText?: string;
  };
  providers: StoredCatalogProviders;
}

export interface CatalogDrop {
  provider: string;
  model?: string;
  reason: "brace" | "invalid";
}

export interface TrimOptions {
  onDrop?: (drop: CatalogDrop) => void;
}

const MAX_PROVIDERS = 2_000;
const MAX_MODELS_PER_PROVIDER = 5_000;
const MAX_DEPTH = 8;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z0-9_]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RELEASE_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;

export function hasBrace(value: string): boolean {
  return value.includes("{") || value.includes("}");
}

export function containsBrace(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return hasBrace(value);
  if (value === null || typeof value !== "object") return false;
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => containsBrace(item, depth + 1));
  return Object.entries(value).some(([key, item]) => hasBrace(key) || containsBrace(item, depth + 1));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** No prototype: an id like `constructor` finds nothing, and `__proto__` cannot replace it (it is also rejected). */
const idMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const RESERVED_KEY = "__proto__";

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function displayName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(new RegExp(CONTROL.source, "gu"), "").trim().slice(0, 128);
  return clean || fallback;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function apiUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return normalizeApiUrl(value);
  } catch {
    return undefined;
  }
}

function trimModel(key: string, raw: unknown): CatalogModel | "skip" | "invalid" {
  if (!isRecord(raw)) return "invalid";
  if (raw.id !== undefined && raw.id !== key) return "invalid";
  if (!key || key.length > 256 || key === RESERVED_KEY || hasBrace(key) || CONTROL.test(key) || /\s/u.test(key)) return "invalid";
  if (raw.status === "deprecated" || raw.tool_call !== true) return "skip";
  const modalities = isRecord(raw.modalities) ? raw.modalities : undefined;
  const input = Array.isArray(modalities?.input)
    ? modalities.input.filter((item): item is string => typeof item === "string" && item.length <= 32).slice(0, 8)
    : [];
  if (!input.includes("text")) return "skip";

  const model: CatalogModel = {
    id: key,
    name: displayName(raw.name, key),
    tool_call: true,
    reasoning: raw.reasoning === true,
    attachment: raw.attachment === true,
    modalities: { input },
  };
  if (typeof raw.release_date === "string" && RELEASE_DATE.test(raw.release_date)) model.release_date = raw.release_date;
  const context = finite(isRecord(raw.limit) ? raw.limit.context : undefined);
  if (context !== undefined) model.limit = { context };
  if (isRecord(raw.cost)) {
    const cost: CatalogCost = {};
    for (const field of ["input", "output"] as const) {
      const price = finite(raw.cost[field]);
      if (price !== undefined) cost[field] = price;
    }
    if (Object.keys(cost).length) model.cost = cost;
  }
  if (raw.status === "alpha" || raw.status === "beta") model.status = raw.status;
  return model;
}

function trimProvider(key: string, raw: unknown, options: TrimOptions): CatalogProvider | undefined {
  const drop = (reason: CatalogDrop["reason"]) => {
    options.onDrop?.({ provider: key, reason });
    return undefined;
  };
  if (!isRecord(raw)) return drop("invalid");
  const { models: rawModels, ...fields } = raw;
  if (hasBrace(key) || containsBrace(fields)) return drop("brace");
  if (!PROVIDER_ID.test(key) || (raw.id !== undefined && raw.id !== key)) return drop("invalid");
  const env = Array.isArray(raw.env) ? raw.env : [];
  if (!env.every((name): name is string => typeof name === "string" && ENV_NAME.test(name))) return drop("invalid");

  const models = idMap<CatalogModel>();
  if (isRecord(rawModels)) {
    let kept = 0;
    for (const modelKey of Object.keys(rawModels).sort()) {
      const rawModel = rawModels[modelKey];
      if (hasBrace(modelKey) || containsBrace(rawModel)) {
        options.onDrop?.({ provider: key, model: modelKey, reason: "brace" });
        continue;
      }
      const model = trimModel(modelKey, rawModel);
      if (model === "invalid") options.onDrop?.({ provider: key, model: modelKey, reason: "invalid" });
      if (typeof model === "string") continue;
      models[modelKey] = model;
      if (++kept >= MAX_MODELS_PER_PROVIDER) break;
    }
  }
  // Field order is fixed (models last) so the snapshot text is stable.
  const provider: Omit<CatalogProvider, "models"> = { id: key, name: displayName(raw.name, key), env: env.slice(0, 8) };
  if (typeof raw.npm === "string" && raw.npm.length <= 214 && !CONTROL.test(raw.npm)) provider.npm = raw.npm;
  const api = apiUrl(raw.api);
  if (api) provider.api = api;
  const doc = httpsUrl(raw.doc);
  if (doc) provider.doc = doc;
  return { ...provider, models };
}

export function trimModelsDevCatalog(raw: unknown, options: TrimOptions = {}): CatalogProviders {
  const providers = idMap<CatalogProvider>();
  if (!isRecord(raw)) return providers;
  for (const key of Object.keys(raw).sort().slice(0, MAX_PROVIDERS)) {
    const provider = trimProvider(key, raw[key], options);
    if (provider) providers[key] = provider;
  }
  return providers;
}

export function catalogStats(providers: CatalogProviders): { providers: number; models: number } {
  let models = 0;
  for (const provider of Object.values(providers)) models += Object.keys(provider.models).length;
  return { providers: Object.keys(providers).length, models };
}

export function packCatalog(providers: CatalogProviders): StoredCatalogProviders {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, {
    ...provider,
    models: Object.fromEntries(Object.entries(provider.models).map(([modelId, model]) => {
      const { id: _id, tool_call: _toolCall, ...stored } = model;
      return [modelId, stored];
    })),
  }]));
}

export function unpackCatalog(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  return Object.fromEntries(Object.entries(stored).map(([id, provider]) => {
    if (!isRecord(provider) || !isRecord(provider.models)) return [id, provider];
    const models = Object.fromEntries(Object.entries(provider.models).map(([modelId, model]) =>
      [modelId, isRecord(model) ? { ...model, id: modelId, tool_call: true } : model]));
    return [id, { ...provider, models }];
  }));
}

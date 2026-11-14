// Codex model catalog: official ChatGPT rows stay in the main picker; everything wired in ~/.codex is
// tagged `custom`. `codex app-server` thread/start takes `model` and `modelProvider` separately.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ModelCatalog } from "../contracts.ts";
import { qualifiedModelLabel } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { codexHome } from "./codex-identity.ts";
import { MODEL_ID, SEP, TIERED_ID, codexTierOf } from "./codex-tier.ts";
import { unconfirmedModelCatalog } from "../startup-model-catalog.ts";
import { isEffortLevel } from "../../shared/wire.ts";
import { codexLocalProviderArgs, mergeLocalInject } from "./local-inject.ts";

export const STATIC_CODEX_MODELS: ModelCatalog = {
  default: "gpt-5.6-sol",
  options: [
    // Only used when live discovery fails; these rows do not establish account access.
    { id: "gpt-6-astra", label: "GPT-6 Astra (availability unverified)" },
    { id: "gpt-6-sol", label: "GPT-6 Sol (availability unverified)" },
    { id: "gpt-6-luna", label: "GPT-6 Luna (availability unverified)" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  ],
};

/** Official rows force this provider, so a local `model_provider = "omlx"` cannot swallow GPT-5.6. */
export const OFFICIAL_CODEX_PROVIDER = "openai";

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/i;

export function encodeCodexSelection(provider: string, model: string): string {
  return `${provider}${SEP}${model}`;
}

export function decodeCodexSelection(id: string | null | undefined): {
  model: string | null;
  modelProvider: string | null;
  serviceTier?: string;
} {
  if (!id) return { model: null, modelProvider: null };
  const sep = id.indexOf(SEP);
  if (sep > 0) {
    return { model: id.slice(sep + SEP.length), modelProvider: id.slice(0, sep) };
  }
  // A bare id is official: a new cloud model must not fall through to the user's local provider.
  if (!MODEL_ID.test(id)) return { model: id, modelProvider: null };
  const tiered = codexTierOf(id);
  if (tiered) return { model: tiered.model, modelProvider: OFFICIAL_CODEX_PROVIDER, serviceTier: tiered.tier };
  return { model: id, modelProvider: OFFICIAL_CODEX_PROVIDER };
}

/** Starts Codex on the chosen model's provider. codex-cli 0.167.0 refuses a turn whose thread provider differs from its
 * current one ("This chat uses custom, but your current provider is magpie"), whatever config.toml's model_provider says. */
export function codexSelectedProviderArgs(env: Record<string, string | undefined>, modelId: string | null | undefined): string[] {
  const provider = decodeCodexSelection(modelId).modelProvider;
  return [...codexLocalProviderArgs(env, modelId), ...(provider ? ["-c", `model_provider=${JSON.stringify(provider)}`] : [])];
}

interface CodexAppServerModel {
  id?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  serviceTiers?: unknown;
  defaultServiceTier?: unknown;
  supportedReasoningEfforts?: unknown;
}

const FAST_TIER = /fast/i;

/** The model's Fast tier (codex-cli 0.167 lists `{id: "priority", name: "Fast"}`), unless it already runs on it. */
function fastTier(row: CodexAppServerModel): { id: string; name: string } | null {
  if (!Array.isArray(row.serviceTiers)) return null;
  for (const tier of row.serviceTiers) {
    const id = tier?.id, name = tier?.name;
    if (typeof id !== "string" || typeof name !== "string" || !FAST_TIER.test(name) || !PROVIDER_ID.test(id)) continue;
    return id === row.defaultServiceTier ? null : { id, name };
  }
  return null;
}

/** The installed Codex CLI's own ChatGPT catalog, every page: it changes more often than our releases. */
export function readCodexAppServerModelCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 8_000,
): Promise<ModelCatalog | null> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, ["app-server"], {
      cwd: homedir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const models: CodexAppServerModel[] = [];
    const cursors = new Set<string>();
    const pending = new Map<number, "initialize" | "models">();

    const finish = (catalog: ModelCatalog | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCliTree(child);
      resolve(catalog);
    };
    const request = (method: string, params: unknown, kind: "initialize" | "models") => {
      const id = nextId++;
      pending.set(id, kind);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        finish(null);
      }
    };
    const requestModels = (cursor: string | null) => {
      request("model/list", { cursor, limit: 100 }, "models");
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const kind = pending.get(message.id);
        if (!kind) continue;
        pending.delete(message.id);
        if (message.error) {
          finish(null);
          return;
        }
        if (kind === "initialize") {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          } catch {
            finish(null);
            return;
          }
          requestModels(null);
          continue;
        }

        const page = message.result;
        if (Array.isArray(page?.data)) models.push(...page.data);
        const cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
        if (cursor && !cursors.has(cursor)) {
          cursors.add(cursor);
          requestModels(cursor);
          continue;
        }

        const options: ModelCatalog["options"] = [];
        const seen = new Set<string>();
        let defaultModel: string | null = null;
        for (const row of models) {
          if (row.hidden === true || typeof row.id !== "string" || !MODEL_ID.test(row.id) || seen.has(row.id)) continue;
          seen.add(row.id);
          const label = typeof row.displayName === "string" && row.displayName.trim() ? row.displayName : row.id;
          const effortLevels = Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts.map((entry) => entry?.reasoningEffort).filter(isEffortLevel) : undefined;
          const effort = effortLevels === undefined ? {} : { effortLevels };
          options.push({ id: row.id, label, ...effort });
          const fast = fastTier(row);
          if (fast && !TIERED_ID.test(row.id)) options.push({ id: `${row.id}+${fast.id}`, label: `${label} · ${fast.name}`, ...effort });
          if (row.isDefault === true) defaultModel = row.id;
        }
        if (!options.length) {
          finish(null);
          return;
        }
        finish({
          default: defaultModel && seen.has(defaultModel) ? defaultModel : options[0].id,
          options,
        });
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    request("initialize", { clientInfo: { name: "openmausbot", version: "1" } }, "initialize");
  });
}

function unquote(raw: string): string {
  let value = raw.trim();
  const hash = value.indexOf(" #");
  if (hash !== -1 && !(value.startsWith('"') || value.startsWith("'"))) {
    value = value.slice(0, hash).trim();
  }
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

interface CodexProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
}

interface CodexToml {
  model?: string;
  modelProvider?: string;
  providers: CodexProvider[];
}

function parseCodexToml(text: string): CodexToml {
  const result: CodexToml = { providers: [] };
  const byId = new Map<string, CodexProvider>();
  let section: "root" | "other" | CodexProvider = "root";

  const providerFor = (id: string): CodexProvider => {
    let provider = byId.get(id);
    if (!provider) {
      provider = { id };
      byId.set(id, provider);
      result.providers.push(provider);
    }
    return provider;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const inner = stripped.slice(1, -1);
      const match = /^model_providers\.(.+)$/.exec(inner);
      if (match) {
        let id = match[1];
        if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
        section = PROVIDER_ID.test(id) ? providerFor(id) : "other";
      } else {
        section = "other";
      }
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (!value) continue;
    if (section === "root") {
      if (key === "model") result.model = value;
      if (key === "model_provider") result.modelProvider = value;
      continue;
    }
    if (section === "other") continue;
    if (key === "name") section.name = value;
    if (key === "base_url") section.baseUrl = value;
    if (key === "env_key") section.envKey = value;
  }
  return result;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function providerName(provider: string, known: Map<string, CodexProvider>): string {
  return known.get(provider)?.name || provider;
}

function niceLabel(model: string, provider: string, known: Map<string, CodexProvider>, named: Map<string, string>): string {
  const encoded = encodeCodexSelection(provider, model);
  if (named.has(encoded)) return named.get(encoded)!;
  const host = providerName(provider, known);
  return qualifiedModelLabel(model, host, {
    redundantWhen: () => host === provider,
    decorate: (facet) => ` (${facet})`,
  });
}

function collectCatalogNames(home: string): Map<string, string> {
  const named = new Map<string, string>();
  for (const file of listDir(join(home, "model-catalogs"))) {
    if (!file.endsWith(".json")) continue;
    const provider = basename(file, ".json").replace(/-models$/, "");
    if (!PROVIDER_ID.test(provider)) continue;
    const raw = readText(join(home, "model-catalogs", file));
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
          ? (parsed as { data: unknown[] }).data
          : [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const row = record as { slug?: unknown; id?: unknown; display_name?: unknown; name?: unknown };
      const slug = typeof row.slug === "string" ? row.slug : typeof row.id === "string" ? row.id : "";
      if (!MODEL_ID.test(slug)) continue;
      const label = typeof row.display_name === "string" ? row.display_name : typeof row.name === "string" ? row.name : "";
      if (label) named.set(encodeCodexSelection(provider, slug), label);
    }
  }
  return named;
}

function idsFromModelsPayload(payload: unknown): string[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  return records.flatMap((record) => {
    if (typeof record === "string") return MODEL_ID.test(record) ? [record] : [];
    if (!record || typeof record !== "object") return [];
    const id = (record as { id?: unknown; slug?: unknown }).id ?? (record as { slug?: unknown }).slug;
    return typeof id === "string" && MODEL_ID.test(id) ? [id] : [];
  });
}

async function probeProviderModels(
  provider: CodexProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  if (!provider.baseUrl) return [];
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (provider.envKey && env[provider.envKey]) {
    headers.Authorization = `Bearer ${env[provider.envKey]}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (!response.ok) return [];
    return idsFromModelsPayload(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function readCodexModelCatalog(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  cli?: string,
): Promise<ModelCatalog> {
  const official = cli ? await readCodexAppServerModelCatalog(cli, env) : null;
  const catalog = await catalogAround(official ?? STATIC_CODEX_MODELS, env, fetchImpl);
  if (cli && !official) unconfirmedModelCatalog(catalog);
  return catalog;
}

async function catalogAround(
  official: ModelCatalog,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<ModelCatalog> {
  // A relative CODEX_HOME or user home must not load a catalog from another directory.
  const home = codexHome(env);
  if (!home) return mergeLocalInject(official, env, fetchImpl);
  const mainText = readText(join(home, "config.toml"));
  if (!mainText) return mergeLocalInject(official, env, fetchImpl);

  const main = parseCodexToml(mainText);
  const known = new Map(main.providers.map((provider) => [provider.id, provider]));
  const named = collectCatalogNames(home);
  const extras: Array<{ provider: string; model: string }> = [];

  const remember = (provider: string | undefined, model: string | undefined) => {
    if (!provider || !model) return;
    if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(model)) return;
    // A local provider may serve an official slug: keep its row provider-qualified.
    if (
      provider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === model)
    ) return;
    extras.push({ provider, model });
  };

  remember(main.modelProvider, main.model);

  for (const file of listDir(home)) {
    if (!file.endsWith(".config.toml")) continue;
    const profile = parseCodexToml(readText(join(home, file)) ?? "");
    for (const provider of profile.providers) {
      if (!known.has(provider.id)) known.set(provider.id, provider);
    }
    remember(profile.modelProvider ?? main.modelProvider, profile.model);
  }

  for (const [encoded, _label] of named) {
    const decoded = decodeCodexSelection(encoded);
    if (decoded.model && decoded.modelProvider) remember(decoded.modelProvider, decoded.model);
  }

  const live = await Promise.all(
    [...known.values()].map(async (provider) => {
      const ids = await probeProviderModels(provider, env, fetchImpl);
      return ids.map((model) => ({ provider: provider.id, model }));
    }),
  );
  for (const row of live.flat()) remember(row.provider, row.model);

  const options = official.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const id = encodeCodexSelection(extra.provider, extra.model);
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: niceLabel(extra.model, extra.provider, known, named),
      custom: true,
    });
  }

  const configured = main.model && main.modelProvider
    ? main.modelProvider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === main.model)
      ? main.model
      : encodeCodexSelection(main.modelProvider, main.model)
    : main.model && seen.has(main.model)
      ? main.model
      : null;

  return mergeLocalInject(
    {
      default: configured && seen.has(configured) ? configured : official.default,
      options,
    },
    env,
    fetchImpl,
  );
}

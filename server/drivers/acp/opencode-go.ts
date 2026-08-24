// The maintained OpenCode CLI through its ACP stdio interface. OpenCode is
// the harness; Zen, Go, OpenRouter, and user-configured/local providers are
// models discovered from that harness rather than separate OpenMaus drivers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli } from "../../procs.ts";

const STATIC_MODELS: ModelCatalog = {
  default: "opencode/x-preview-f-free",
  options: [
    {
      id: "opencode/x-preview-f-free",
      label: "Zen · Ox Alpha Free",
      contextWindow: 1_000_000,
    },
  ],
};

let lastSuccessfulCatalog: ModelCatalog | null = null;
const MODEL_PROBE_TTL_MS = 30_000;
const modelProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerLabel(id: string): string {
  if (id === "opencode") return "Zen";
  if (id === "opencode-go") return "Go";
  if (id === "openrouter") return "OpenRouter";
  return labelForModel(id);
}

function validModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1 || /\s/u.test(value)) return false;
  return [...value].every((character) => (character.codePointAt(0) ?? 0) > 0x1f);
}

function localModelRecord(record: Record<string, unknown>): boolean {
  const api = record.api && typeof record.api === "object" && !Array.isArray(record.api)
    ? record.api as Record<string, unknown>
    : {};
  if (typeof api.url !== "string") return false;
  try {
    const host = new URL(api.url).hostname.replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Parse the authoritative inventory printed by the installed OpenCode CLI.
 *
 * `models --verbose` is a sequence of `provider/model` header lines followed
 * by one JSON object. Model IDs can themselves contain `/` (OpenRouter), so
 * only the first separator identifies the provider. Older CLIs may print just
 * the headers; those still produce a usable catalog without metadata. */
export function parseOpenCodeModelsOutput(stdout: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let slug: string | null = null;
  let jsonLines: string[] = [];

  const flush = () => {
    if (!slug || seen.has(slug)) return;
    const separator = slug.indexOf("/");
    const provider = slug.slice(0, separator);
    const model = slug.slice(separator + 1);
    let record: Record<string, unknown> = {};
    const raw = jsonLines.join("\n").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        // A header-only/older CLI remains useful; fall back to the model id.
      }
    }
    if (record.status === "deprecated") return;
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : labelForModel(model);
    const limit = record.limit && typeof record.limit === "object" && !Array.isArray(record.limit)
      ? record.limit as Record<string, unknown>
      : {};
    const contextWindow = typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0
      ? Math.floor(limit.context)
      : undefined;
    seen.add(slug);
    options.push({
      id: slug,
      label: `${providerLabel(provider)} · ${name}`,
      ...(localModelRecord(record) ? { custom: true, loaded: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  };

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (line === trimmed && validModelSlug(trimmed)) {
      flush();
      slug = trimmed;
      jsonLines = [];
      continue;
    }
    if (slug) jsonLines.push(line);
  }
  flush();

  if (!options.length) return null;
  const preferred = options.find((option) => option.id === STATIC_MODELS.default);
  return { default: (preferred ?? options[0]!).id, options };
}

function runOpenCodeModels(
  cli: string,
  environment: Record<string, string | undefined>,
  verbose: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execCli(
      cli,
      ["models", ...(verbose ? ["--verbose"] : [])],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: environment },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Ask the same OpenCode binary that will run ACP for its effective catalog.
 * This automatically includes Zen, Go, other connected providers, custom
 * config, and anonymous free models with the exact IDs the session accepts. */
export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
): Promise<ModelCatalog> {
  try {
    const catalog = parseOpenCodeModelsOutput(await runOpenCodeModels(cli, environment, true));
    if (!catalog) throw new Error("OpenCode returned no usable models");
    lastSuccessfulCatalog = catalog;
    return catalog;
  } catch {
    return lastSuccessfulCatalog ?? STATIC_MODELS;
  }
}

export function resetOpenCodeModelCache() {
  lastSuccessfulCatalog = null;
  modelProbeCache.clear();
}

/** Compatibility export for older tests/imports while the product migrates
 * from the Go-only name. */
export const resetOpenCodeGoModelCache = resetOpenCodeModelCache;

const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
};

function opencodeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/** Upsert an openai-compatible provider so OpenCode can select host/model. */
export function ensureOpenCodeInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  const dir = opencodeConfigDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const providers =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...(config.provider as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          npm: "@ai-sdk/openai-compatible",
          name: host.label,
          options: {},
          models: {},
        };
  const options =
    existing.options && typeof existing.options === "object" && !Array.isArray(existing.options)
      ? { ...(existing.options as Record<string, unknown>) }
      : {};
  options.baseURL = host.baseUrl;
  if (!options.apiKey) options.apiKey = hostApiKey(host, env);
  const models =
    existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
      ? { ...(existing.models as Record<string, unknown>) }
      : {};
  if (!models[inject.model]) {
    models[inject.model] = { name: `${inject.model} (${host.label})` };
  }
  providers[inject.host] = {
    ...existing,
    npm: existing.npm || "@ai-sdk/openai-compatible",
    name: existing.name || host.label,
    options,
    models,
  };
  config.provider = providers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return native;
}

/** Every path the OpenCode CLI may keep auth.json at.
 *
 * The CLI is xdg-flavoured on EVERY platform — `opencode auth list` on macOS
 * prints `~/.local/share/opencode/auth.json`, and that is where real logins
 * land. The platform-conventional locations are kept as fallbacks in case a
 * future CLI moves there, but the xdg path must come first: checking only
 * Library/Application Support on macOS is exactly the bug that made the app
 * demand a sign-in from users who were already signed in. */
function storedAuthPaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode", "auth.json"));
}

/** True when auth.json contains any usable provider login managed by
 * OpenCode. The generic harness can run all of them, including `opencode`
 * (Zen), `opencode-go`, and third-party providers such as OpenRouter. */
function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some((auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
    const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
    return Boolean(entry.key || entry.access || entry.refresh);
  });
}

function hasStoredOpenCodeAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // A missing or unreadable file simply means there is no ambient login.
    }
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

export async function canListOpenCodeModels(
  env: Record<string, string | undefined>,
  cli: string,
  runModels: typeof runOpenCodeModels = runOpenCodeModels,
): Promise<boolean> {
  const cached = modelProbeCache.get(cli);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve(false),
  };
  entry.result = runModels(cli, env, false)
    .then((stdout) => stdout
      .split(/\r?\n/u)
      .some((line) => validModelSlug(line.trim())))
    .catch(() => false)
    .finally(() => {
      entry.expiresAt = Date.now() + MODEL_PROBE_TTL_MS;
    });
  modelProbeCache.set(cli, entry);
  return entry.result;
}

/** Migrate the model name published during Ox Alpha's first preview. The
 * current CLI calls the same model `x-preview-f-free`; prefer Go for an old
 * Go bot with an explicit key, otherwise use Zen's anonymous/free route. */
export function normalizeLegacyOpenCodeModel(
  model: string,
  env: Record<string, string | undefined>,
): string {
  if (model !== "opencode-go/ox-alpha-free") return model;
  return env.OPENCODE_API_KEY
    ? "opencode-go/x-preview-f-free"
    : "opencode/x-preview-f-free";
}

const support = (loadCatalog: OpenCodeCatalogLoader): AcpSupport => ({
  driverKind: "opencodeGo",
  // Keep the historical driver kind so existing bots and instance config do
  // not break; only the product name/catalog expand from Go to OpenCode.
  displayName: "OpenCode",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote:
    "OpenCode has no usable models — run `opencode auth login` or connect a provider in the OpenCode app",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  credentialEnv: ["OPENCODE_API_KEY"],
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env) => model
    ? ensureOpenCodeInjectModel(normalizeLegacyOpenCodeModel(model, env), env)
    : model,
  transformEnv: stripForeignProviderKeys,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: async (env, config) => (
    Boolean(env.OPENCODE_API_KEY)
    || hasStoredOpenCodeAuth(env)
    || await canListOpenCodeModels(env, config.cli)
  ),
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyOpenCodeError,
  resolveModels: async (environment, config) => mergeLocalInject(
    await loadCatalog(environment, config.cli),
    environment,
  ),
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

export const classifyOpenCodeGoError = classifyOpenCodeError;

export function createOpenCodeDriver(loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  return createAcpDriver(support(loadCatalog));
}

export const createOpenCodeGoDriver = createOpenCodeDriver;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = OpenCodeDriver;

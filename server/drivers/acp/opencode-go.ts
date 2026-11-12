// OpenCode over ACP; Zen, Go, OpenRouter and local providers are models it discovers, not separate drivers.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

import { ATTACHMENTS_DIR } from "../../attachments.ts";
import { cloudHomeConfigured } from "../../cloud-home.ts";
import { DATA_DIR, OPENCODE_PROVIDER_ENV } from "../../config.ts";
import { hostedWorkspaceConfigured } from "../../enterprise.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { applyStandaloneSpawnEnv } from "../../engine-install.ts";
import { OPENCODE_STANDALONE } from "./opencode-release.ts";
import { createAcpDriver, type AccountErrorCode, type AcpConfig, type AcpSupport } from "./core.ts";
import { offeredModels } from "./config-options.ts";
import { declareTypedOpenCodeModel } from "./opencode-typed-model.ts";
import {
  declareLiveOpenCodeModels,
  keepOpenCodeModelsFresh,
  markOpenCodeCatalogRefreshed,
  refreshLiveModelLists,
  resetLiveModelLists,
  type OpenCodeModelSources,
  type OpenCodeRefreshSchedule,
} from "./opencode-model-refresh.ts";
import { openCodePromptUnreachedModel } from "./opencode-unreached.ts";
import { parseOpenCodeLogLine } from "./quiet-status.ts";
import type { ModelCatalog, ModelVariantOption, ProviderDriver, ProviderErrorCode } from "../../contracts.ts";
import { execCliBoxed } from "../../procs.ts";
import {
  catalogFromOpenCodeSession,
  DISCOVERY_TIMEOUT_MS,
  discoveryDirectory,
  forgetDiscoveryDirectory,
  labelForModel,
  probeOpenCodeSession,
  providerLabel,
  validModelSlug,
} from "./opencode-probe.ts";

export { catalogFromOpenCodeSession, surveyOpenCodeEfforts } from "./opencode-probe.ts";
export { openCodePromptUnreachedModel } from "./opencode-unreached.ts";

const NO_MODELS: ModelCatalog = { default: "", options: [] };

const lastSuccessfulCatalog = new Map<string, ModelCatalog>();
const catalogRevisions = new Map<string, number>();
/** `models --verbose` (V1) prints Zen prices, cost 0 meaning free; V2 prints none, so a `-free` id suffix is the fallback. */
const freeModels = new Set<string>();
const paidModels = new Set<string>();

const DISCOVERY_PROBE_TTL_MS = 30_000;
/** How long a listing OpenCode 2 runs stays open for its own catalog refresh to land (2.2.5 fetched 11 MB in 4 s). */
const SELF_REFRESH_SETTLE_MS = 10_000;
const discoveryProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
  /** `allowEnv`: the keys the instance's own settings put in `environment`, which the reads keep in the bot box. */
  options?: { refresh?: boolean; settleMs?: number; allowEnv?: readonly string[] },
) => Promise<ModelCatalog>;

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

export function isFreeOpenCodeModel(id: string): boolean {
  if (freeModels.has(id)) return true;
  if (paidModels.has(id)) return false;
  return /(?:^|[-_/])free$/iu.test(id);
}

/** OpenCode 2 with a key picks a paid model on its own, so a free model wins unless the catalog is all paid. */
export function preferredOpenCodeModel(offered: readonly string[], current?: string | null): string {
  if (current && offered.includes(current) && isFreeOpenCodeModel(current)) return current;
  const free = offered.filter(isFreeOpenCodeModel);
  return free.find((id) => id.startsWith("opencode/"))
    ?? free[0]
    ?? (current && offered.includes(current) ? current : offered[0] ?? "");
}

interface ParsedModels {
  options: ModelCatalog["options"];
  free: string[];
  paid: string[];
}

/** `opencode models --verbose` (V1): `provider/model` header lines, each followed by a JSON object.
 * Ids can contain `/` (OpenRouter), so only the first separator names the provider; older CLIs print
 * headers only. */
function parseOpenCodeModels(stdout: string): ParsedModels {
  const options: ModelCatalog["options"] = [];
  const free: string[] = [];
  const paid: string[] = [];
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
      } catch {}
    }
    if (record.status === "deprecated") return;
    const cost = record.cost && typeof record.cost === "object" && !Array.isArray(record.cost)
      ? record.cost as Record<string, unknown>
      : null;
    if (cost && typeof cost.input === "number" && typeof cost.output === "number") {
      (cost.input === 0 && cost.output === 0 ? free : paid).push(slug);
    }
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : labelForModel(model);
    const limit = record.limit && typeof record.limit === "object" && !Array.isArray(record.limit)
      ? record.limit as Record<string, unknown>
      : {};
    const contextWindow = typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0
      ? Math.floor(limit.context)
      : undefined;
    const variants = record.variants && typeof record.variants === "object" && !Array.isArray(record.variants)
      ? Object.entries(record.variants).filter(([, settings]) => (
          settings && typeof settings === "object" && !Array.isArray(settings)
          && (settings as Record<string, unknown>).disabled !== true
        )).map(([id]) => ({ id, label: labelForModel(id) }))
      : undefined;
    seen.add(slug);
    options.push({
      id: slug,
      label: `${providerLabel(provider)} · ${name}`,
      ...(localModelRecord(record) ? { custom: true, loaded: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(variants ? { variants } : {}),
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
  return { options, free, paid };
}

function rememberPrices(parsed: Pick<ParsedModels, "free" | "paid">) {
  for (const id of parsed.free) {
    freeModels.add(id);
    paidModels.delete(id);
  }
  for (const id of parsed.paid) {
    paidModels.add(id);
    freeModels.delete(id);
  }
}

export function parseOpenCodeModelsOutput(stdout: string): ModelCatalog | null {
  const parsed = parseOpenCodeModels(stdout);
  if (!parsed.options.length) return null;
  rememberPrices(parsed);
  return { default: preferredOpenCodeModel(parsed.options.map((option) => option.id)), options: parsed.options };
}
function runOpenCodeModelsVerbose(
  cli: string,
  environment: Record<string, string | undefined>,
  allowEnv: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execCliBoxed(
      cli,
      ["models", "--verbose"],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: environment, box: { allowEnv } },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(stderr?.trim() || error.message, { cause: error }), {
            timedOut: (error as { killed?: boolean }).killed === true,
          }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** OpenCode 1.19.4 lists models from its models.dev cache file and `models --refresh` refetches it. Every other
 * process of it starts a background refetch under a cross-process lock that a process ended mid-fetch leaves held,
 * and the next refetch waits until the lock is a minute old. OpenCode 2.2.5 rejects the flag (exit 1): each of its
 * processes refetches its catalog itself, in the background, at start. */
const MODELS_REFRESH_TIMEOUT_MS = 75_000;

function refreshOpenCodeModelCache(cli: string, environment: Record<string, string | undefined>, allowEnv: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execCliBoxed(cli, ["models", "--refresh"], { timeout: MODELS_REFRESH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: environment, box: { allowEnv } }, (error) => resolve(!error));
  });
}

function sameModelIds(left: ModelCatalog | undefined, right: ModelCatalog): boolean {
  const ids = new Set(left?.options.map((option) => option.id));
  return ids.size === right.options.length && right.options.every((option) => ids.has(option.id));
}

/** The session's own effort choices win over `models --verbose`: they are what set_config_option accepts. */
function withEfforts(
  option: ModelCatalog["options"][number],
  efforts: ModelVariantOption[] | undefined,
): ModelCatalog["options"][number] {
  if (!efforts) return option;
  const { variants: _verbose, ...rest } = option;
  return efforts.length ? { ...rest, variants: efforts } : rest;
}

/** `models --verbose` is OpenCode 1 only (2 rejects the flag). Plain `opencode models` on 2 answers from a
 * shared background service that keeps the env it started with, and its first answer is empty. */
export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
  options: { refresh?: boolean; settleMs?: number; allowEnv?: readonly string[] } = {},
): Promise<ModelCatalog> {
  const allowEnv = options.allowEnv ?? [];
  const settleMs = options.refresh && !await refreshOpenCodeModelCache(cli, environment, allowEnv)
    ? options.settleMs ?? SELF_REFRESH_SETTLE_MS
    : 0;
  // A listing ends long before a catalog refetch would: it reads the cache, unless it waits for OpenCode 2's own refetch.
  const listing = settleMs ? environment : { ...environment, OPENCODE_DISABLE_MODELS_FETCH: "1" };
  const probeSession = () => probeOpenCodeSession(cli, listing, DISCOVERY_TIMEOUT_MS, settleMs, allowEnv);
  const readMetadata = () => runOpenCodeModelsVerbose(cli, listing, allowEnv).then(parseOpenCodeModels);
  let [session, verbose] = await Promise.allSettled([probeSession(), readMetadata()]);
  // Two OpenCode processes starting together in a fresh home race to create its database and one fails
  // (1 in 8 fresh homes). A timed-out half is not retried.
  const retry = (result: PromiseSettledResult<unknown>) =>
    result.status === "rejected" && (result.reason as { timedOut?: boolean } | null)?.timedOut !== true;
  if (retry(session)) [session] = await Promise.allSettled([probeSession()]);
  if (retry(verbose)) [verbose] = await Promise.allSettled([readMetadata()]);
  const metadata = verbose.status === "fulfilled" ? verbose.value : null;
  if (metadata) rememberPrices(metadata);
  const probe = session.status === "fulfilled" ? session.value : null;
  const live = probe ? catalogFromOpenCodeSession(probe.session) : null;
  let catalog: ModelCatalog | null = null;
  if (probe && live) {
    const details = new Map((metadata?.options ?? []).map((option) => [option.id, option]));
    const options = live.options.map((option) => withEfforts(
      { ...option, ...details.get(option.id), id: option.id },
      probe.efforts.get(option.id),
    ));
    catalog = { default: preferredOpenCodeModel(options.map((option) => option.id), live.current), options };
  } else if (metadata?.options.length) {
    catalog = { default: preferredOpenCodeModel(metadata.options.map((option) => option.id)), options: metadata.options };
  }
  if (!catalog) return lastSuccessfulCatalog.get(cli) ?? NO_MODELS;
  if (options.refresh && !sameModelIds(lastSuccessfulCatalog.get(cli), catalog)) {
    catalogRevisions.set(cli, (catalogRevisions.get(cli) ?? 0) + 1);
  }
  lastSuccessfulCatalog.set(cli, catalog);
  return catalog;
}

/** A running `opencode acp` keeps the catalog it started with, so a refresh that changed it needs a fresh process. */
export function openCodeSpawnFingerprint(env: Record<string, string | undefined>, cli: string): string {
  return `${openCodeLoginsFingerprint(env)}#${catalogRevisions.get(cli) ?? 0}`;
}

/** Whether this OpenCode offers any model; Zen's free models need no login. */
export async function canRunOpenCode(
  environment: Record<string, string | undefined>,
  cli: string,
  discover: OpenCodeCatalogLoader = discoverOpenCodeModels,
  allowEnv: readonly string[] = [],
): Promise<boolean> {
  if (lastSuccessfulCatalog.get(cli)?.options.length) return true;
  const cached = discoveryProbeCache.get(cli);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const entry = { expiresAt: Number.POSITIVE_INFINITY, result: Promise.resolve(false) };
  entry.result = discover(environment, cli, { allowEnv })
    .then((catalog) => catalog.options.length > 0, () => false)
    .finally(() => {
      entry.expiresAt = Date.now() + DISCOVERY_PROBE_TTL_MS;
    });
  discoveryProbeCache.set(cli, entry);
  return entry.result;
}

export function resetOpenCodeModelCache() {
  forgetDiscoveryDirectory();
  resetLiveModelLists();
  lastSuccessfulCatalog.clear();
  catalogRevisions.clear();
  discoveryProbeCache.clear();
  freeModels.clear();
  paidModels.clear();
}

export const resetOpenCodeGoModelCache = resetOpenCodeModelCache;

/** Provider keys come from the server's env only when it is the person's own shell: never on a Cloud
 * home, hosted team, managed desktop or open sign-in list, where every bot would bill the operator's key. */
export function openCodeProviderKeysAllowed(state: {
  cloudHome: boolean;
  hostedWorkspace: boolean;
  organisationManaged: boolean;
  sharedSignIn: boolean;
}): boolean {
  return !state.cloudHome && !state.hostedWorkspace && !state.organisationManaged && !state.sharedSignIn;
}

let providerKeysAllowed = (): boolean => openCodeProviderKeysAllowed({
  cloudHome: cloudHomeConfigured(),
  hostedWorkspace: hostedWorkspaceConfigured(),
  organisationManaged: false,
  sharedSignIn: false,
});

export function setOpenCodeProviderKeyPolicy(allowed: () => boolean): void {
  providerKeysAllowed = allowed;
}

function withholdProviderKeysWhenManaged(
  env: Record<string, string | undefined>,
  _config: unknown,
  _instanceId: string,
  instanceEnvironment: Readonly<Record<string, string>>,
): void {
  if (providerKeysAllowed()) return;
  for (const key of OPENCODE_PROVIDER_ENV) {
    if (!Object.hasOwn(instanceEnvironment, key)) delete env[key];
  }
}

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
    } catch {}
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

/** OpenCode 1.18 appends every process's log to one file under its xdg data folder. */
export function openCodeLogPath(env: Record<string, string | undefined>): string {
  return join(env.XDG_DATA_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".local", "share"), "opencode", "log", "opencode.log");
}

/** The CLI is xdg-flavoured on every platform (`opencode auth list` on macOS prints
 * `~/.local/share/opencode/auth.json`), so the xdg path comes first. */
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
    } catch {}
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

/** A login, a key or a provider key of the person's own: what makes OpenCode more than Zen's free models. */
function ownOpenCodeAccess(env: Record<string, string | undefined>): boolean {
  return Boolean(env.OPENCODE_API_KEY) || hasStoredOpenCodeAuth(env) || OPENCODE_PROVIDER_ENV.some((key) => Boolean(env[key]?.trim()));
}

/** OpenCode's own providers: Zen (some models free without a login) and Go (a subscription). */
const OPENCODE_OWN_MODEL = /^opencode(?:-go)?\//u;

/** Ready only through Zen's free no-login models: no access of the person's own and no other provider's model. A local
 * model the app found (`custom`) is not the person signing OpenCode in to anything. An empty catalog is no fallback: it
 * offers nothing to run. */
export function openCodeFreeFallback(ownAccess: boolean, models: ModelCatalog): boolean {
  return !ownAccess && models.options.length > 0
    && models.options.every((option) => option.custom === true || OPENCODE_OWN_MODEL.test(option.id));
}

function withinFolder(path: string, folder: string): boolean {
  const rest = relative(resolvePath(folder), resolvePath(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** A bot's shared or private folder: bots wrote everything there, so none of it may become OpenCode configuration. */
export function openMausOwnsWorkingFolder(cwd: string): boolean {
  return [join(DATA_DIR, "workspaces"), join(DATA_DIR, "task-workspaces")].some((root) =>
    withinFolder(cwd, root) && resolvePath(cwd) !== resolvePath(root));
}

/** OpenMaus folders an OpenCode bot may use without an approval card: attachments and its own shared folder.
 * Never one at or above the working folder: OpenCode reads opencode.json, .opencode/ and AGENTS.md from
 * every folder above it, so a planted file would configure later conversations. Known risk: the folder
 * rule covers writes too, so a bot can change or delete files in the attachments folder. */
export function openCodeOwnedDirectories(botId?: string, cwd?: string): string[] {
  const directories = [ATTACHMENTS_DIR];
  // One path segment only: a bot id never names a folder outside its own.
  if (botId && /^[\w-][\w.-]*$/u.test(botId) && botId !== "..") directories.push(join(DATA_DIR, "workspaces", botId));
  return cwd ? directories.filter((directory) => !withinFolder(cwd, directory)) : directories;
}

/** JSON with comments and trailing commas, as OpenCode reads its config. */
function parseJsonc(text: string): unknown {
  let plain = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      plain += character;
      if (character === "\\") plain += text[++index] ?? "";
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      plain += character;
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      plain += "\n";
    } else if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
    } else plain += character;
  }
  try {
    return JSON.parse(plain.replace(/,(\s*[}\]])/gu, "$1"));
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The person's own folder rule when it is a single action. OPENCODE_PERMISSION merges over the config
 * and an object replaces a string, so a "deny" would otherwise become the default "ask". Sources in
 * OpenCode's order: global config, OPENCODE_CONFIG, project files root down, .opencode, OPENCODE_CONFIG_CONTENT. */
export function configuredOpenCodeFolderAction(
  env: Record<string, string | undefined>,
  cwd: string,
  projectConfig: boolean,
): string | undefined {
  let rule: unknown;
  const apply = (raw: string | undefined) => {
    if (!raw) return;
    const config = parseJsonc(raw) as { permission?: unknown } | undefined;
    const permission = config && typeof config === "object" ? config.permission : undefined;
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) return;
    const value = (permission as Record<string, unknown>).external_directory;
    if (typeof value === "string") rule = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      rule = rule && typeof rule === "object" ? { ...rule as object, ...value } : value;
    }
  };
  const global = opencodeConfigDir(env);
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) apply(readText(join(global, name)));
  if (env.OPENCODE_CONFIG) apply(readText(env.OPENCODE_CONFIG));
  const projectFolders: string[] = [];
  if (projectConfig) {
    for (let folder = resolvePath(cwd); ; folder = dirname(folder)) {
      projectFolders.push(folder);
      if (existsSync(join(folder, ".git")) || dirname(folder) === folder) break;
    }
    for (const folder of [...projectFolders].reverse()) {
      for (const name of ["opencode.json", "opencode.jsonc"]) apply(readText(join(folder, name)));
    }
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  const configFolders = [
    ...projectFolders.map((folder) => join(folder, ".opencode")),
    join(home, ".opencode"),
    ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : []),
  ];
  for (const folder of configFolders) {
    for (const name of ["opencode.json", "opencode.jsonc"]) apply(readText(join(folder, name)));
  }
  apply(env.OPENCODE_CONFIG_CONTENT);
  return typeof rule === "string" ? rule : undefined;
}

/** OpenCode asks before a tool touches a folder outside the working folder (`external_directory`). */
function allowOwnedDirectories(env: Record<string, string | undefined>, botId: string | undefined, cwd: string): void {
  let permission: Record<string, unknown> = {};
  if (env.OPENCODE_PERMISSION) {
    try {
      const parsed = JSON.parse(env.OPENCODE_PERMISSION) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      permission = parsed as Record<string, unknown>;
    } catch {
      return;
    }
  }
  const directories = openCodeOwnedDirectories(botId, cwd);
  if (!directories.length) return;
  const existing = permission.external_directory;
  // OpenCode evaluates rules in order and the last match wins.
  let rules: Record<string, unknown>;
  if (typeof existing === "string") rules = { "*": existing };
  else if (existing && typeof existing === "object" && !Array.isArray(existing)) rules = { ...(existing as Record<string, unknown>) };
  else {
    const configured = configuredOpenCodeFolderAction(env, cwd, env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1");
    rules = configured ? { "*": configured } : {};
  }
  for (const directory of directories) {
    rules[directory] = "allow";
    rules[join(directory, "*")] = "allow";
  }
  permission.external_directory = rules;
  env.OPENCODE_PERMISSION = JSON.stringify(permission);
}

export function describeOpenCodeAccountError(
  code: AccountErrorCode,
  model?: string,
  where: { cloudHome: boolean } = { cloudHome: cloudHomeConfigured() },
): string {
  const provider = model && model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
  const zen = provider === "opencode";
  const go = provider === "opencode-go";
  const label = providerLabel(provider);
  const name = zen ? "OpenCode Zen" : go ? "OpenCode Go" : provider ? (label.length > 24 ? provider.slice(0, 24) : label) : "OpenCode";
  switch (code) {
    case "invalid_credentials":
      return zen || go || !provider
        ? "OpenCode rejected its key, or has none for this model. Add or replace the OpenCode key in Settings → API keys."
        : where.cloudHome
          ? `OpenCode's ${name} key for this model is missing or was rejected. Save it under Keys for other OpenCode providers in Settings → API keys.`
          : `OpenCode's ${name} key for this model is missing or was rejected. Fix it with \`opencode auth login\`, or choose another model.`;
    case "insufficient_funds":
      return zen || !provider
        ? "Your OpenCode Zen balance has run out. Add credit at opencode.ai, or choose one of Zen's free models for this bot."
        : `Your ${name} account has run out of credit. Add credit there, or choose another model for this bot.`;
    case "inactive_subscription":
      return go || !provider
        ? "This model needs an active OpenCode Go subscription. Subscribe at opencode.ai, or choose a Zen model for this bot."
        : `This model needs an active ${name} subscription. Renew it there, or choose another model for this bot.`;
    case "quota_or_region_restriction":
      return `${name} says this account's usage limit has been reached. Wait for it to reset, or choose another model for this bot.`;
  }
}

/** A running `opencode acp` never re-reads auth.json, so a login change needs a fresh process. */
function openCodeLoginsFingerprint(env: Record<string, string | undefined>): string {
  return storedAuthPaths(env).map((path) => {
    try {
      const stat = statSync(path);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "-";
    }
  }).join("|");
}

/** `ownAccess` hears, per instance, whether its last sign-in read found access of the person's own. */
const support = (
  loadCatalog: OpenCodeCatalogLoader,
  ownAccess = new Map<string, boolean>(),
  sources: OpenCodeModelSources = {},
): AcpSupport => ({
  driverKind: "opencodeGo",
  displayName: "OpenCode",
  models: NO_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote: "OpenCode has no usable models. Add an OpenCode key in Settings → API keys.",
  install: {
    command: {
      darwin: "npm install -g @opencode/cli",
      linux: "npm install -g @opencode/cli",
      win32: "npm install -g @opencode/cli",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
    standalone: OPENCODE_STANDALONE,
  },
  spawnArgs: () => ["acp"],
  statusLog: { path: openCodeLogPath, parse: parseOpenCodeLogLine, shared: true },
  // A folder outside git files its session under OpenCode's global project, which every non-git folder of the person's
  // shares: a connection check or memory upkeep would show up in their history there.
  oneShotFolder: discoveryDirectory,
  shareProcess: true,
  credentialEnv: ["OPENCODE_API_KEY", ...OPENCODE_PROVIDER_ENV],
  selectModel: { configId: "model" },
  fallbackModel: (sessionConfig, catalogDefault) => {
    const offered = offeredModels(sessionConfig, "model");
    if (catalogDefault && offered.includes(catalogDefault)) return catalogDefault;
    return preferredOpenCodeModel(offered, catalogFromOpenCodeSession(sessionConfig)?.current) || null;
  },
  modelVariants: true,
  ownMcpOverHttp: true,
  // OpenCode 1.18.27's build agent lists 13 tools of its own (bash, read, edit, task, skill…); room for a newer CLI's.
  engineTools: 24,
  resolveTurnModel: (model, env, catalog) => model ? declareTypedOpenCodeModel(env, model, catalog.options) ?? ensureOpenCodeInjectModel(model, env) : model,
  transformEnv: (env, config, instanceId, instanceEnvironment) => {
    withholdProviderKeysWhenManaged(env, config, instanceId, instanceEnvironment);
    declareLiveOpenCodeModels(env, sources.liveLists);
    applyStandaloneSpawnEnv(OPENCODE_STANDALONE, env, config.cli);
  },
  spawnFingerprint: (env, config) => openCodeSpawnFingerprint(env, config.cli),
  applyTurnEnv: (env, { fullAuto, botId, cwd }) => {
    if (openMausOwnsWorkingFolder(cwd)) env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    if (!fullAuto) {
      allowOwnedDirectories(env, botId, cwd);
      return;
    }
      // A wildcard alone leaves OpenCode's more-specific external-directory and read rules in place.
    env.OPENCODE_PERMISSION = JSON.stringify(Object.fromEntries([
      "*", "external_directory", "read", "edit", "bash", "glob", "grep",
      "list", "task", "lsp", "skill", "webfetch", "websearch", "codesearch",
      "todoread", "todowrite", "doom_loop",
    ].map((permission) => [permission, "allow"])));
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: async (env, config, instanceId, allowEnv) => {
    ownAccess.set(instanceId, ownOpenCodeAccess(env));
    return Boolean(env.OPENCODE_API_KEY)
      || hasStoredOpenCodeAuth(env)
      || await canRunOpenCode(env, config.cli, loadCatalog, allowEnv);
  },
  classifyError: classifyOpenCodeError,
  promptUnreachedModel: openCodePromptUnreachedModel,
  limitFacts: openCodeLimitFacts,
  describeAccountError: describeOpenCodeAccountError,
  resolveModels: async (environment, config, instanceId, fresh, allowEnv) => {
    if (fresh) markOpenCodeCatalogRefreshed(instanceId, (sources.now ?? Date.now)());
    await refreshLiveModelLists(environment, { lists: sources.liveLists, fetch: sources.fetch, now: sources.now });
    declareLiveOpenCodeModels(environment, sources.liveLists);
    return mergeLocalInject(await loadCatalog(environment, config.cli, { refresh: fresh === true, allowEnv }), environment);
  },
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

/** OpenCode 1.18 reports a provider's account refusal as a JSON-RPC internal error wrapping an APIError:
 * `{code: -32603, message: "Internal error: Invalid API key.", data: {service: "session", errorName: "APIError"}}`. */
const ACCOUNT_ERROR_TEXT: ReadonlyArray<readonly [RegExp, AccountErrorCode]> = [
  [/insufficient (?:account )?(?:funds|balance|credits?)|out of credits?|no credits? (?:left|remaining)|payment required|\b402\b/iu, "insufficient_funds"],
  // Not plain "rate limit exceeded": a transient 429 that OpenCode retries itself.
  [/\bquota\b|usage limit|\b(?:Free|Go)UsageLimitError\b|(?:hourly|daily|weekly|monthly|5-hour) limit/iu, "quota_or_region_restriction"],
  [/\bsubscription\b/iu, "inactive_subscription"],
  // "User not found." is OpenRouter's refusal of an unknown key (opencode 1.18.27).
  [/invalid api key|api key (?:is )?(?:invalid|missing|revoked|expired)|incorrect api key|unauthori[sz]ed|\b401\b|authentication (?:failed|required)|(?:^|internal error: )user not found\b/iu, "invalid_credentials"],
];

/** A usage limit that only OpenCode's free models met: the paid Go and Zen models on the same login still work, so the
 * refusal holds that login's free models and leaves the account available. */
const FREE_MODEL_LIMIT = /\bfree(?:UsageLimitError|\s+usage\s+limit)\b/iu;

/** How far a usage limit OpenCode reported reaches: one provider's shared free allowance (with the free models that
 * allowance holds), or the whole account. */
export function openCodeLimitFacts(text: string, model?: string): { limit: "engine" | "model"; limitModels?: string[] } {
  if (!FREE_MODEL_LIMIT.test(text)) return { limit: "engine" };
  const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : "";
  const shared = provider ? [...freeModels].filter((id) => id.startsWith(`${provider}/`)) : [];
  const models = [...new Set(model ? [model, ...shared] : shared)];
  return models.length > 1 ? { limit: "model", limitModels: models } : { limit: "model" };
}

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : {};
  if (code === -32603 && data.errorName === "APIError") {
    const text = [value.message, data.message, data.details].filter((part) => typeof part === "string").join(" ");
    return ACCOUNT_ERROR_TEXT.find(([pattern]) => pattern.test(text))?.[1];
  }
  return undefined;
}

export const classifyOpenCodeGoError = classifyOpenCodeError;

export type { OpenCodeRefreshSchedule };

/** Its status says `freeFallback` while only Zen's free no-login models make it ready (contracts.ts). */
export function createOpenCodeDriver(
  loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels,
  schedule: OpenCodeRefreshSchedule = {},
): ProviderDriver<AcpConfig> {
  const ownAccess = new Map<string, boolean>();
  const driver = createAcpDriver(support(loadCatalog, ownAccess, schedule));
  return {
    ...driver,
    async create(input) {
      const instance = await driver.create(input);
      keepOpenCodeModelsFresh(instance, input.instanceId, schedule);
      const read = instance.snapshot.bind(instance);
      instance.snapshot = async () => {
        const snapshot = await read();
        const own = ownAccess.get(input.instanceId);
        return snapshot.state === "available" && snapshot.authenticated === true && own !== undefined
          && openCodeFreeFallback(own, instance.models) ? { ...snapshot, freeFallback: true } : snapshot;
      };
      return instance;
    },
  };
}

export const createOpenCodeGoDriver = createOpenCodeDriver;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = OpenCodeDriver;

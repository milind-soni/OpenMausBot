// The maintained OpenCode CLI through its ACP stdio interface. OpenCode is
// the harness; Zen, Go, OpenRouter, and user-configured/local providers are
// models discovered from that harness rather than separate OpenMaus drivers.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

import { ATTACHMENTS_DIR } from "../../attachments.ts";
import { cloudHomeConfigured } from "../../cloud-home.ts";
import { DATA_DIR, OPENCODE_PROVIDER_ENV } from "../../config.ts";
import { hostedWorkspaceConfigured } from "../../enterprise.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, offeredModels, type AccountErrorCode, type AcpSupport } from "./core.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { titleCaseModelId } from "../../contracts.ts";
import { execCli, killCliTree, spawnCli } from "../../procs.ts";

/** Nothing is offered until OpenCode itself answers. An invented default is
 * exactly what broke bots when Zen retired `x-preview-f-free`. */
const NO_MODELS: ModelCatalog = { default: "", options: [] };

/** The last catalog each OpenCode binary reported, so a failed refresh keeps
 * a usable picker and the setup check needs no process of its own. */
const lastSuccessfulCatalog = new Map<string, ModelCatalog>();
/** Zen prices from `models --verbose` (V1): cost 0 means free. V2 prints no
 * metadata, so an id ending in `-free` is the fallback signal. */
const freeModels = new Set<string>();
const paidModels = new Set<string>();

const DISCOVERY_TIMEOUT_MS = 20_000;
const DISCOVERY_PROBE_TTL_MS = 30_000;
const discoveryProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

function labelForModel(id: string): string {
  return titleCaseModelId(id, /[-_.]+/);
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

/** Whether a model costs nothing to run: Zen's own price when `models
 * --verbose` reported one, else the `-free` suffix Zen gives free models. */
export function isFreeOpenCodeModel(id: string): boolean {
  if (freeModels.has(id)) return true;
  if (paidModels.has(id)) return false;
  return /(?:^|[-_/])free$/iu.test(id);
}

/** The model OpenMaus runs when nobody chose one, or when the chosen one is
 * gone. OpenCode's own pick (`current`) wins when it is free. Otherwise a
 * free model does: OpenCode 2 with a key picks a paid model on its own, and
 * a silent switch to per-token billing is not ours to make. Only an
 * all-paid catalog (the person's own providers) falls back to OpenCode's
 * pick. */
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

/** Parse the metadata printed by `opencode models --verbose` (V1 only).
 *
 * The output is a sequence of `provider/model` header lines, each followed
 * by one JSON object. Model IDs can themselves contain `/` (OpenRouter), so
 * only the first separator identifies the provider. Older CLIs may print just
 * the headers; those still produce a usable catalog without metadata. */
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
      } catch {
        // A header-only/older CLI remains useful; fall back to the model id.
      }
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

/** The `models --verbose` inventory as a catalog (V1). Discovery prefers the
 * ACP session's own list and uses this only for metadata; it remains the
 * catalog when the ACP probe cannot answer. */
export function parseOpenCodeModelsOutput(stdout: string): ModelCatalog | null {
  const parsed = parseOpenCodeModels(stdout);
  if (!parsed.options.length) return null;
  rememberPrices(parsed);
  return { default: preferredOpenCodeModel(parsed.options.map((option) => option.id)), options: parsed.options };
}

/** The catalog OpenCode itself offers a session, from the `model` select in
 * session/new's configOptions: the exact ids `session/set_config_option`
 * accepts, in the exact environment of the process. Same list as `opencode
 * models` on V1 and the only reliable one on V2. */
export function catalogFromOpenCodeSession(result: unknown): { options: ModelCatalog["options"]; current: string | null } | null {
  const configOptions = (result as { configOptions?: unknown } | null)?.configOptions;
  const model = Array.isArray(configOptions)
    ? configOptions.find((option: any) => option?.id === "model" && option?.type === "select")
    : null;
  const ids = offeredModels(result, "model");
  if (!model || !ids.length) return null;
  const names = new Map<string, string>();
  const visit = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string" && typeof entry.name === "string") names.set(entry.value, entry.name);
      else if (Array.isArray(entry?.options)) visit(entry.options);
    }
  };
  visit(model.options);
  const options = [...new Set(ids)].filter(validModelSlug).map((id) => {
    const separator = id.indexOf("/");
    // V1 names "OpenCode Zen/Big Pickle", V2 "opencode/Big Pickle": the
    // provider comes from the id either way.
    const raw = names.get(id)?.trim() ?? "";
    const name = (raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw).trim() || labelForModel(id.slice(separator + 1));
    return { id, label: `${providerLabel(id.slice(0, separator))} · ${name}` };
  });
  return options.length
    ? { options, current: typeof (model as any).currentValue === "string" ? (model as any).currentValue : null }
    : null;
}

function runOpenCodeModelsVerbose(
  cli: string,
  environment: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execCli(
      cli,
      ["models", "--verbose"],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: environment },
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

function runGit(directory: string, args: string[]): Promise<void> {
  // The person's git settings stay out: no signing prompt, no hooks, no
  // repository named by a GIT_* variable.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((resolveRun, rejectRun) => {
    execFile("git", [
      "-c", "user.name=OpenMaus", "-c", "user.email=model-discovery@openmaus.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(directory, ".git", "no-hooks")}`,
      ...args,
    ], { cwd: directory, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: 10_000, windowsHide: true }, (error) => {
      if (error) rejectRun(error);
      else resolveRun();
    });
  });
}

let discoveryFolder: Promise<string> | null = null;

/** A folder OpenMaus owns for catalog probes, made its own git project once.
 * OpenCode records every session, empty ones included, under the project of
 * its working folder, and every folder outside git shares one global project:
 * `opencode run --continue` in any of them would resume OpenMaus's empty probe
 * instead of the person's last session. Without git the probe still works and
 * its session lands in the global list, as before. */
function discoveryDirectory(): Promise<string> {
  discoveryFolder ??= (async () => {
    const directory = join(DATA_DIR, "providers", "opencode", "discovery");
    mkdirSync(directory, { recursive: true });
    const marker = join(directory, ".openmaus-project");
    if (!existsSync(marker)) {
      try {
        await runGit(directory, ["init", "-q"]);
        await runGit(directory, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "OpenMaus model discovery"]);
        writeFileSync(marker, "OpenCode files this folder's sessions under its own project.\n");
      } catch {
        // No git: probes run here all the same.
      }
    }
    return directory;
  })();
  return discoveryFolder;
}

/** Open one ACP session on the binary and environment a turn uses, and
 * return what session/new answered. No prompt is sent and the process is
 * stopped as soon as the answer arrives. */
export async function probeOpenCodeSession(
  cli: string,
  environment: Record<string, string | undefined>,
  folder?: string,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<unknown> {
  const cwd = folder ?? await discoveryDirectory();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, ["acp"], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let buffer = "";
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const write = (message: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {}
    };
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      void killCliTree(child);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(Object.assign(new Error("OpenCode did not list its models in time"), { timedOut: true })),
      timeoutMs,
    );
    timer.unref?.();
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(new Error(`OpenCode exited ${code} while listing its models`)));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== undefined && typeof message.method === "string") {
          // A probe answers no request: refuse rather than leave it hanging.
          write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
          continue;
        }
        const waiter = typeof message?.id === "number" ? pending.get(message.id) : undefined;
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(Object.assign(new Error(String(message.error.message ?? "ACP request failed")), {
            code: message.error.code,
            data: message.error.data,
          }));
        } else waiter.resolve(message.result);
      }
    });
    const request = (method: string, params: unknown) => new Promise<unknown>((resolveRequest, rejectRequest) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      write({ jsonrpc: "2.0", id, method, params });
    });
    void (async () => {
      await request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "openmausbot", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      return request("session/new", { cwd, mcpServers: [] });
    })().then((result) => finish(null, result), (error: Error) => finish(error));
  });
}

/** Ask the same OpenCode binary that will run ACP for its effective catalog.
 *
 * The list comes from an ACP session/new in the turn's own environment: it
 * is what the session will accept, on OpenCode 1 and 2 alike. `models
 * --verbose` (OpenCode 1 only; 2 rejects the flag) runs alongside for
 * metadata the session does not carry: prices, context windows, reasoning
 * variants, and which models are local. Plain `opencode models` is not a
 * fallback: on OpenCode 2 it answers from a shared background service that
 * keeps whatever environment it started with, and its first answer after
 * that service starts is empty. */
export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
): Promise<ModelCatalog> {
  const probeSession = () => probeOpenCodeSession(cli, environment);
  const readMetadata = () => runOpenCodeModelsVerbose(cli, environment).then(parseOpenCodeModels);
  let [session, verbose] = await Promise.allSettled([probeSession(), readMetadata()]);
  // Two OpenCode processes starting together in a home that has never run
  // OpenCode race to create its database, and one of them fails (seen 1 in 8
  // fresh homes). Once is enough to lose Zen's prices, which is what keeps a
  // paid model from becoming the default, so a failed half runs again alone.
  // A half that timed out is not retried: a wedged CLI must not double the
  // wait at startup.
  const retry = (result: PromiseSettledResult<unknown>) =>
    result.status === "rejected" && (result.reason as { timedOut?: boolean } | null)?.timedOut !== true;
  if (retry(session)) [session] = await Promise.allSettled([probeSession()]);
  if (retry(verbose)) [verbose] = await Promise.allSettled([readMetadata()]);
  const metadata = verbose.status === "fulfilled" ? verbose.value : null;
  if (metadata) rememberPrices(metadata);
  const live = session.status === "fulfilled" ? catalogFromOpenCodeSession(session.value) : null;
  let catalog: ModelCatalog | null = null;
  if (live) {
    const details = new Map((metadata?.options ?? []).map((option) => [option.id, option]));
    const options = live.options.map((option) => ({ ...option, ...details.get(option.id), id: option.id }));
    catalog = { default: preferredOpenCodeModel(options.map((option) => option.id), live.current), options };
  } else if (metadata?.options.length) {
    catalog = { default: preferredOpenCodeModel(metadata.options.map((option) => option.id)), options: metadata.options };
  }
  if (!catalog) return lastSuccessfulCatalog.get(cli) ?? NO_MODELS;
  lastSuccessfulCatalog.set(cli, catalog);
  return catalog;
}

/** Whether this OpenCode can run a turn at all: it offers at least one
 * model. Zen's free models need no login, so a working CLI almost always
 * can. Answered from the last discovery when there is one. */
export async function canRunOpenCode(
  environment: Record<string, string | undefined>,
  cli: string,
  discover: OpenCodeCatalogLoader = discoverOpenCodeModels,
): Promise<boolean> {
  if (lastSuccessfulCatalog.get(cli)?.options.length) return true;
  const cached = discoveryProbeCache.get(cli);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const entry = { expiresAt: Number.POSITIVE_INFINITY, result: Promise.resolve(false) };
  entry.result = discover(environment, cli)
    .then((catalog) => catalog.options.length > 0, () => false)
    .finally(() => {
      entry.expiresAt = Date.now() + DISCOVERY_PROBE_TTL_MS;
    });
  discoveryProbeCache.set(cli, entry);
  return entry.result;
}

export function resetOpenCodeModelCache() {
  discoveryFolder = null;
  lastSuccessfulCatalog.clear();
  discoveryProbeCache.clear();
  freeModels.clear();
  paidModels.clear();
}

/** Compatibility export for older tests/imports while the product migrates
 * from the Go-only name. */
export const resetOpenCodeGoModelCache = resetOpenCodeModelCache;

/** The names live in config.ts, beside the keys the owner saves for OpenCode. */
export { OPENCODE_PROVIDER_ENV };

/** Whether OpenCode may read provider keys from the server's own
 * environment. Only when that environment is the person's own shell: not on a
 * Cloud home, a hosted team workspace or an organisation-managed desktop, and
 * not on a server whose sign-in list lets other people in, where every
 * member's bot would otherwise run on, and bill, the operator's key. */
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

/** The server sets this before any driver is created, and narrows it with
 * Company enrollment and its sign-in list. */
export function setOpenCodeProviderKeyPolicy(allowed: () => boolean): void {
  providerKeysAllowed = allowed;
}

let ownProviderKeys = (): Readonly<Record<string, string>> => ({});

/** The keys the owner saved for OpenCode in Settings (config.ts
 * openCodeProviderKeys). The server sets this beside the policy above. */
export function setOpenCodeOwnProviderKeys(keys: () => Readonly<Record<string, string>>): void {
  ownProviderKeys = keys;
}

function withholdProviderKeysWhenManaged(env: Record<string, string | undefined>): void {
  if (providerKeysAllowed()) return;
  const own = ownProviderKeys();
  for (const key of OPENCODE_PROVIDER_ENV) {
    // A key the owner saved for OpenCode in Settings is theirs to use on any
    // server. Only that exact value: the server's own key under the same
    // name still stays out.
    if (own[key] !== undefined && env[key] === own[key]) continue;
    delete env[key];
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

/** Whether `path` is `folder` itself or somewhere inside it. */
function withinFolder(path: string, folder: string): boolean {
  const rest = relative(resolvePath(folder), resolvePath(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Whether a turn works in one of OpenMaus's own folders: a bot's shared
 * folder or a conversation's private one (server/workspace.ts). Everything in
 * them was written by bots, so none of it may become OpenCode configuration. */
export function openMausOwnsWorkingFolder(cwd: string): boolean {
  return [join(DATA_DIR, "workspaces"), join(DATA_DIR, "task-workspaces")].some((root) =>
    withinFolder(cwd, root) && resolvePath(cwd) !== resolvePath(root));
}

/** Folders OpenMaus owns that an OpenCode bot may use outside its working
 * folder without an approval card: the attachments people send (every turn
 * that read one stalled on a card) and this bot's own shared folder, which
 * holds the memory its prompt points at.
 *
 * Never a folder at or above the turn's working folder. OpenCode reads
 * opencode.json, .opencode/ and AGENTS.md from every folder above its working
 * folder, so a file planted there would configure the bot's later
 * conversations: one prompt-injected turn could allow every folder for good.
 * That is also why earlier conversations (task-workspaces/<bot>, the parent of
 * every conversation's folder) still ask.
 *
 * Accepted: OpenCode's folder rule covers writes as well as reads, and it
 * allows edits and shell by default, so a bot can also change or delete files
 * in the attachments folder, which holds every conversation's uploads under
 * random names. Its edit rules match paths relative to the project and its
 * shell rules match command text, so neither can fence one folder reliably. */
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

/** The folder rule the person's own OpenCode config ends with, when it is a
 * single action ("deny", "ask" or "allow") rather than a folder map.
 * OPENCODE_PERMISSION is merged over the config and an object replaces a
 * string, so without this OpenMaus's folder list would quietly turn a "deny"
 * into OpenCode's default "ask". A folder map needs nothing: the two maps
 * merge. Sources in OpenCode's own order: global config, OPENCODE_CONFIG,
 * project files from the root down (unless project config is off), the
 * .opencode folders, then OPENCODE_CONFIG_CONTENT. */
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
    // Up to the git root, or the top of the disk outside git.
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

/** OpenCode asks before a tool touches a folder outside the session's
 * working folder (its `external_directory` permission), which stalled every
 * turn that read an attachment on an approval card. Allow exactly the
 * folders OpenMaus owns for this bot; every other folder keeps the person's
 * rule, or OpenCode's default "ask". The rules depend only on the bot and the
 * working folder, so a conversation keeps one process. */
function allowOwnedDirectories(env: Record<string, string | undefined>, botId: string | undefined, cwd: string): void {
  let permission: Record<string, unknown> = {};
  if (env.OPENCODE_PERMISSION) {
    try {
      const parsed = JSON.parse(env.OPENCODE_PERMISSION) as unknown;
      // A policy the person set that is not an object is theirs to keep.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      permission = parsed as Record<string, unknown>;
    } catch {
      return;
    }
  }
  const directories = openCodeOwnedDirectories(botId, cwd);
  if (!directories.length) return;
  const existing = permission.external_directory;
  // OpenCode evaluates rules in order and the last match wins, so these go
  // after anything already there: the person's single action first as "*",
  // then OpenMaus's folders.
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

/** Account failures in plain words, with the fix, naming the provider that
 * refused: with provider keys and `opencode auth login` a model may be
 * OpenRouter's or Anthropic's, not Zen's. Each stays under the 160
 * characters a chat error row shows. Zen and Go take the key saved in
 * Settings. On a Cloud the owner has no terminal for `opencode auth login`:
 * another provider's key is saved under Keys for other OpenCode providers. */
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

/** OpenCode's logins, as one value that changes when `opencode auth login`
 * adds or replaces one. A running `opencode acp` never reads auth.json again,
 * so a conversation's process must be replaced once it changes. */
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

const support = (loadCatalog: OpenCodeCatalogLoader): AcpSupport => ({
  driverKind: "opencodeGo",
  // Keep the historical driver kind so existing bots and instance config do
  // not break; only the product name/catalog expand from Go to OpenCode.
  displayName: "OpenCode",
  models: NO_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote: "OpenCode has no usable models. Add an OpenCode key in Settings → API keys.",
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
  credentialEnv: ["OPENCODE_API_KEY", ...OPENCODE_PROVIDER_ENV],
  selectModel: { configId: "model" },
  // A retired id (x-preview-f-free, the Ox Alpha preview) or none at all:
  // the catalog default when this session offers it, else the session's own.
  fallbackModel: (sessionConfig, catalogDefault) => {
    const offered = offeredModels(sessionConfig, "model");
    if (catalogDefault && offered.includes(catalogDefault)) return catalogDefault;
    return preferredOpenCodeModel(offered, catalogFromOpenCodeSession(sessionConfig)?.current) || null;
  },
  modelVariants: true,
  resolveTurnModel: (model, env) => model ? ensureOpenCodeInjectModel(model, env) : model,
  transformEnv: withholdProviderKeysWhenManaged,
  spawnFingerprint: openCodeLoginsFingerprint,
  applyTurnEnv: (env, { fullAuto, botId, cwd }) => {
    // In OpenMaus's own folders nothing is the person's project: a bot wrote
    // it, and OpenCode would otherwise take it as configuration.
    if (openMausOwnsWorkingFolder(cwd)) env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    if (!fullAuto) {
      allowOwnedDirectories(env, botId, cwd);
      return;
    }
    // Scope native permissions to this child, not the user's OpenCode config.
    // A wildcard alone leaves OpenCode's more-specific external-directory and
    // read rules in place. Replace the built-in rules as well, including path
    // maps, so Full means the same thing inside the provider and in OMB.
    env.OPENCODE_PERMISSION = JSON.stringify(Object.fromEntries([
      "*", "external_directory", "read", "edit", "bash", "glob", "grep",
      "list", "task", "lsp", "skill", "webfetch", "websearch", "codesearch",
      "todoread", "todowrite", "doom_loop",
    ].map((permission) => [permission, "allow"])));
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  // Setup status only. Turns are never gated on it: a missing or rejected
  // key comes back from the prompt itself and is shown with its fix.
  isAuthenticated: async (env, config) => (
    Boolean(env.OPENCODE_API_KEY)
    || hasStoredOpenCodeAuth(env)
    || await canRunOpenCode(env, config.cli, loadCatalog)
  ),
  classifyError: classifyOpenCodeError,
  describeAccountError: describeOpenCodeAccountError,
  resolveModels: async (environment, config) => mergeLocalInject(
    await loadCatalog(environment, config.cli),
    environment,
  ),
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

/** OpenCode 1.18 reports a provider's account refusal as a JSON-RPC internal
 * error wrapping an APIError; only the text says which. Recorded from the
 * real CLI: `{code: -32603, message: "Internal error: Invalid API key.",
 * data: {service: "session", errorName: "APIError"}}`. */
const ACCOUNT_ERROR_TEXT: ReadonlyArray<readonly [RegExp, AccountErrorCode]> = [
  [/insufficient (?:account )?(?:funds|balance|credits?)|out of credits?|no credits? (?:left|remaining)|payment required|\b402\b/iu, "insufficient_funds"],
  // Not plain "rate limit exceeded": that is a transient 429, which OpenCode
  // retries itself and automatic recovery may still route around.
  [/\bquota\b|usage limit|(?:hourly|daily|weekly|monthly|5-hour) limit/iu, "quota_or_region_restriction"],
  [/\bsubscription\b/iu, "inactive_subscription"],
  // "User not found." is OpenRouter's refusal of an unknown key (recorded
  // through opencode 1.18.27 after `opencode auth login` with a dummy key).
  [/invalid api key|api key (?:is )?(?:invalid|missing|revoked|expired)|incorrect api key|unauthori[sz]ed|\b401\b|authentication (?:failed|required)|(?:^|internal error: )user not found\b/iu, "invalid_credentials"],
];

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

export function createOpenCodeDriver(loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  return createAcpDriver(support(loadCatalog));
}

export const createOpenCodeGoDriver = createOpenCodeDriver;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = OpenCodeDriver;

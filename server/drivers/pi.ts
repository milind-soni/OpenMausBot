// pi — the pi coding agent (@earendil-works/pi-coding-agent) as a native engine.
//
// pi exposes a JSON-RPC mode over stdio (`pi --mode rpc --no-session`) rather
// than ACP, so — like the Claude Code and Codex CLIs — it gets a native driver
// that speaks its own protocol and emits canonical RuntimeEvents. pi is a
// BYOK agent: credentials live in ~/.pi/agent/auth.json and are injected by
// the pi binary itself, so this driver holds no API key and needs no sign-in.
//
// Conversation continuity: the first turn sends `new_session` and remembers
// the returned `sessionFile`; later turns send `switch_session` with that
// path (the way Claude Code resumes by session id). `sessionFile` is the
// resumeCursor the harness persists per thread.
//
// Model ids in the picker are `provider/modelId` composites (e.g.
// `ollama-cloud/glm-5.2`); `set_model` splits that into pi's separate
// `{provider, modelId}` fields. Live local hosts (oMLX / Ollama / EXO /
// LM Studio / Unsloth) land as `host::model` inject ids the same way the
// other engines do: mergeLocalInject lists them in Custom, and a pick
// upserts ~/.pi/agent/models.json so pi can reach the host. The live
// catalog is probed from `get_available_models` and every entry is flagged
// `custom` because pi is a custom-only (BYOK) engine — the model picker's
// Local pane only lists `custom` options for custom-only engines.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import {
  deletePromptSplitReceipt,
  promptHalves,
  readPromptSplitReceipt,
  splitSessionPrompt,
  writePromptSplitReceipt,
} from "./prompt-split.ts";
import type { PromptSplitReceipt } from "./prompt-split.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";

import type {
  DriverCreateInput,
  EffortLevel,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerOutcome,
  TurnImageInput,
} from "../contracts.ts";
import { EFFORT_LEVELS } from "../../shared/wire.ts";
import { newEventId, newId } from "../contracts.ts";
import { parseAskQuestions, parseChoices, questionAnswersByQuestion } from "../../shared/ask-question.ts";
import {
  decodeInjectId,
  encodeInjectId,
  hostApiKey,
  localHost,
  mergeLocalInject,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { canUseMcpServer, parseToolScope } from "../../shared/tool-scope.ts";
import { gateServer, mcpStdioServer, resultBudget } from "../mcp-gate-config.ts";

const DRIVER_KIND = "piAgent";
const PI_ARGS = ["--mode", "rpc", "--no-session"];
const PI_MODEL_UPDATE_ARGS = ["update", "--models", "--no-approve"];
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };
/** After this many bare turns on one pi session the full prompt rides
 * again even without a compaction event: any history rewrite the events
 * miss (an older pi, a missed line) still loses at most this many turns
 * of standing instructions instead of the rest of the session. */
const PI_PROMPT_RE_ANCHOR_TURNS = 8;
/** How long the driver keeps listening after a finished turn_end for the
 * run's terminal agent_end before settling anyway: a runtime that never
 * emits agent_end still completes, while one that does cancels the wait. */
const PI_AGENT_END_GRACE_MS = 60_000;

/** pi answered a command with success:false — an explicit refusal from a
 * live runtime, not a transport failure. Only steer branches on the
 * difference today ("refused": provably not delivered, safe to re-queue);
 * the handshake commands keep their catch-all ignore. */
class PiRpcRefusalError extends Error {}

type PiPromptImage = {
  type: "image";
  data: string;
  mimeType: TurnImageInput["mime"];
};

function readPiPromptImages(turn: SendTurnInput): PiPromptImage[] {
  return (turn.images ?? []).map((image) => ({
    type: "image",
    data: readFileSync(image.path).toString("base64"),
    mimeType: image.mime,
  }));
}

/** Provider-native logs are designed for bug reports. Preserve the RPC
 * shape and encoded size, but never persist a user's image bytes in them. */
function piNativeLogMessage(message: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(message.images)) return message;
  return {
    ...message,
    images: message.images.map((image) => {
      if (!image || typeof image !== "object") return image;
      const value = image as Record<string, unknown>;
      return typeof value.data === "string"
        ? { ...value, data: `[image data: ${value.data.length} base64 chars]` }
        : value;
    }),
  };
}

/** Harness effort → pi thinking level (`set_thinking_level`). The sets match
 * one-for-one except for the name of the lowest rung: the harness calls it
 * "none", pi calls it "off". Exported for the test. */
export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

/** Mirror of the Claude driver's integration → stdio MCP mount: every entry is
 * a JSON-RPC 2.0 stdio server the pi-mcp-extension consumes. Returns null when
 * there is nothing to mount (the common case). */
export function buildMcpServers(turn: SendTurnInput): Record<string, unknown> | null {
  const parsed = parseToolScope(turn.toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const servers: Record<string, unknown> = {};
  if (turn.integrations?.composio) servers.composio = { ...turn.integrations.composio };
  if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
      // Host control carries scope so the extension gates every call behind
      // a permission card; isolated computers deliberately omit it.
      ...(local.scope ? { scope: local.scope } : {}),
    };
  }
  if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };
  if (turn.integrations?.phone) servers.phone = { ...turn.integrations.phone };
  if (turn.integrations?.dweb) {
    servers.dweb = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_ENV_FLAG, DWEB_URL: turn.integrations.dweb.url },
    };
  }
  if (turn.integrations?.browser) servers.browser = { ...turn.integrations.browser };
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) servers[name] = { ...server, scope: "custom" };
  for (const [name, server] of Object.entries(servers)) {
    if (parsed.scope !== undefined && !canUseMcpServer(parsed.scope, name)) { delete servers[name]; continue; }
    const gated = gateServer({ name, server, toolScope: parsed.scope, threadId: turn.threadId, budget: name in (turn.integrations?.custom ?? {}) ? resultBudget() : 0, nodeEnv: NODE_ENV_FLAG });
    const stdio = gated ?? mcpStdioServer(server, { nodeEnv: NODE_ENV_FLAG });
    if (!stdio) throw new Error("Pi MCP server configuration is invalid");
    const original = server as { scope?: string };
    servers[name] = { ...stdio, ...(original.scope ? { scope: original.scope } : {}) };
  }
  return Object.keys(servers).length ? servers : null;
}

/** A pi `get_available_models` response payload, parsed at its I/O boundary. */
interface PiModelEntry {
  provider: string;
  id: string;
  name?: string;
}
interface PiModelsResponse {
  type: "response";
  command: "get_available_models";
  success: boolean;
  data?: { models?: PiModelEntry[] };
}

/** Pure parser: turn a `get_available_models` stdout blob into a catalog.
 *  Every option is `custom` (pi is BYOK) and id is the `provider/modelId`
 *  composite the picker and `set_model` both use. Exported for the test. */
export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  const options: Array<{ id: string; label: string; custom: true; provider: string }> = [];
  let def = fallbackDefault;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const res = msg as PiModelsResponse;
    if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) continue;
    for (const m of res.data?.models ?? []) {
      if (!m?.provider || !m?.id) continue;
      const id = `${m.provider}/${m.id}`;
      options.push({ id, label: m.name ?? m.id, custom: true, provider: m.provider });
    }
    break;
  }
  if (!def && options.length) def = options[0]!.id;
  return { default: def, options };
}

/** Split a picker id into pi's `{provider, modelId}`. Accepts both the
 *  native `provider/modelId` composite and a live-host `host::model`
 *  inject id. */
export function splitPiModel(id: string): { provider: string; modelId: string } | null {
  const inject = decodeInjectId(id);
  if (inject) return { provider: inject.host, modelId: inject.model };
  if (!id.includes("/")) return null;
  const [provider, ...rest] = id.split("/");
  if (!provider || !rest.length) return null;
  return { provider, modelId: rest.join("/") };
}

/** Prefer live `host::model` inject rows over the same model already
 *  listed as `host/model` from ~/.pi/agent/models.json, so Custom does
 *  not show duplicates. */
export function preferPiInjectRows(catalog: ModelCatalog): ModelCatalog {
  const injectIds = new Set(
    catalog.options.filter((option) => decodeInjectId(option.id)).map((option) => option.id),
  );
  if (!injectIds.size) return catalog;
  const options = catalog.options.filter((option) => {
    if (decodeInjectId(option.id)) return true;
    const slash = option.id.indexOf("/");
    if (slash <= 0) return true;
    return !injectIds.has(encodeInjectId(option.id.slice(0, slash), option.id.slice(slash + 1)));
  });
  let def = catalog.default;
  if (def && !options.some((option) => option.id === def)) {
    const slash = def.indexOf("/");
    const mapped = slash > 0 ? encodeInjectId(def.slice(0, slash), def.slice(slash + 1)) : "";
    def = injectIds.has(mapped) ? mapped : (options[0]?.id ?? "");
  }
  return { default: def, options };
}

export async function applyPiLocalCatalog(
  catalog: ModelCatalog,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  return preferPiInjectRows(await mergeLocalInject(catalog, env, fetchImpl));
}

function piAgentDir(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".pi", "agent");
}

/** Upsert a live local host into ~/.pi/agent/models.json so `set_model`
 *  can reach it. Existing providers and models are kept. Returns the
 *  `{provider, modelId}` pair pi's RPC expects, or null when the picker
 *  id is not a model at all. */
export function ensurePiInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): { provider: string; modelId: string } | null {
  const split = splitPiModel(modelId);
  if (!split) return null;
  const inject = decodeInjectId(modelId);
  if (!inject) return split;
  const host = localHost(inject.host);
  if (!host) return split;

  const dir = piAgentDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "models.json");
  let root: Record<string, unknown> = { providers: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      } else {
        // Malformed — do not destroy the file; still return the split so
        // set_model can try.
        return split;
      }
    } catch {
      return split;
    }
  }

  const providers =
    root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing: Record<string, unknown> =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          baseUrl: host.baseUrl,
          api: "openai-completions",
          apiKey: hostApiKey(host, env),
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
          models: [] as Array<Record<string, unknown>>,
        };
  existing.baseUrl = host.baseUrl;
  existing.api = typeof existing.api === "string" && existing.api ? existing.api : "openai-completions";
  existing.apiKey = hostApiKey(host, env);
  if (!existing.compat) {
    existing.compat = { supportsDeveloperRole: false, supportsReasoningEffort: true };
  }
  const models: Array<Record<string, unknown>> = Array.isArray(existing.models)
    ? existing.models.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];
  if (!models.some((row) => row.id === inject.model)) {
    models.push({
      id: inject.model,
      name: inject.model,
      reasoning: true,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 16384,
    });
  }
  existing.models = models;
  providers[inject.host] = existing;
  root.providers = providers;
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
  return split;
}

/** The pi-side default model, read from ~/.pi/agent/settings.json so the
 *  catalog's `default` matches what `pi` would actually run. Missing file →
 *  empty string, and the first option is used instead. */
function readPiDefaultModel(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const s = JSON.parse(readFileSync(`${home}/.pi/agent/settings.json`, "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    return s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "";
  } catch {
    return "";
  }
}

/** Probe the live catalog by spawning `pi --mode rpc --no-session`, sending
 *  `get_available_models`, and parsing the response. A failed probe resolves
 *  with an empty catalog — the instance reports unavailable via snapshot. */
export async function fetchPiModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<ModelCatalog> {
  const child = spawnCli(cli, PI_ARGS, { stdio: ["pipe", "pipe", "pipe"], env });
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const fallbackDefault = readPiDefaultModel(env);
    const finish = (catalog: ModelCatalog) => {
      if (done) return;
      done = true;
      try {
        killCliTree(child);
      } catch {
        /* already gone */
      }
      resolve(catalog);
    };
    const timer = setTimeout(() => finish({ default: "", options: [] }), 15_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const parsed = parsePiCatalog(line + "\n", fallbackDefault);
        if (parsed.options.length || line.includes('"get_available_models"')) {
          clearTimeout(timer);
          finish(parsed);
          return;
        }
      }
    });
    child.on("error", () => finish({ default: "", options: [] }));
    child.on("close", () => finish({ default: "", options: [] }));
    try {
      child.stdin.write(JSON.stringify({ id: "catalog", type: "get_available_models" }) + "\n");
    } catch {
      finish({ default: "", options: [] });
    }
  });
}

/** Refresh pi's provider-owned catalog cache. This is deliberately called
 * only by the explicit model-picker refresh action, never during app startup.
 * Failure is non-fatal: the caller still probes the last usable cache. */
export async function updatePiModelCatalog(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  return new Promise((resolve) => {
    execCli(
      cli,
      PI_MODEL_UPDATE_ARGS,
      { env, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error) => resolve(!error),
    );
  });
}

export interface PiConfig {
  cli: string;
  /** Full-auto: never ask before an action. Host control is unavailable in
   * this mode — the same knob as Claude's `bypassPermissions` and the ACP
   * engines' `fullAuto`. */
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): PiConfig {
  if (raw === null || raw === undefined) return { cli: "pi", fullAuto: false };
  if (typeof raw !== "object") throw new Error("pi config must be an object");
  const obj = raw as { cli?: unknown; fullAuto?: unknown };
  if (obj.cli !== undefined && typeof obj.cli !== "string") throw new Error("pi config `cli` must be a string");
  if (obj.fullAuto !== undefined && typeof obj.fullAuto !== "boolean") throw new Error("pi config `fullAuto` must be a boolean");
  return {
    cli: obj.cli && obj.cli.trim() ? obj.cli.trim() : "pi",
    fullAuto: obj.fullAuto === true,
  };
}

const EMPTY: ModelCatalog = { default: "", options: [] };

/** The parsed pi RPC event we branch on — only the fields this driver reads. */
interface PiEvent {
  type: string;
  // response
  command?: string;
  success?: boolean;
  data?: unknown;
  // message_update
  assistantMessageEvent?: { type?: string; delta?: string };
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // turn_end / message_end
  message?: { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
  usage?: { input?: number; output?: number };
  // agent_end / agent_settled
  isTerminal?: boolean;
  willRetry?: boolean;
  // extension_ui_request
  id?: string;
  method?: string;
  options?: unknown[];
  title?: string;
}

function piEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, PATH: augmentedPath() };
  // pi is BYOK and reads provider keys straight from its environment: an
  // inherited key would silently flip billing onto one the user never granted
  // pi, and workspace credentials are the harness's secrets, not pi's. The
  // keys pi may use live in its own settings file, so the child inherits
  // neither list.
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  return env;
}

export const PiDriver: ProviderDriver<PiConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "pi", supportsMultipleInstances: true, access: "custom" },
  install: {
    command: {
      darwin: "npm install -g @earendil-works/pi-coding-agent",
      linux: "npm install -g @earendil-works/pi-coding-agent",
      win32: "npm install -g @earendil-works/pi-coding-agent",
    },
    needsNode: true,
    docsUrl: "https://pi.dev",
  },
  models: EMPTY,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<PiConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const catalogEnv = piEnvironment({ ...process.env, ...input.environment });
    let models = EMPTY;
    const readModels = async () => {
      let base = models;
      try {
        const resolved = await fetchPiModels(config.cli, catalogEnv);
        if (resolved.options.length) base = resolved;
      } catch {
        // Keep the last usable catalog when the probe fails.
      }
      try {
        const next = await applyPiLocalCatalog(base, catalogEnv);
        if (next.options.length) models = next;
      } catch {
        if (base.options.length) models = base;
      }
    };
    const refreshModels = async () => {
      await updatePiModelCatalog(config.cli, catalogEnv);
      await readModels();
    };
    // Startup stays local and fast. Only the explicit Refresh button crosses
    // pi's model-catalog network boundary.
    await readModels();

    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread
    const active = new Map<string, {
      stop: () => void;
      turnId: string;
      pending: Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>;
      child?: { stdin: { write: (s: string) => void } };
      steer?: (text: string) => Promise<SteerOutcome>;
    }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      const selection = parseToolScope(turn.toolScope);
      if (!selection.ok) throw new Error(selection.error);
      const toolScope = selection.scope;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      // Per-bot Ask/Auto is authoritative for harness turns. Preserve the
      // legacy instance flag only for direct adapter callers that omit it.
      const fullAuto = turn.approvalMode === undefined ? config.fullAuto : false;
      // Host control always routes through the permission card; full-auto must
      // never get unapproved hands on the user's machine (same guard as the
      // Claude and ACP drivers).
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && fullAuto) {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = newId();
      const pending = new Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>();
      // Ask fail-safe timers, tracked so settle() can cancel them outright:
      // a cleared pending map alone leaves each timer holding the ask
      // closure (send, child) alive until it fires.
      const askTimers = new Set<ReturnType<typeof setTimeout>>();
      let settled = false;
      // the last turn_end's outcome, replayed when the run's terminal
      // agent_end (or the grace fallback) settles the turn
      let endStopReason: string | undefined;
      let endUsage: { input?: number; output?: number } | undefined;
      let endErrorMessage: string | undefined;
      // hang insurance for runtimes with no agent_end frame at all
      let agentEndTimer: ReturnType<typeof setTimeout> | null = null;
      // pi's RPC surface accepts image content directly. Read before spawning
      // so an attachment that disappeared produces one clear dispatch error
      // instead of starting a child that can never receive its prompt.
      const images = readPiPromptImages(turn);

      // Write ~/.pi/agent/models.json before creating any credential-bearing
      // MCP temp files. If model setup fails, there is nothing sensitive to
      // clean up yet.
      if (typeof turn.model === "string" && turn.model) {
        ensurePiInjectModel(turn.model, { ...process.env, ...input.environment });
      }

      // integrations → stdio MCP servers for the pi-mcp-extension. The config
      // carries credentials (boat token, composio key, comms token), so it goes
      // into a 0600 temp file removed when the turn settles — never on argv.
      const mcpServers = buildMcpServers(turn);
      let mcpTempDir: string | null = null;
      let scopeReadyPath: string | undefined;
      if (mcpServers || toolScope !== undefined) {
        mcpTempDir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-"));
        if (toolScope !== undefined) scopeReadyPath = join(mcpTempDir, "scope-ready.json");
        try {
          writeFileSync(join(mcpTempDir, "mcp.json"), JSON.stringify({ mcpServers: mcpServers ?? {}, toolScope, scopeReadyPath, approvalMode: turn.approvalMode }), { mode: 0o600 });
        } catch (err) {
          // A failed write must not leave the temp dir behind — a partial file
          // could still hold the boat token / composio key / comms token.
          try {
            rmSync(mcpTempDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
          throw err;
        }
      }
      const childArgs = mcpTempDir ? [...PI_ARGS, "-e", SPAWNED_PROXIES.piMcpExtension] : PI_ARGS;

      // spawnCli can throw synchronously (unresolvable CLI); if it does, the
      // 0600 temp file with the boat token / composio key / comms token must
      // not be left on disk — settle() never runs because no child existed.
      const child = (() => {
        try {
          return spawnCli(config.cli, childArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: turn.cwd,
            env: piEnvironment({
              ...process.env,
              ...input.environment,
              ...(mcpTempDir ? { OMB_MCP_CONFIG: join(mcpTempDir, "mcp.json") } : {}),
            }),
          });
        } catch (err) {
          if (mcpTempDir) {
            try {
              rmSync(mcpTempDir, { recursive: true, force: true });
            } catch {
              /* best effort */
            }
          }
          throw err;
        }
      })();
      let buf = "";
      let assistantText = "";
      // set when a compaction event arrives this turn; gates the receipt
      // write below so a compacted-around delivery is never claimed
      let compactionObserved = false;
      // resolve one-shot RPC responses (new_session / switch_session / set_model)
      const responseWaiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
      // Steer frames correlate by a unique per-request id, not the shared
      // "steer" command name: two concurrent steers would otherwise overwrite
      // each other's waiter, and a refusal response could reject the wrong
      // caller — requeueing words pi already accepted. Every other command
      // keeps its command-name key.
      let steerSeq = 0;
      const rejectWaiters = (err: Error) => {
        for (const waiter of responseWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        responseWaiters.clear();
      };
      const awaitResponse = (command: string, timeoutMs = 20_000, key = command) =>
        new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            responseWaiters.delete(key);
            reject(new Error(`pi ${command} timed out`));
          }, timeoutMs);
          timer.unref?.();
          responseWaiters.set(key, { resolve, reject, timer });
        });
      child.stdin.on("error", () => rejectWaiters(new Error("pi stdin closed")));
      const send = (obj: Record<string, unknown>) => {
        appendNative(threadId, { dir: "out", source: "pi.rpc", msg: piNativeLogMessage(obj) });
        child.stdin.write(JSON.stringify(obj) + "\n");
      };

      /** Emit buffered assistant text as its own item, then clear it. */
      const flushAssistantText = () => {
        const text = assistantText;
        assistantText = "";
        if (!text.trim()) return;
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
      };

      const settle = (ok: boolean, stopReason?: string | null, usage?: { input?: number; output?: number }) => {
        if (settled) return;
        settled = true;
        if (agentEndTimer) {
          clearTimeout(agentEndTimer);
          agentEndTimer = null;
        }
        // The turn is over: drop unanswered asks so their 15-minute
        // fail-safe timers are cancelled outright instead of no-oping on a
        // dead child while holding the ask closure alive.
        for (const timer of askTimers) clearTimeout(timer);
        askTimers.clear();
        pending.clear();
        flushAssistantText();
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason: stopReason ?? (ok ? "end_turn" : "failed"),
          ...(usage ? { usage: { input: usage.input ?? 0, output: usage.output ?? 0 } } : {}),
        });
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
        try {
          killCliTree(child);
        } catch {
          /* already gone */
        }
        if (mcpTempDir) {
          try {
            rmSync(mcpTempDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
        active.delete(threadId);
      };

      /** Settle from the last turn_end's recorded outcome. Errors surface
       * here, at run completion, so a failed run reports exactly once and
       * only after any scheduled maintenance events had their chance to
       * arrive. */
      const finishRun = () => {
        const sr = endStopReason;
        if (sr === "error" || sr === "failed") {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: String(endErrorMessage ?? "pi turn failed").slice(0, 2_000),
          });
          settle(false, "failed", endUsage);
          return;
        }
        settle(true, sr === "cancelled" || sr === "aborted" ? "cancelled" : "end_turn", endUsage);
      };

      const stop = () => {
        try {
          send({ type: "abort" });
        } catch {
          /* ignore */
        }
        try {
          killCliTree(child);
        } catch {
          /* ignore */
        }
        settle(true, "cancelled");
      };

      // Mid-turn input rides pi's native steer frame — the runtime queues
      // it into the running agent without aborting the in-flight step, and
      // answers success only after session.steer() accepted it. A success:
      // false response is an explicit refusal (nothing consumed the words:
      // safe to re-queue), while a death or timeout after the frame was
      // written leaves the outcome unknowable — those are "indeterminate"
      // so the caller can never run the words twice. Each frame carries a
      // unique id that pi echoes on its response, so concurrent steers on
      // the same turn never share or overwrite a waiter.
      const steerActiveTurn = async (text: string): Promise<SteerOutcome> => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return "refused";
        let ack: Promise<unknown>;
        try {
          const id = `steer:${++steerSeq}`;
          ack = awaitResponse("steer", 20_000, id);
          send({ type: "steer", id, message: text });
        } catch {
          // stdin closed before the frame was written: provably undelivered.
          return "refused";
        }
        try {
          await ack;
          return "steered";
        } catch (error) {
          return error instanceof PiRpcRefusalError ? "refused" : "indeterminate";
        }
      };
      active.set(threadId, { stop, turnId, pending, child, steer: steerActiveTurn });

      const onEvent = (evt: PiEvent) => {
        appendNative(threadId, { dir: "in", source: "pi.rpc", msg: evt });
        switch (evt.type) {
          case "response": {
            // Resolve the echoed request id first (unique per steer);
            // fall back to the command name for the handshake-style call
            // sites, whose responses carry no id.
            const key = typeof evt.id === "string" && responseWaiters.has(evt.id) ? evt.id : evt.command;
            if (key && responseWaiters.has(key)) {
              const waiter = responseWaiters.get(key)!;
              responseWaiters.delete(key);
              clearTimeout(waiter.timer);
              if (evt.success) waiter.resolve(evt.data);
              else waiter.reject(new PiRpcRefusalError(`pi ${evt.command} failed`));
            }
            return;
          }
          case "message_update": {
            const e = evt.assistantMessageEvent;
            if (!e) return;
            if (e.type === "text_delta" && typeof e.delta === "string") {
              assistantText += e.delta;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: e.delta });
            } else if (e.type === "thinking_delta" && typeof e.delta === "string") {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: e.delta });
            }
            return;
          }
          case "tool_execution_start": {
            flushAssistantText();
            emit({
              ...base(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: evt.toolCallId,
              title: String(evt.toolName ?? "tool").slice(0, 80),
              summary: commandSummary(evt.args),
              input: toolDetailPreview(evt.args),
            });
            return;
          }
          case "tool_execution_end": {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "tool",
              itemId: evt.toolCallId,
              ok: !evt.isError,
              output: toolDetailPreview(evt.result),
            });
            return;
          }
          case "extension_ui_request": {
            // pi floods setWidget/setStatus for TUI bookkeeping; only
            // select/confirm/input are questions that wait for an answer.
            if (evt.method === "select" || evt.method === "confirm" || evt.method === "input") {
              flushAssistantText();
              const reqId = evt.id ?? newId();
              const isSelect = evt.method === "select";
              const isQuestion = isSelect || evt.method === "input";
              const selectOptions: string[] = isSelect && Array.isArray(evt.options)
                ? evt.options.filter((option): option is string => typeof option === "string") : [];
              const summary = String(evt.title ?? (isQuestion ? "pi has a question" : "pi wants confirmation")).slice(0, 200);
              // A select is a question with named options; the structured
              // card renders from it while the flat choices keep older
              // clients answering. An input has nothing to pick from and
              // stays the free-text question it always was.
              const question = isSelect
                ? (parseAskQuestions({
                    questions: [{ question: summary, options: selectOptions }],
                  }) ?? [])[0]
                : undefined;
              const choices = question?.options.length ? question.options.map((option) => option.label) : undefined;
              let timer: ReturnType<typeof setTimeout> | undefined;
              // Register BEFORE emitting: the harness may auto-approve from
              // inside its synchronous request.opened listener. Emitting first
              // made respondToRequest see no pending ask, return unavailable,
              // then fall back to a human card on every "Always allow" call.
              pending.set(reqId, (decision) => {
                if (timer) {
                  clearTimeout(timer);
                  askTimers.delete(timer);
                }
                if (decision.behavior === "deny") send({ type: "extension_ui_response", id: reqId, cancelled: true });
                else if (isQuestion) {
                  // Recover the picked label from a structured card's Q:/A:
                  // reply; a flat answer or typed text passes through
                  // verbatim (questionAnswersByQuestion's single-question
                  // fallback does exactly that).
                  const value = question
                    ? questionAnswersByQuestion(decision.message ?? "", [question])[question.question] ?? decision.message ?? ""
                    : decision.message ?? "";
                  // Display labels are capped/trimmed; pi expects the
                  // original option. Never guess if two normalize alike.
                  const matched = selectOptions.filter(option => parseChoices([option], 1)?.[0] === value);
                  send(matched.length > 1
                    ? { type: "extension_ui_response", id: reqId, cancelled: true }
                    : { type: "extension_ui_response", id: reqId, value: matched[0] ?? value });
                }
                else send({ type: "extension_ui_response", id: reqId, confirmed: true });
              });
              // The ask must never hold the turn forever: cancel it after 15
              // minutes. The pending.delete guard makes this a no-op once the
              // turn settled (settle clears pending) or a person answered.
              timer = setTimeout(() => {
                if (timer) askTimers.delete(timer);
                if (!pending.delete(reqId)) return;
                send({ type: "extension_ui_response", id: reqId, cancelled: true });
                emit({
                  ...base(threadId, turnId),
                  requestId: reqId,
                  type: "request.resolved",
                  behavior: "deny",
                  source: "timeout",
                });
              }, 15 * 60_000);
              askTimers.add(timer);
              timer.unref?.();
              emit({
                ...base(threadId, turnId),
                requestId: reqId,
                type: "request.opened",
                requestType: isQuestion ? "question" : "permission",
                tool: String(evt.title ?? "pi"),
                summary,
                ...(choices ? { choices } : {}),
                ...(question ? { questions: [question] } : {}),
              });
            }
            return;
          }
          case "compaction_start":
          case "compaction_end":
          case "auto_compaction_start":
          case "auto_compaction_end": {
            // pi compaction (manual or automatic) summarizes older
            // messages, which can absorb the turn that carried this
            // session's standing prompt. Both events ride the RPC surface
            // for every compaction kind, so the moment either arrives the
            // receipt is dropped and the next turn re-establishes the full
            // prompt. The rest of the compacting turn may still answer
            // without its standing instructions; that single turn is the
            // unavoidable cost of summarizing history mid-session.
            if (sessionReady && sessionFile) {
              compactionObserved = true;
              deletePromptSplitReceipt("pi", JSON.stringify([threadId, sessionFile]));
            }
            return;
          }
          case "turn_end":
          {
            // a killed child can still flush one buffered frame after the
            // turn settled (the abort path's cancelled turn_end is the
            // common one); arming the grace timer then would leak it past
            // a turn that is already complete.
            if (settled) return;
            const sr = evt.message?.stopReason;
            // toolUse means pi ran a tool and auto-continues next turn to
            // answer — the run is not over, and the next turn_end carries
            // the real outcome.
            if (sr === "toolUse" || sr === "tool_use" || sr === "tool_calls") return;
            endStopReason = sr;
            endUsage = evt.usage ?? evt.message?.usage;
            endErrorMessage = evt.message?.errorMessage;
            // agent_end, not turn_end, closes the run: pi can schedule
            // post-run maintenance (overflow-recovery compaction) after
            // the final turn_end, and only the terminal agent_end proves
            // the session is done rewriting itself. The grace timer
            // settles a runtime that never sends agent_end at all.
            if (agentEndTimer) clearTimeout(agentEndTimer);
            agentEndTimer = setTimeout(finishRun, PI_AGENT_END_GRACE_MS);
            agentEndTimer.unref?.();
            return;
          }
          case "agent_end": {
            // Two dialects mark a non-terminal agent_end: upstream pi sets
            // willRetry: true when an automatic retry follows (overflow
            // recovery runs compaction and retries as a fresh run), and the
            // omp fork sets isTerminal: false while maintenance or async
            // delivery has more work scheduled. Either marker means the
            // session may still rewrite the turn that carried this
            // session's standing prompt — keep listening so those events
            // can drop the prompt-split receipt.
            if (evt.isTerminal === false || evt.willRetry === true) return;
            if (agentEndTimer) {
              clearTimeout(agentEndTimer);
              agentEndTimer = null;
            }
            finishRun();
            return;
          }
          case "agent_settled": {
            // upstream pi's explicit fully-settled guarantee: no automatic
            // retry, compaction retry, or queued continuation remains.
            // Usually settles one frame after the final agent_end already
            // did; kept as its own terminal signal so the driver never
            // depends on which dialect the configured cli speaks.
            if (agentEndTimer) {
              clearTimeout(agentEndTimer);
              agentEndTimer = null;
            }
            finishRun();
            return;
          }
          default:
            return;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            onEvent(JSON.parse(line) as PiEvent);
          } catch {
            /* skip non-JSON line */
          }
        }
      });
      child.on("error", (err) => {
        const fail = describeSpawnFailure(err as NodeJS.ErrnoException, config.cli);
        rejectWaiters(new Error(fail.message));
        emit({ ...base(threadId, turnId), type: "runtime.error", message: fail.message, setup: fail.setup });
        settle(false);
      });
      child.on("close", () => {
        // a clean close without a terminal event is a failed turn, never a hang
        rejectWaiters(new Error("pi process exited before replying"));
        settle(false);
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake: resume the remembered session or start a fresh one. The
      // harness persists session.started.sessionId as the resumeCursor and
      // hands it back next turn, so that id IS the resume handle — pi's
      // sessionFile, which switch_session expects as `sessionPath`.
      const sessionPath = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      let sessionFile = sessionPath;
      let sessionReady = false;
      try {
        const command = sessionPath ? "switch_session" : "new_session";
        const hsPromise = awaitResponse(command);
        send(sessionPath ? { type: "switch_session", sessionPath } : { type: "new_session" });
        const hs = (await hsPromise) as { sessionFile?: string; sessionId?: string } | undefined;
        if (hs?.sessionFile) sessionFile = hs.sessionFile;
        sessionReady = true;
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId: sessionFile ?? hs?.sessionId ?? null,
          model: turn.model ?? null,
        });
      } catch {
        // without a session we can still try a bare prompt; pi --no-session
        // accepts a prompt without an explicit session.
      }

      // pin the chosen model (composite id or host::model inject → provider + modelId)
      const chosen = typeof turn.model === "string" ? splitPiModel(turn.model) : null;
      if (chosen) {
        try {
          const modelPromise = awaitResponse("set_model");
          send({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId });
          await modelPromise;
        } catch {
          /* keep going on the default model */
        }
      }

      // pin reasoning effort after the model (the supported level set is
      // model-dependent); a rejection keeps the engine default
      if (turn.effort) {
        try {
          const levelPromise = awaitResponse("set_thinking_level");
          send({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) });
          await levelPromise;
        } catch {
          /* keep going on the engine default */
        }
      }

      if (scopeReadyPath) {
        let ready = false;
        try {
          const receipt = JSON.parse(readFileSync(scopeReadyPath, "utf8")) as { ok?: unknown; toolScope?: unknown };
          ready = receipt.ok === true && JSON.stringify(receipt.toolScope) === JSON.stringify(toolScope);
        } catch { /* Missing or malformed readiness is never a grant. */ }
        if (!ready) {
          const message = "Pi tool selection enforcement is unavailable. Update Pi and check the OpenMausBot extension before retrying.";
          emit({ ...base(threadId, turnId), type: "runtime.error", message });
          settle(false);
          throw new Error(message);
        }
      }

      // The stable/volatile split: the full prompt rides only the turn that
      // establishes - or re-instructs, after a soul edit - this pi session,
      // which previously re-sent the whole system prompt on every turn and
      // let it accumulate in the session file once per turn. pi compacts
      // long sessions by summarizing older messages, which can absorb the
      // turn that carried the prompt, so the driver watches pi's
      // compaction events and drops the receipt the moment one arrives,
      // and re-anchors the full prompt every PI_PROMPT_RE_ANCHOR_TURNS
      // bare turns as a backstop for anything the events miss. Receipts
      // are durable because the session file outlives both the per-turn
      // child and this process. Without a session the prompt is the
      // model's only context, so that turn keeps the full block and writes
      // no receipt.
      const halves = promptHalves(turn);
      let message: string;
      let pendingReceipt: { key: string; receipt: PromptSplitReceipt } | null = null;
      if (halves.stable !== null && sessionReady && sessionFile) {
        const receiptKey = JSON.stringify([threadId, sessionFile]);
        const composed = splitSessionPrompt(
          halves.stable,
          halves.volatile,
          readPromptSplitReceipt("pi", receiptKey),
          turn.system,
          turn.text,
          Boolean(turn.mentionTurn),
          PI_PROMPT_RE_ANCHOR_TURNS,
        );
        message = composed.text;
        pendingReceipt = { key: receiptKey, receipt: composed.receipt };
      } else {
        message = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      }
      // events cannot interleave with this synchronous stretch, so any
      // compaction recorded above already invalidated what compose read
      try {
        // pi answers the prompt with an authoritative response only after
        // preflight accepts it - and rejects it outright while a
        // compaction runs - so the receipt commits only after that
        // acceptance: a rejected or compacted-around send redelivers on
        // the next turn. The wait is long enough to survive a compaction
        // queue; a dead child rejects it immediately.
        // sendTurn still resolves once the prompt is written: a child that
        // dies before replying settles the turn through the close handler,
        // whose waiter sweep can precede this registration.
        const accepted = awaitResponse("prompt", 120_000);
        send({ type: "prompt", message, ...(images.length ? { images } : {}) });
        void accepted.then(
          () => {
            if (!pendingReceipt || compactionObserved) return;
            try {
              writePromptSplitReceipt("pi", pendingReceipt.key, pendingReceipt.receipt);
            } catch {
              /* an unwritten receipt only re-delivers the full prompt next turn */
            }
          },
          (err: Error) => {
            if (settled) return;
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: String(err?.message ?? err).slice(0, 2_000),
            });
            settle(false);
          },
        );
      } catch (err) {
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: String((err as Error)?.message ?? err).slice(0, 2_000),
        });
        settle(false);
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        const child = spawnCli(config.cli, ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: piEnvironment({ ...process.env, ...input.environment }),
        });
        let out = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (c: string) => (out += c));
        const timer = setTimeout(() => {
          try {
            killCliTree(child);
          } catch {
            /* ignore */
          }
          resolve(null);
        }, 8000);
        timer.unref?.();
        child.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(out.trim() || null);
        });
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // pi manages its own credentials (~/.pi/agent/auth.json); there is no
      // separate sign-in step the harness can probe, so treat it as authed.
      return { state: "available", version, authenticated: true };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          // model is set per turn via set_model before prompt
          sessionModelSwitch: "in-session",
          // Integrations arrive as stdio MCP servers mounted by the
          // pi-mcp-extension (pi core has no MCP client of its own).
          agentsMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          customMcp: true,
          browserMcp: true,
          // Host control (the user's real Mac) rides the pi-native permission
          // card (`ctx.ui.confirm` → extension_ui_request) gated in the
          // extension, so it is offered exactly when the other engines offer
          // it: enabled unless the bot is in full-auto.
          localComputerMcp: true,
          // Images ride pi's native RPC prompt as base64 content blocks, so a
          // vision model can inspect them without a separate file-read tool.
          images: true,
          nativeImageInput: true,
          // Reasoning effort pins pi's thinking level per turn (none → off).
          // xhigh/max only land on models that expose them; pi rejects an
          // unsupported level and the turn keeps the engine default.
          effortLevels: EFFORT_LEVELS,
          // pi's RPC mode takes a mid-turn steer frame the runtime queues
          // into the running agent without aborting the current step.
          queueing: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const entry = active.get(threadId);
          const answer = entry?.pending.get(requestId);
          if (!entry || !answer) return "unavailable";
          entry.pending.delete(requestId);
          answer({ behavior: decision.behavior, message: decision.message });
          emit({
            ...base(threadId, entry.turnId),
            requestId,
            type: "request.resolved",
            behavior: decision.behavior,
            source: "user",
          });
          return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
        },
        steer: async (threadId, text) => {
          const entry = active.get(threadId);
          return entry?.steer ? await entry.steer(text) : "refused";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};

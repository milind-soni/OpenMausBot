// The pi coding agent (@earendil-works/pi-coding-agent) over its own stdio JSON-RPC mode
// (`pi --mode rpc --no-session`), not ACP. pi is BYOK and reads ~/.pi/agent/auth.json itself, so
// this driver holds no key; resumeCursor is pi's `sessionFile` (switch_session).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "../config.ts";
import { openStartupModelCatalog, writeStartupModelCache } from "../startup-model-catalog.ts";
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
import { ASK_USER_TOOL, MAX_QUESTION_TEXT, parseAskQuestions, parseChoices, questionAnswersByQuestion } from "../../shared/ask-question.ts";
import {
  decodeInjectId,
  encodeInjectId,
  hostApiKey,
  localHost,
  mergeLocalInject,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { allowsTool, canUseMcpServer, parseToolScope } from "../../shared/tool-scope.ts";
import { appMountFor, customServerGate, gateServer, mcpStdioServer } from "../mcp-gate-config.ts";
import { remoteMcpSpec } from "../mcp-http.ts"; import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";

const DRIVER_KIND = "piAgent";
const PI_ARGS = ["--mode", "rpc", "--no-session"];
const PI_MODEL_UPDATE_ARGS = ["update", "--models", "--no-approve"];
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };
/** omp's RPC transport caps a frame at 1 MiB and chunks bigger ones only after the client
 *  negotiates protocol 2. Vanilla pi has no handshake frame to wait for. */
const PI_NEGOTIATE_FRAME = { id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 };
const PI_PROMPT_RE_ANCHOR_TURNS = 8;
/** How long to wait after a finished turn_end for agent_end, which some runtimes never send. */
const PI_AGENT_END_GRACE_MS = 60_000;

/** pi answered success:false: an explicit refusal from a live runtime, not a transport failure. */
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

/** Native logs go into bug reports: keep the RPC shape and size, never image bytes. */
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

export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

export function buildMcpServers(turn: SendTurnInput): Record<string, unknown> | null {
  const parsed = parseToolScope(turn.toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const servers: Record<string, unknown> = {};
  if (turn.integrations?.composio) servers.composio = { ...turn.integrations.composio }; if (turn.integrations?.composioOwn) servers[OWN_APPS_SERVER] = { ...turn.integrations.composioOwn };
  if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
      // Host control carries scope so the extension gates every call behind a permission card.
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
  for (const name of ["data", "highlevel"] as const) if (turn.integrations?.[name]) servers[name] = { ...turn.integrations[name] };
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) servers[name] = { ...server, scope: "custom" };
  for (const [name, server] of Object.entries(servers)) {
    if (parsed.scope !== undefined && !canUseMcpServer(parsed.scope, name)) { delete servers[name]; continue; }
    // pi registers every tool it is given and has no tool search of its own.
    const directory = remoteMcpSpec(server) !== undefined;
    const gated = gateServer({ name, server, toolScope: parsed.scope, threadId: turn.threadId, nodeEnv: NODE_ENV_FLAG, directory, ...customServerGate(name, name in (turn.integrations?.custom ?? {}), turn.integrations?.customResultBudgets), apps: appMountFor(name, turn) });
    const stdio = gated ?? mcpStdioServer(server, { nodeEnv: NODE_ENV_FLAG, ...(directory ? { directory: { name } } : {}) });
    if (!stdio) throw new Error("Pi MCP server configuration is invalid");
    const original = server as { scope?: string };
    servers[name] = { ...stdio, ...(original.scope ? { scope: original.scope } : {}), ...(directory ? { directory: true } : {}) };
  }
  return Object.keys(servers).length ? servers : null;
}

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

function piCatalogFromFrame(frame: unknown, fallbackDefault: string): ModelCatalog | null {
  const res = frame as PiModelsResponse;
  if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) return null;
  const options: Array<{ id: string; label: string; custom: true; provider: string }> = [];
  for (const m of res.data?.models ?? []) {
    if (!m?.provider || !m?.id) continue;
    const id = `${m.provider}/${m.id}`;
    options.push({ id, label: m.name ?? m.id, custom: true, provider: m.provider });
  }
  return { default: fallbackDefault || (options[0]?.id ?? ""), options };
}

export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const catalog = piCatalogFromFrame(msg, fallbackDefault);
    if (catalog) return catalog;
  }
  return { default: fallbackDefault, options: [] };
}

/** omp's RPC v2 splits a frame over 1 MiB into base64 `rpc_chunk` pieces (`chunkId`/`count`/
 *  `byteLength` per frame, sequential `index`, `data` per piece). Any inconsistency drops the sequence. */
export class PiRpcChunks {
  /** omp's advertised cap on one reassembled frame. */
  static readonly MAX_BYTES = 64 * 1024 * 1024;
  /** omp's cap on one decoded piece, which also bounds the piece count. */
  static readonly MAX_PIECE_BYTES = 256 * 1024;
  static readonly MAX_COUNT = PiRpcChunks.MAX_BYTES / PiRpcChunks.MAX_PIECE_BYTES;
  private chunkId: string | null = null;
  private count = 0;
  private byteLength = 0;
  private bytes = 0;
  private parts: Buffer[] = [];

  accept(message: Record<string, unknown>): Record<string, unknown> | null {
    const { chunkId, index, count, byteLength, data } = message;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || typeof data !== "string" ||
      data.length === 0 || data.length > Math.ceil(PiRpcChunks.MAX_PIECE_BYTES / 3) * 4 ||
      !Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(byteLength) ||
      (index as number) < 0 || (count as number) < 2 || (count as number) > PiRpcChunks.MAX_COUNT ||
      (index as number) >= (count as number) ||
      (byteLength as number) < 0 || (byteLength as number) > PiRpcChunks.MAX_BYTES
    ) {
      this.reset();
      return null;
    }
    if (chunkId !== this.chunkId) {
      if (index !== 0) {
        this.reset();
        return null;
      }
      this.chunkId = chunkId;
      this.count = count as number;
      this.byteLength = byteLength as number;
      this.parts = [];
      this.bytes = 0;
    } else if (count !== this.count || byteLength !== this.byteLength) {
      this.reset();
      return null;
    }
    const part = Buffer.from(data, "base64");
    // An empty piece would let a sequence grow without approaching `byteLength`.
    if (
      index !== this.parts.length || part.length === 0 || part.length > PiRpcChunks.MAX_PIECE_BYTES ||
      this.bytes + part.length > this.byteLength
    ) {
      this.reset();
      return null;
    }
    this.parts.push(part);
    this.bytes += part.length;
    if (this.parts.length < this.count) return null;
    const complete = this.bytes === this.byteLength;
    const text = Buffer.concat(this.parts).toString("utf8");
    this.reset();
    if (!complete) return null;
    try {
      const frame = JSON.parse(text) as unknown;
      return frame && typeof frame === "object" && !Array.isArray(frame)
        ? frame as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private reset(): void {
    this.chunkId = null;
    this.count = 0;
    this.byteLength = 0;
    this.bytes = 0;
    this.parts = [];
  }
}

export function decodePiFrame(line: string, chunks: PiRpcChunks): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const frame = parsed as Record<string, unknown>;
  return frame.type === "rpc_chunk" ? chunks.accept(frame) : frame;
}

const PI_MAX_LINE = PiRpcChunks.MAX_BYTES;

export function piLineReader(onLine: (line: string) => boolean | void): (chunk: string) => void {
  let buf = "";
  let dropping = false;
  return (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (line.length > PI_MAX_LINE || !line.trim()) continue;
      if (onLine(line)) return;
    }
    if (buf.length > PI_MAX_LINE) {
      buf = "";
      dropping = true;
    }
  };
}

export function splitPiModel(id: string): { provider: string; modelId: string } | null {
  const inject = decodeInjectId(id);
  if (inject) return { provider: inject.host, modelId: inject.model };
  if (!id.includes("/")) return null;
  const [provider, ...rest] = id.split("/");
  if (!provider || !rest.length) return null;
  return { provider, modelId: rest.join("/") };
}

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

/** Upsert a live local host into ~/.pi/agent/models.json so `set_model` can reach it. */
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
  } catch {}
  return split;
}

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

export async function fetchPiModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<ModelCatalog> {
  const child = spawnCli(cli, PI_ARGS, { stdio: ["pipe", "pipe", "pipe"], env });
  return new Promise((resolve) => {
    let done = false;
    const fallbackDefault = readPiDefaultModel(env);
    const finish = (catalog: ModelCatalog) => {
      if (done) return;
      done = true;
      try {
        killCliTree(child);
      } catch {}
      resolve(catalog);
    };
    const timer = setTimeout(() => finish({ default: "", options: [] }), 15_000);
    timer.unref?.();
    const chunks = new PiRpcChunks();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", piLineReader((line) => {
      const frame = decodePiFrame(line, chunks);
      if (frame?.command !== "get_available_models") return false;
      clearTimeout(timer);
      finish(piCatalogFromFrame(frame, fallbackDefault) ?? { default: fallbackDefault, options: [] });
      return true;
    }));
    child.on("error", () => finish({ default: "", options: [] }));
    child.on("close", () => finish({ default: "", options: [] }));
    try {
      child.stdin.write(`${JSON.stringify(PI_NEGOTIATE_FRAME)}\n`);
      child.stdin.write(JSON.stringify({ id: "catalog", type: "get_available_models" }) + "\n");
    } catch {
      finish({ default: "", options: [] });
    }
  });
}

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
  /** Full-auto: never ask before an action. Host control is unavailable in this mode. */
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

interface PiEvent {
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
  usage?: { input?: number; output?: number };
  isTerminal?: boolean;
  willRetry?: boolean;
  id?: string;
  method?: string;
  options?: unknown[];
  title?: string;
}

function piEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, PATH: augmentedPath() };
  // pi reads provider keys from its env: an inherited key would flip billing, and workspace
  // credentials are the harness's secrets.
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
      } catch {}
      try {
        const next = await applyPiLocalCatalog(base, catalogEnv);
        if (next.options.length) models = next;
      } catch {
        if (base.options.length) models = base;
      }
      try { writeStartupModelCache(instanceId, models); } catch {}
    };
    const refreshModels = async () => {
      await updatePiModelCatalog(config.cli, catalogEnv);
      await readModels();
    };
    const startupModelRefresh = (await openStartupModelCatalog({
      instanceId,
      use: (catalog) => { models = catalog; },
      current: () => models,
      refresh: readModels,
    }))?.pending ?? null;

    const listeners = new Set<RuntimeEventListener>();
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
      if (startupModelRefresh) await startupModelRefresh;
      const { threadId } = turn;
      const selection = parseToolScope(turn.toolScope);
      if (!selection.ok) throw new Error(selection.error);
      const toolScope = selection.scope;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const fullAuto = turn.approvalMode === undefined ? config.fullAuto : false;
      // Host control always routes through the permission card, full-auto or not.
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && fullAuto) {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = newId();
      const pending = new Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>();
      const askTimers = new Set<ReturnType<typeof setTimeout>>();
      let settled = false;
      let endStopReason: string | undefined;
      let endUsage: { input?: number; output?: number } | undefined;
      let endErrorMessage: string | undefined;
      let agentEndTimer: ReturnType<typeof setTimeout> | null = null;
      const images = readPiPromptImages(turn);

      // Before any credential-bearing temp file, so a model setup failure leaves nothing to clean up.
      if (typeof turn.model === "string" && turn.model) {
        ensurePiInjectModel(turn.model, { ...process.env, ...input.environment });
      }

      // The MCP config carries credentials: a 0600 temp file removed at settle, never argv.
      // Written on every turn: the extension also carries ask_user.
      const mcpServers = buildMcpServers(turn);
      const askUser = toolScope === undefined || allowsTool(toolScope, { kind: "native", name: ASK_USER_TOOL });
      const mcpTempDir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-"));
      const scopeReadyPath = toolScope !== undefined ? join(mcpTempDir, "scope-ready.json") : undefined;
      try {
        writeFileSync(join(mcpTempDir, "mcp.json"), JSON.stringify({ mcpServers: mcpServers ?? {}, toolScope, scopeReadyPath, approvalMode: turn.approvalMode, askUser }), { mode: 0o600 });
      } catch (err) {
        // A partial file could still hold credentials.
        try {
          rmSync(mcpTempDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }
      const childArgs = [...PI_ARGS, "-e", SPAWNED_PROXIES.piMcpExtension];

      // spawnCli can throw synchronously, before settle() could remove the credential file.
      const child = (() => {
        try {
          return spawnCli(config.cli, childArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: turn.cwd,
            env: piEnvironment({
              ...process.env,
              ...input.environment,
              OMB_MCP_CONFIG: join(mcpTempDir, "mcp.json"),
            }),
          }, "bot");
        } catch (err) {
          try {
            rmSync(mcpTempDir, { recursive: true, force: true });
          } catch {}
          throw err;
        }
      })();
      let assistantText = "";
      let compactionObserved = false;
      const responseWaiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
      // Steers correlate by a unique id, so concurrent steers never share or overwrite a waiter.
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
      // Vanilla pi refuses the unknown command; no waiter is keyed for the reply.
      send(PI_NEGOTIATE_FRAME);

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
        } catch {}
        try {
          killCliTree(child);
        } catch {}
        try {
          rmSync(mcpTempDir, { recursive: true, force: true });
        } catch {}
        active.delete(threadId);
      };

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
        } catch {}
        try {
          killCliTree(child);
        } catch {}
        settle(true, "cancelled");
      };

      // pi queues a steer into the running agent without aborting the step, answers success only after
      // session.steer() accepted it, and echoes each frame's id.
      const steerActiveTurn = async (text: string): Promise<SteerOutcome> => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return "refused";
        let ack: Promise<unknown>;
        try {
          const id = `steer:${++steerSeq}`;
          ack = awaitResponse("steer", 20_000, id);
          send({ type: "steer", id, message: text });
        } catch {
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
            // pi floods setWidget/setStatus; only select/confirm/input wait for an answer.
            if (evt.method === "select" || evt.method === "confirm" || evt.method === "input") {
              flushAssistantText();
              const reqId = evt.id ?? newId();
              const isSelect = evt.method === "select";
              const isQuestion = isSelect || evt.method === "input";
              const selectOptions: string[] = isSelect && Array.isArray(evt.options)
                ? evt.options.filter((option): option is string => typeof option === "string") : [];
              const summary = String(evt.title ?? (isQuestion ? "pi has a question" : "pi wants confirmation")).slice(0, isQuestion ? MAX_QUESTION_TEXT : 200);
              const question = isSelect
                ? (parseAskQuestions({
                    questions: [{ question: summary, options: selectOptions }],
                  }) ?? [])[0]
                : undefined;
              const choices = question?.options.length ? question.options.map((option) => option.label) : undefined;
              let timer: ReturnType<typeof setTimeout> | undefined;
              // Register BEFORE emitting: the harness may auto-approve inside its synchronous request.opened listener.
              pending.set(reqId, (decision) => {
                if (timer) {
                  clearTimeout(timer);
                  askTimers.delete(timer);
                }
                if (decision.behavior === "deny") send({ type: "extension_ui_response", id: reqId, cancelled: true });
                else if (isQuestion) {
                  const value = question
                    ? questionAnswersByQuestion(decision.message ?? "", [question])[question.question] ?? decision.message ?? ""
                    : decision.message ?? "";
                  // pi expects the original option, not the capped display label; never guess between two.
                  const matched = selectOptions.filter(option => parseChoices([option], 1)?.[0] === value);
                  send(matched.length > 1
                    ? { type: "extension_ui_response", id: reqId, cancelled: true }
                    : { type: "extension_ui_response", id: reqId, value: matched[0] ?? value });
                }
                else send({ type: "extension_ui_response", id: reqId, confirmed: true });
              });
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
            // pi compaction (manual or automatic) can absorb the turn that carried the standing prompt.
            if (sessionReady && sessionFile) {
              compactionObserved = true;
              deletePromptSplitReceipt("pi", JSON.stringify([threadId, sessionFile]));
            }
            return;
          }
          case "turn_end":
          {
            // A killed child can still flush one buffered frame after the turn settled.
            if (settled) return;
            const sr = evt.message?.stopReason;
            // toolUse: pi ran a tool and auto-continues; the next turn_end carries the outcome.
            if (sr === "toolUse" || sr === "tool_use" || sr === "tool_calls") return;
            endStopReason = sr;
            endUsage = evt.usage ?? evt.message?.usage;
            endErrorMessage = evt.message?.errorMessage;
            // pi can schedule maintenance (overflow-recovery compaction) after the final turn_end;
            // only agent_end proves the session is done rewriting itself.
            if (agentEndTimer) clearTimeout(agentEndTimer);
            agentEndTimer = setTimeout(finishRun, PI_AGENT_END_GRACE_MS);
            agentEndTimer.unref?.();
            return;
          }
          case "agent_end": {
            // Non-terminal agent_end: upstream pi sets willRetry: true before an automatic retry; the omp
            // fork sets isTerminal: false while maintenance or async delivery is scheduled.
            if (evt.isTerminal === false || evt.willRetry === true) return;
            if (agentEndTimer) {
              clearTimeout(agentEndTimer);
              agentEndTimer = null;
            }
            finishRun();
            return;
          }
          case "agent_settled": {
            // upstream pi's explicit fully-settled guarantee: no retry or queued continuation remains.
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

      const chunks = new PiRpcChunks();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", piLineReader((line) => {
        const frame = decodePiFrame(line, chunks);
        if (!frame) return;
        try {
          onEvent(frame as unknown as PiEvent);
        } catch {}
      }));
      child.on("error", (err) => {
        const fail = describeSpawnFailure(err as NodeJS.ErrnoException, config.cli, turn.cwd);
        rejectWaiters(new Error(fail.message));
        emit({ ...base(threadId, turnId), type: "runtime.error", message: fail.message, setup: fail.setup });
        settle(false);
      });
      child.on("close", () => {
        rejectWaiters(new Error("pi process exited before replying"));
        settle(false);
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });

      // The resumeCursor is pi's sessionFile, which switch_session takes as `sessionPath`.
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
        // pi --no-session accepts a prompt without an explicit session.
      }

      const chosen = typeof turn.model === "string" ? splitPiModel(turn.model) : null;
      if (chosen) {
        try {
          const modelPromise = awaitResponse("set_model");
          send({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId });
          await modelPromise;
        } catch {}
      }

      // After the model: the supported level set is model-dependent.
      if (turn.effort) {
        try {
          const levelPromise = awaitResponse("set_thinking_level");
          send({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) });
          await levelPromise;
        } catch {}
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
      try {
          // pi answers the prompt only after preflight accepts it, and rejects it while a compaction runs.
        const accepted = awaitResponse("prompt", 120_000);
        send({ type: "prompt", message, ...(images.length ? { images } : {}) });
        void accepted.then(
          () => {
            if (!pendingReceipt || compactionObserved) return;
            try {
              writePromptSplitReceipt("pi", pendingReceipt.key, pendingReceipt.receipt);
            } catch {}
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
          } catch {}
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
      // pi manages its own credentials; there is no sign-in to probe.
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
      ...(startupModelRefresh ? { startupModelRefresh } : {}),
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          // pi core has no MCP client of its own.
          agentsMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          customMcp: true,
          browserMcp: true,
          dataMcp: true, highlevelMcp: true,
          localComputerMcp: true,
          images: true,
          nativeImageInput: true,
          // pi rejects an unsupported level and the turn keeps the engine default.
          effortLevels: EFFORT_LEVELS,
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

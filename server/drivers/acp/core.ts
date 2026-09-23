// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// One live agent process per (thread, spawn contract): the ACP handshake
// (initialize, authenticate) and the native session are established once,
// and later turns prompt the live session directly instead of paying the
// full handshake per message. The pool mirrors the Claude driver: a session
// closes after OMB_ACP_SESSION_IDLE_MS of quiet (default 10 minutes, floored
// by OMB_ACP_SESSION_IDLE_MIN_MS default 10s), when the spawn contract
// changes, when the child crashes, when an interrupt's cancel goes
// unanswered, and on stopAll/dispose. A resume cursor left by an earlier
// session resumes through session/load|resume when the process had to
// respawn.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped. Session
// configuration is the exception: its live updates apply before prompting too.
import { homedir } from "node:os";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  ModelVariantOption,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
  TurnImageInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { augmentedPath } from "../../env-path.ts";
import { supportsApprovalMode } from "../../../shared/approval-mode.ts";

import { appendNative } from "../native.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { extractMcpImages } from "../../mcp-tool-images.ts";
import { redactSecretsInText } from "../../redact.ts";
import { recoveryPromptFor } from "../../resume-recovery.ts";

/** ACP vendors put the actionable cause in error.data while keeping the
 * JSON-RPC message generic. Only surface known text fields, never a response
 * body/config dump, and redact before bounding the displayed diagnostic. */
function acpRpcError(value: any, method: string): Error {
  const message = typeof value?.message === "string" ? value.message : "ACP request failed";
  const data = value?.data;
  const detail = typeof data === "string" ? data
    : typeof data?.details === "string" ? data.details
    : typeof data?.message === "string" ? data.message
    : typeof data?.error?.message === "string" ? data.error.message
    : "";
  const context = [
    method,
    typeof data?.service === "string" ? `service: ${data.service}` : "",
    typeof data?.errorName === "string" ? data.errorName : "",
  ].filter(Boolean).join(", ");
  const diagnostic = `${detail && detail !== message ? `${message}: ${detail}` : message} (${context})`;
  const error = new Error(redactSecretsInText(diagnostic).slice(0, 1500));
  return Object.assign(error, { code: value?.code, data,
    // -32603 is JSON-RPC's internal error. Invalid params, unsupported
    // methods and auth refusals are user/configuration issues, not evidence
    // of a broken process. Preserve their session instead of retrying them.
    acpSessionFailure: value?.code === -32603,
  });
}

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** A pending request.opened answer: the callback stored in the running
 *  turn's asks map (shared shape with the runtime Turn record). */
type AcpAskFinish = (
  behavior: string,
  source?: "user" | "timeout" | "system",
  message?: string,
  always?: boolean,
) => void;

/** The running turn a pooled session is servicing — the per-turn half of
 *  the bookkeeping (Claude's Session.turn, split the same way). Server
 *  requests and updates that arrive between turns see `current: null`. */
interface AcpTurn {
  turnId: string;
  /** the model-resolved turn (see resolveTurnModel) */
  turn: SendTurnInput;
  turnConfig: AcpConfig;
  controlsHost: boolean;
  state: { settled: boolean; promptSent: boolean; text: string; producedItem: boolean };
  asks: Map<string, AcpAskFinish>;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  flushAssistantText: () => void;
  /** fold a session config snapshot into sessionConfigResult + the picker */
  receiveModelVariants: (result: any) => void;
}

/** A live JSON-RPC-2.0 connection over one agent child's stdio: pending
 *  request bookkeeping, UTF-8-safe line framing, and native logging. */
interface AcpConnection {
  send(obj: unknown): void;
  /** `timeoutMs` is a hard deadline from the request; `idleMs` is the prompt
   *  only (the one request that legitimately streams for minutes) and restarts
   *  on every inbound line, so it trips solely on total silence. `idleMessage`
   *  becomes the rejection error. */
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    receive?: (result: any) => void,
    idleMs?: number,
    idleMessage?: string,
  ): Promise<any>;
  failAll(error: Error): void;
  /** stop dispatching child output — pending RPCs reject, nothing parses */
  close(): void;
}

/** One live ACP agent process per thread, kept across turns. The spawn
 *  handshake (initialize/authenticate) and the native session are paid once;
 *  later turns prompt the live session. The pool shape is the Claude
 *  driver's: spawn contract in, quiet-timeout out, crash drops the record. */
interface AcpSession {
  child: ReturnType<typeof spawnCli>;
  acp: AcpConnection;
  launch: { command: string; args?: string[] };
  cwd: string;
  /** the spawn contract — a different one means a fresh process */
  contractKey: string;
  /** the establishment inputs (mcpServers) the live native session was built
   *  with. They ride session/new and session/load, not the process argv, and
   *  the harness rotates integration bearer tokens every turn — so a change
   *  here re-establishes the session on the same child instead of respawning. */
  sessionKey: string | null;
  /** the live native session id, or null until one is established */
  sessionId: string | null;
  /** the agent's last config-option snapshot; persists across turns so an
   *  unchanged model skips the session/set_config_option RPC */
  sessionConfigResult: any;
  /** initialize's result — requested once per process */
  initResult: any;
  /** authenticate answered on this process; a turn that skips subscription
   *  auth neither checks nor marks it */
  authenticated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  /** the child exited — the record is dropped and the next turn respawns */
  dead: boolean;
  stderr: string;
  /** the running turn, or null between turns */
  current: AcpTurn | null;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Discover and select opaque model variants through ACP config options. */
  modelVariants?: boolean;
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Some managed agents are intentionally not probed during app startup.
   * Their explicit Refresh action remains the only network/process boundary. */
  resolveModelsOnCreate?: boolean;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Narrow compatibility exception for a CLI with verified native image
   * transport but a defective initialize capability (never a path fallback). */
  acceptsUnadvertisedImages?(initializeResult: unknown): boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: { configId: string };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig, instanceId: string): void;
  /** Resolve a managed or account-scoped executable just before use. */
  resolveCommand?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<{ command: string; args?: string[]; env?: Record<string, string | undefined> }>;
  /** Snapshot override for agents whose binary has no conventional --version. */
  snapshot?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<ProviderSnapshot>;
  /** Google Antigravity resumes through session/resume, not session/load. */
  resumeMethod?: "load" | "resume";
  /** Route workspace file access through ACP so edits retain approval cards. */
  clientFileSystem?: boolean;
  /** Do not retain stderr from providers that may place OAuth material there. */
  redactStderr?: boolean;
  /** Bound provider-native tool payloads before writing diagnostic logs. */
  sanitizeToolPayload?: boolean;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string; fullAuto: boolean },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
  }): Promise<void>;
}

const envOr = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);
const INIT_TIMEOUT = envOr("OPENMAUS_ACP_INIT_TIMEOUT_MS", 300_000);
const SESSION_CONFIG_TIMEOUT = envOr("OPENMAUS_ACP_SESSION_CONFIG_TIMEOUT_MS", 300_000); // configureSession's per-request default
const NEW_SESSION_TIMEOUT = envOr("OPENMAUS_ACP_NEW_SESSION_TIMEOUT_MS", 300_000);
const LOAD_SESSION_TIMEOUT = envOr("OPENMAUS_ACP_LOAD_SESSION_TIMEOUT_MS", 120_000); // history replay on a long thread is slow
// Read lazily (not at import) so a test can shorten the window. Unlike the
// setup calls above, session/prompt legitimately streams for minutes, so a
// wall-clock deadline would false-positive: this guard only trips when the
// child sends nothing at all for the whole window (a wedged OpenCode turn
// streams thought chunks, then goes silent forever and never resolves). 0
// disables the guard, restoring the pre-fix "hang until the user cancels"
// behavior.
const promptIdleTimeoutMs = (): number => {
  const raw = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
  if (raw === undefined) return 180_000;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function acpVariantOption(result: any): { configId: string; options: ModelVariantOption[]; currentValue?: string } | undefined {
  const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
    (entry: any) => entry?.type === "select" && typeof entry.id === "string"
      && (entry.id === "effort" || entry.category === "thought_level"),
  );
  if (!option) return;
  const options: ModelVariantOption[] = [];
  const seen = new Set<string>();
  const collect = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string" && !seen.has(entry.value)) {
        seen.add(entry.value);
        options.push({ id: entry.value, label: typeof entry.name === "string" ? entry.name : entry.value });
      } else if (Array.isArray(entry?.options)) collect(entry.options);
    }
  };
  collect(option.options);
  return {
    configId: option.id,
    options,
    ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
  };
}
const TOOL_LOG_TEXT_LIMIT = 64_000;

async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
}

function sanitizeToolLogValue(value: unknown, budget: { nodes: number; text: number }, depth = 0): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//iu.test(value) || budget.text <= 0) return undefined;
    const limit = Math.min(TOOL_LOG_TEXT_LIMIT, budget.text);
    const text = value.length <= limit ? value : `[Earlier output truncated]\n\n${value.slice(-limit)}`;
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
    if ((record.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" && typeof record.mimeType === "string" && record.mimeType.startsWith("image/"))) return [];
    const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

function sanitizeAcpToolMessage(message: any): unknown {
  const isToolUpdate = message?.method === "session/update"
    && ["tool_call", "tool_call_update"].includes(message?.params?.update?.sessionUpdate);
  const isPermission = message?.method === "session/request_permission";
  if (!isToolUpdate && !isPermission) return message;
  return sanitizeToolLogValue(message, { nodes: 512, text: TOOL_LOG_TEXT_LIMIT });
}

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
/** What "the same operation" means for a remembered session allow: the
 * tool call's shape with keys sorted, so two identical requests key alike
 * however the agent ordered its JSON. null when nothing identifies it. */
function sessionOperationKey(toolCall: any): string | null {
  const rawInput = toolCall?.rawInput;
  const command = typeof rawInput?.command === "string" ? rawInput.command : undefined;
  const hasInput = rawInput && typeof rawInput === "object" && Object.keys(rawInput).length > 0;
  if (!command && !hasInput) return null;
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value;
  return JSON.stringify(stable({
    kind: toolCall?.kind,
    title: toolCall?.title,
    command,
    input: rawInput,
    locations: toolCall?.locations,
  }));
}

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = (activeConfig = config) => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // two lists, one rule: foreign PROVIDER keys must not flip a CLI's
        // billing off its own login, and WORKSPACE credentials (box token,
        // voice key, …) are the harness's secrets — riding along in
        // `...process.env` is not a grant. A driver keeps only what its
        // credentialEnv allowlist names.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        // The operator's own secrets are outside any driver's allowlist.
        stripControlPlaneEnv(env);
        support.transformEnv?.(env, activeConfig, instanceId);
        return env;
      };
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config, instanceId);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      if (support.resolveModelsOnCreate !== false) await refreshModels();
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, AcpAskFinish>;
      }
      const active = new Map<string, Turn>();
      // One live agent process per thread, kept across turns — the Claude
      // driver's pool. The ACP handshake (initialize, authenticate) and the
      // native session are established once; a later turn on the same spawn
      // contract prompts the live session instead of paying the handshake
      // again. An idle session closes after SESSION_IDLE_MS of quiet.
      const sessions = new Map<string, AcpSession>();
      const configuredIdleMinimum = Number(process.env.OMB_ACP_SESSION_IDLE_MIN_MS);
      const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
        ? configuredIdleMinimum
        : 10_000;
      const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.OMB_ACP_SESSION_IDLE_MS) || 10 * 60_000);

      const closeSession = (threadId: string, why: string) => {
        const session = sessions.get(threadId);
        if (!session || session.closing) return;
        session.closing = true;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { close: why } });
        // a new turn must never adopt a closing session
        sessions.delete(threadId);
        session.acp.close();
        // stdin EOF asks the agent to exit; EOF is not a guaranteed exit
        // signal for ACP agents, so insist after a grace period
        try {
          session.child.stdin.end();
        } catch {}
        const kill = setTimeout(() => {
          void killCliTree(session.child);
        }, 5_000);
        kill.unref?.();
      };
      const armIdle = (threadId: string) => {
        const session = sessions.get(threadId);
        if (!session) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
        session.idleTimer.unref?.();
      };
      // "Always allow this session", remembered by the driver when the agent
      // offered no `allow_always` of its own: the exact operations (kind,
      // title, command, input, locations) a person allowed for the session,
      // per thread. A repeat is answered the way they did, once, for as long
      // as the native session lasts. A generic title with no input identifies
      // nothing and is never remembered.
      const sessionAllows = new Map<string, Set<string>>();

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };

      // ACP content blocks may carry a complete raster image inline. Keep the
      // bytes on the wire, but never duplicate megabytes of base64 into the
      // provider-native diagnostic log in either direction.
      const nativeLogMessage = (msg: any): unknown => {
        let redacted = msg;
        const prompt = msg?.method === "session/prompt" ? msg?.params?.prompt : null;
        if (Array.isArray(prompt)) {
          redacted = {
            ...msg,
            params: {
              ...msg.params,
              prompt: prompt.map((content: any) =>
                content?.type === "image" && typeof content.data === "string"
                  ? { ...content, data: `[image data: ${content.data.length} base64 chars]` }
                  : content
              ),
            },
          };
        }
        const content = redacted?.params?.update?.content;
        if (
          redacted?.method !== "session/update" ||
          redacted?.params?.update?.sessionUpdate !== "agent_message_chunk" ||
          content?.type !== "image" ||
          typeof content.data !== "string"
        ) return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
        redacted = {
          ...redacted,
          params: {
            ...redacted.params,
            update: {
              ...redacted.params.update,
              content: { ...content, data: `[image data: ${content.data.length} base64 chars]` },
            },
          },
        };
        return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. A url server is listed in ACP's http/sse shape and kept
      // for the session only when the agent advertised that transport.
      // env and headers are the ACP {name,value}[] shape.
      type AcpMcpServer =
        | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
        | { type: "http" | "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> };
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: AcpMcpServer[] = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        // The bot's computer, mounted exactly like the Claude driver does:
        // host and sandbox Cua connections expose Cua Driver's own MCP server.
        // (A cloud box is not mounted here at all: a cloud turn runs ON the box.)
        if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        // user-configured servers, after the built-ins: a residual name
        // collision keeps the built-in (reserved names are filtered at the
        // config boundary; this is defense in depth).
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          if (servers.some((existing) => existing.name === name)) continue;
          if ("url" in server) {
            servers.push({ type: server.type, name, url: server.url, headers: acpEnv(server.headers) });
            continue;
          }
          servers.push({ name, command: server.command, args: server.args, env: acpEnv(server.env) });
        }
        return servers;
      };

      /** The one completion path for a turn: the prompt result, a crashed
       *  child, an unanswered cancel, or an rpc error the turn body throws.
       *  The child is NOT killed here — a clean settle leaves it pooled for
       *  the next turn on this contract. */
      const settle = (threadId: string, session: AcpSession, ok: boolean, stopReason: string | null) => {
        const current = session.current;
        if (!current || current.state.settled) return;
        current.state.settled = true;
        if (current.interruptTimer) clearTimeout(current.interruptTimer);
        for (const finish of current.asks.values()) finish("cancel", "system");
        session.acp.failAll(new Error("turn settled"));
        // detach before the final events: a listener that starts the next
        // turn synchronously must find this session free
        session.current = null;
        active.delete(threadId);
        current.flushAssistantText();
        // `end_turn` with nothing to show for it — no reply, no image, no
        // tool result — is a lost turn, not a success. An engine can report
        // exactly that (a provider may cut a reasoning-only stream and
        // still answer end_turn), and ok:true would end the thread quietly
        // while the person's message went unanswered. Keep the completion,
        // but report it as a failure so terminal chips, incidents and
        // follow-ups see what happened.
        let finalOk = ok;
        let finalStopReason = stopReason;
        if (finalOk && finalStopReason === null && !current.state.producedItem) {
          finalOk = false;
          finalStopReason = "empty_turn";
          emit({
            ...base(threadId, current.turnId),
            type: "runtime.error",
            message: `${DRIVER_KIND} ended the turn with no reply, image, or tool result`,
          });
        }
        emit({ ...base(threadId, current.turnId), type: "turn.completed", ok: finalOk, stopReason: finalStopReason, cost: null });
        if (session.child.exitCode === null && !session.closing && !session.dead) {
          armIdle(threadId);
        } else if (session.dead && sessions.get(threadId) === session) {
          // a dead session is never pooled; the next turn respawns
          sessions.delete(threadId);
        }
      };

      /** Spawn the agent process and everything that lives for its whole
       *  lifetime: the wire connection, native logging, stderr tailing, and
       *  the server-request/update dispatch. Per-turn state arrives through
       *  session.current, so a request that lands between turns is answered
       *  (never brokered) instead of left hanging. */
      const openSession = (
        threadId: string,
        launch: { command: string; args?: string[] },
        argv: string[],
        env: Record<string, string | undefined>,
        cwd: string,
        contractKey: string,
      ): AcpSession => {
        const child = spawnCli(launch.command, argv, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let nextId = 1;
        const rpcPending = new Map<
          number,
          {
            method: string;
            resolve: (v: any) => void;
            reject: (e: Error) => void;
            timer: ReturnType<typeof setTimeout> | null;
            idleTimer: ReturnType<typeof setTimeout> | null;
            armIdle: () => void;
          }
        >();

        const send = (obj: unknown) => {
          // A permission/file response resumes an agent that was waiting on us.
          const message = obj as { id?: unknown; result?: unknown; error?: unknown };
          if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            for (const pending of rpcPending.values()) pending.armIdle();
          }
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: nativeLogMessage(obj) });
        };
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          receive?: (result: any) => void,
          idleMs?: number,
          idleMessage?: string,
        ) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(Object.assign(new Error(`${method} timed out`), { acpSessionFailure: true }));
              }, timeoutMs);
              timer.unref?.();
            }
            // Idle watchdog: unlike a wall-clock timeout, the deadline restarts
            // on every inbound line (see the stdout handler), so a long-lived
            // streaming agent is never cut off — only one that has gone fully
            // silent trips it.
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const armIdle = () => {
              if (!(idleMs && idleMs > 0)) return;
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                // Waiting for a person is not an unresponsive agent.
                if (session.current?.asks.size) { armIdle(); return; }
                rpcPending.delete(id);
                const error = new Error(idleMessage ?? `${method} stopped responding`);
                Object.assign(error, { acpPromptStall: true });
                reject(error);
              }, idleMs);
              idleTimer.unref?.();
            };
            armIdle();
            rpcPending.set(id, {
              method,
              // Consume configuration in wire order: an update following this
              // response may arrive before the awaiting continuation resumes.
              resolve: (result) => { receive?.(result); resolve(result); },
              reject,
              timer,
              get idleTimer() { return idleTimer; },
              armIdle,
            });
            send({ jsonrpc: "2.0", id, method, params });
          });
        const acp: AcpConnection = {
          send,
          request,
          failAll: (error: Error) => {
            for (const p of rpcPending.values()) {
              if (p.timer) clearTimeout(p.timer);
              if (p.idleTimer) clearTimeout(p.idleTimer);
              p.reject(error);
            }
            rpcPending.clear();
          },
          close: () => {
            acp.failAll(new Error("session closed"));
            child.stdout.removeAllListeners("data");
          },
        };

        const resolveClientPath = async (requestPath: unknown): Promise<string> => {
          if (typeof requestPath !== "string" || !isAbsolute(requestPath)) {
            throw new Error("ACP file paths must be absolute.");
          }
          const workspace = await realpath(cwd).catch(() => resolve(cwd));
          const requested = resolve(requestPath);
          const lexical = relative(resolve(cwd), requested);
          if (lexical === ".." || lexical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(lexical)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const suffix = [basename(requested)];
          let ancestor = dirname(requested);
          while (!(await lstat(ancestor).catch(() => null))) {
            const parent = dirname(ancestor);
            if (parent === ancestor) throw new Error("ACP file path has no accessible parent.");
            suffix.unshift(basename(ancestor));
            ancestor = parent;
          }
          const candidate = resolve(await realpath(ancestor), ...suffix);
          const rel = relative(workspace, candidate);
          if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const existing = await lstat(candidate).catch(() => null);
          if (existing?.isSymbolicLink()) throw new Error("ACP file path cannot be a symbolic link.");
          return candidate;
        };

        const handleClientFileRequest = async (msg: any): Promise<void> => {
          const fail = (error: unknown) => send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
          });
          try {
            if (!support.clientFileSystem) throw new Error("Client file access is disabled.");
            const params = msg.params ?? {};
            const path = await resolveClientPath(params.path);
            if (msg.method === "fs/read_text_file") {
              const info = await stat(path);
              if (!info.isFile() || info.size > CLIENT_FILE_MAX_BYTES) {
                throw new Error(`ACP can only read text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
              }
              const content = await readFile(path, "utf8");
              if (params.line == null && params.limit == null) {
                send({ jsonrpc: "2.0", id: msg.id, result: { content } });
                return;
              }
              const line = typeof params.line === "number" && Number.isInteger(params.line) && params.line > 0 ? params.line : 1;
              const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0 ? params.limit : undefined;
              const lines = content.split("\n");
              const start = line - 1;
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("\n") },
              });
              return;
            }
            if (typeof params.content !== "string" || Buffer.byteLength(params.content) > CLIENT_FILE_MAX_BYTES) {
              throw new Error(`ACP can only write text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, params.content, "utf8");
            send({ jsonrpc: "2.0", id: msg.id, result: {} });
          } catch (error) {
            fail(error);
          }
        };

        // server→client permission request → canonical request.opened,
        // answered fail-closed for the running turn
        const handleServerRequest = (msg: any, current: AcpTurn) => {
          if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
            void handleClientFileRequest(msg);
            return;
          }
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          current.flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string; name?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => o.kind === `${want}_once` && typeof o.optionId === "string")?.optionId
              ?? options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId
              ?? null;
          const optionAlways = options.find((o) => o.kind === "allow_always" && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, current.turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const isQuestion = String(toolCall.toolCallId ?? "").startsWith("interaction_");
          if (current.turnConfig.fullAuto && current.turn.approvalMode === undefined && !isQuestion) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          // an earlier "Always allow this session" on this exact operation
          const operationKey = isQuestion || current.controlsHost ? null : sessionOperationKey(toolCall);
          if (operationKey && sessionAllows.get(threadId)?.has(operationKey)) {
            const allow = optionFor("allow");
            if (allow) {
              return send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow } } });
            }
          }
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (
            behavior: string,
            source: "user" | "timeout" | "system" = "user",
            message?: string,
            always?: boolean,
          ) => {
            if (!current.asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const forSession = want === "allow" && always === true && !isQuestion && !current.controlsHost;
            const named = isQuestion && behavior === "answer"
              ? options.filter((option) => option.optionId === message || option.name?.trim() === message)
              : [];
            const optionId = behavior === "cancel"
              ? null
              : isQuestion
                ? named.length === 1 && typeof named[0].optionId === "string" ? named[0].optionId : null
                : forSession
                  ? optionAlways ?? optionFor("allow")
                  : optionFor(want);
            // the agent keeps its own allow_always; when it offered none, the
            // driver keeps the operation for the session instead
            if (forSession && !optionAlways && optionId && operationKey) {
              const remembered = sessionAllows.get(threadId) ?? new Set<string>();
              remembered.add(operationKey);
              sessionAllows.set(threadId, remembered);
            }
            if (behavior !== "cancel" && !optionId) missing(isQuestion ? "matching answer" : want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, current.turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && isQuestion ? "answer" : optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: current.controlsHost ? "local-computer" : undefined,
            });
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, current.turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          current.asks.set(requestId, finish);
          emit({
            ...base(threadId, current.turnId),
            type: "request.opened",
            requestId,
            requestType: isQuestion ? "question" : "permission",
            tool,
            summary,
            choices: isQuestion
              ? options.flatMap((option) => typeof option.name === "string" && option.name.trim() ? [option.name.trim()] : [])
              : undefined,
            approvalScope: current.controlsHost ? "local-computer" : undefined,
            // the driver can honor a session-wide allow either way
            allowSession: !isQuestion && !current.controlsHost ? true : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (p._meta?.isReplay === true) return;
          const current = session.current;
          if (support.modelVariants && p.update?.sessionUpdate === "config_option_update") {
            if (current && !current.state.settled && session.sessionId && p.sessionId === session.sessionId) current.receiveModelVariants(p.update);
            return;
          }
          if (!current || !current.state.promptSent) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                current.flushAssistantText();
                current.state.producedItem = true;
                emit({
                  ...base(threadId, current.turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  data: content.data,
                  alt: "Generated image",
                });
              } else if (typeof delta === "string" && delta) {
                current.state.text += delta;
                emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              current.flushAssistantText();
              emit({
                ...base(threadId, current.turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
                summary: commandSummary(u.rawInput),
                input: toolDetailPreview(u.rawInput),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                current.state.producedItem = true;
                emit({
                  ...base(threadId, current.turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                  output: toolDetailPreview(u.rawOutput ?? u.content),
                });
                for (const img of extractMcpImages(u.content ?? u.rawOutput)) {
                  emit({ ...base(threadId, current.turnId), type: "item.completed", itemType: "assistant_image", data: img.data });
                }
              }
              break;
            }
          }
        };

        const session: AcpSession = {
          child,
          acp,
          launch,
          cwd,
          contractKey,
          sessionKey: null,
          sessionId: null,
          sessionConfigResult: null,
          initResult: null,
          authenticated: false,
          idleTimer: null,
          closing: false,
          dead: false,
          stderr: "",
          current: null,
        };
        let buf = "";
        // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
        // multibyte characters that straddle two reads and corrupts the text
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            appendNative(threadId, { dir: "in", source: SOURCE, msg: nativeLogMessage(msg) });
            // Inbound traffic proves the child is alive and making progress,
            // so every idle deadline restarts; only total silence trips it.
            for (const p of rpcPending.values()) p.armIdle();
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                if (pend.timer) clearTimeout(pend.timer);
                if (pend.idleTimer) clearTimeout(pend.idleTimer);
                if (msg.error) {
                  pend.reject(acpRpcError(msg.error, pend.method));
                } else {
                  pend.resolve(msg.result);
                }
              }
            } else if (msg.id !== undefined && msg.method) {
              const current = session.current;
              if (!current) {
                // between turns nothing is brokered: cancel a permission
                // request and refuse anything else — the agent must never
                // block on an unanswered request
                send(msg.method === "session/request_permission"
                  ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
                  : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
              } else {
                handleServerRequest(msg, current);
              }
            } else if (msg.method) {
              handleNotification(msg);
            }
          }
        });

        child.stderr.on("data", (c) => {
          if (!support.redactStderr) session.stderr += c;
          if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
        });
        child.on("error", (e) => {
          session.dead = true;
          const current = session.current;
          if (!current) return;
          emit({ ...base(threadId, current.turnId), type: "runtime.error", ...describeSpawnFailure(e, launch.command) });
          settle(threadId, session, false, "spawn_error");
        });
        child.on("close", (code) => {
          session.dead = true;
          const current = session.current;
          if (current) {
            emit({
              ...base(threadId, current.turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`,
            });
            settle(threadId, session, false, "exit_before_result");
          } else if (sessions.get(threadId) === session) {
            // drop the record between turns; a later turn respawns. The
            // identity check keeps an old child's exit from unlinking a
            // session that already replaced this one.
            sessions.delete(threadId);
          }
        });
        return session;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        // Provider-instance `fullAuto` predates per-bot approval levels. Every
        // harness turn now carries the bot's mode, so Ask/Auto must explicitly
        // put the native agent back into its interactive mode. Otherwise a
        // legacy Grok bypassPermissions / Cursor --force / Droid auto-high /
        // Antigravity yolo setting would silently outrank the selector. Calls
        // that omit approvalMode retain the old adapter-level behavior for
        // embedders and tests outside the harness.
        const turnConfig = turn.approvalMode === undefined
          ? config
          : { ...config, fullAuto: turn.approvalMode === "full" && supportsApprovalMode(DRIVER_KIND, "full") };
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && turnConfig.fullAuto && turn.approvalMode !== "full") {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        const cwd = turn.cwd ?? turnConfig.workspace ?? homedir();
        const env = childEnv(turnConfig);
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
          && !(await support.isAuthenticated(env, turnConfig, instanceId))
        ) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
          return { turnId };
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env);
        support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model, fullAuto: turnConfig.fullAuto === true });
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const mcpServers = acpMcpServers(turn);
        let launch: { command: string; args?: string[]; env?: Record<string, string | undefined> };
        try {
          launch = support.resolveCommand
            ? await support.resolveCommand(env, turnConfig, instanceId)
            : { command: turnConfig.cli };
        } catch (error) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: error instanceof Error ? error.message : String(error),
            setup: true,
          });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "setup_required", cost: null });
          return { turnId };
        }

        // The spawn contract: everything that changes what process a turn
        // gets. The model rides argv where a support passes -m, and a
        // selectModel support re-applies it over the wire on the live
        // session, so the model is not a separate axis; fullAuto covers the
        // transformEnv-policy supports (opencode). mcpServers are session
        // establishment inputs — they ride session/new and session/load over
        // the wire — and the harness mints fresh integration bearer tokens
        // every turn, so they must not respawn the process; a change instead
        // re-establishes the session below (see sessionKey).
        // The env the spawned child actually receives is part of the
        // contract too, and arrives hashed as envFingerprint for the same
        // reason.
        const spawnArgs = support.spawnArgs(turnConfig, cliTurn);
        const spawnEnv = launch.env ?? env;
        // Env is part of the spawn contract: a turn that changes auth env
        // (FACTORY_API_KEY placeholder, a fresh login file) must not keep
        // riding a child spawned under the old env. Hash it so secrets
        // never sit in the key itself.
        const envFingerprint = createHash("sha256").update(JSON.stringify(spawnEnv)).digest("hex").slice(0, 16);
        const contractKey = JSON.stringify([launch.command, launch.args ?? [], spawnArgs, cwd, turnConfig.fullAuto === true, envFingerprint]);
        const sessionKey = JSON.stringify(mcpServers);

        if (turn.sessionReset) {
          closeSession(threadId, "reset");
          sessionAllows.delete(threadId);
        }
        const pooled = sessions.get(threadId);
        let session: AcpSession;
        if (pooled && !pooled.dead && !pooled.closing && pooled.contractKey === contractKey) {
          // adoption cancels the idle countdown — a running turn is not quiet
          if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
          pooled.idleTimer = null;
          session = pooled;
        } else {
          if (pooled) {
            // a dead child already exited — just drop the record; a live one
            // gets the full close (contract changed)
            if (pooled.dead) sessions.delete(threadId);
            else closeSession(threadId, "contract");
          }
          session = openSession(threadId, launch, [...(launch.args ?? []), ...spawnArgs], spawnEnv, cwd, contractKey);
          sessions.set(threadId, session);
        }
        // `session` rebinds mid-turn: when the establishment retry below
        // respawns the child, every wire call must reach the live record, so
        // nothing captures the connection off it.
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          receive?: (result: any) => void,
          idleMs?: number,
          idleMessage?: string,
        ): Promise<any> =>
          session.acp.request(method, params, timeoutMs, receive, idleMs, idleMessage);

        const state = { settled: false, promptSent: false, text: "", producedItem: false };
        const asks = new Map<string, AcpAskFinish>();
        const modelOf = (result: any): string | null => {
          const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
            (entry: any) => entry?.id === (support.selectModel?.configId ?? "model"),
          );
          return typeof option?.currentValue === "string" ? option.currentValue : null;
        };
        const receiveModelVariants = (result: any) => {
          session.sessionConfigResult = result;
          if (!support.modelVariants) return;
          const nativeModel = modelOf(result) ?? cliTurn.model;
          if (!nativeModel) return;
          const option = acpVariantOption(result);
          emit({
            ...base(threadId, turnId),
            type: "session.model-variants",
            model: nativeModel === cliTurn.model ? (turn.model ?? nativeModel) : nativeModel,
            variants: {
              options: option?.options ?? [],
              ...(option?.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
            },
          });
        };
        const requestedVariantOption = () => {
          if (!support.modelVariants) throw new Error(`${support.displayName} does not support model variants`);
          const option = acpVariantOption(session.sessionConfigResult);
          if (!option || !option.options.some((entry) => entry.id === turn.variant)) {
            throw new Error(`${support.displayName} does not advertise variant ${turn.variant} for this model`);
          }
          return option;
        };

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          state.producedItem = true;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        const current: AcpTurn = {
          turnId,
          turn: cliTurn,
          turnConfig,
          controlsHost,
          state,
          asks,
          interruptTimer: null,
          flushAssistantText,
          receiveModelVariants,
        };

        const interrupt = () => {
          if (session.sessionId) {
            session.acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } });
            if (current.interruptTimer) clearTimeout(current.interruptTimer);
            current.interruptTimer = setTimeout(() => {
              // an agent that ignores session/cancel must not stay pooled
              closeSession(threadId, "cancel-timeout");
              settle(threadId, session, true, "cancelled");
            }, 5_000);
            current.interruptTimer.unref?.();
          } else {
            // no native session to cancel — the close handler settles
            closeSession(threadId, "stop");
          }
        };
        active.set(threadId, { stop: () => closeSession(threadId, "stop"), interrupt, turnId, asks });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        session.current = current;

        (async () => {
          try {
            // The handshake is paid once per process, not once per turn. It
            // is a function so the establishment retry below can pay it
            // again on a replacement child.
            // Returns whether this runtime accepts image prompts, for the
            // prompt phase below.
            const handshake = async (): Promise<boolean> => {
              if (!session.initResult) {
                session.initResult = await request(
                  "initialize",
                  {
                    protocolVersion: 1,
                    clientInfo: { name: "openmausbot", version: "0.0.0" },
                    clientCapabilities: {
                      fs: {
                        readTextFile: support.clientFileSystem === true,
                        writeTextFile: support.clientFileSystem === true,
                      },
                      terminal: false,
                    },
                  },
                  INIT_TIMEOUT,
                );
              }
              // authenticate is once per process; a turn that skips
              // subscription auth neither checks nor marks the flag
              if (!skipSubscriptionAuthForLocalInject(turn.model) && !session.authenticated) {
                const methods: Array<{ id?: string }> = Array.isArray(session.initResult?.authMethods)
                  ? session.initResult.authMethods
                  : [];
                const methodId = support.pickAuthMethod(methods);
                if (methodId) {
                  try {
                    await request("authenticate", { methodId }, INIT_TIMEOUT);
                    session.authenticated = true;
                  } catch {
                    if (support.authFailure === "fail") throw new Error(support.loginNote);
                    // else: proceed on an ambient login
                  }
                } else if (support.authFailure === "fail") {
                  throw new Error(support.loginNote);
                }
              }
              const images = turn.images ?? [];
              const accepts = session.initResult?.agentCapabilities?.promptCapabilities?.image === true ||
                support.acceptsUnadvertisedImages?.(session.initResult) === true;
              if (images.length && support.images === true && !accepts) {
                throw new Error(
                  `${support.displayName} is configured for image attachments, but this installed runtime does not advertise ACP image input. Update the ${support.displayName} CLI or send the message without an image.`,
                );
              }
              return accepts;
            };
            let runtimeAcceptsImages = await handshake();
            let init = session.initResult;

            const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            let promptTurn = turn;
            let rebuiltFromReplay = false;
            for (;;) {
              const liveSessionId = session.sessionId;
              if (liveSessionId !== null && session.sessionKey === sessionKey && (cursor === null || cursor === liveSessionId)) {
                // the pooled session still answers the cursor (or the cursor's
                // absence) and was established with these exact session inputs:
                // prompt it directly — no session/load replay, no session/new,
                // no fresh session bookkeeping
                break;
              }
              // stdio is every agent's baseline; a url server rides only with
              // an agent that advertised its transport, so an agent without
              // http/sse never sees an entry it would refuse the session over
              const sessionServers = mcpServers.filter((server) =>
                !("type" in server) || init?.agentCapabilities?.mcpCapabilities?.[server.type] === true);
              let loaded = false;
              if (cursor) {
                try {
                  await request(
                    support.resumeMethod === "resume" ? "session/resume" : "session/load",
                    { sessionId: cursor, cwd, mcpServers: sessionServers },
                    LOAD_SESSION_TIMEOUT,
                    (result) => {
                      if (result) {
                        loaded = true;
                        session.sessionId = cursor;
                        session.sessionKey = sessionKey;
                        receiveModelVariants(result);
                      }
                    },
                  );
                } catch (error) {
                  const classification = support.classifyError?.(error);
                  // OpenCode encodes ACPSessionNotFoundError as invalidParams
                  // with just the rejected sessionId. Other invalidParams
                  // responses (model/config errors) must not erase history.
                  const data = (error as any)?.data;
                  const missingSession = data && typeof data === "object" && !Array.isArray(data)
                    && data.sessionId === cursor && Object.keys(data).length === 1;
                  if (classification === "invalid_credentials" || classification === "inactive_subscription"
                      || ((error as any)?.code === -32602 && !missingSession)) throw error;
                  /* session gone, load unsupported, or too slow — the
                   * fallbacks below choose between one fresh process and a
                   * genuinely new session */
                }
              }
              if (loaded) break;
              if (cursor && liveSessionId === cursor) {
                // The agent refused (or never answered) re-establishing its
                // own live session on this process. Continuity outranks the
                // saved handshake: close the pooled child and resume the
                // recorded session on a fresh one — the pre-pool path every
                // agent already supports. A load that fails there too means
                // the session is genuinely gone; the loop falls through to
                // session/new on the replacement child.
                session.current = null;
                closeSession(threadId, "reestablish");
                session = openSession(threadId, launch, [...(launch.args ?? []), ...spawnArgs], spawnEnv, cwd, contractKey);
                sessions.set(threadId, session);
                session.current = current;
                runtimeAcceptsImages = await handshake();
                init = session.initResult;
                continue;
              }
              // a genuinely fresh native session forgets what the previous
              // one allowed
              sessionAllows.delete(threadId);
              if (cursor) {
                const recovery = recoveryPromptFor({
                  recoveryText: turn.recoveryText,
                  currentText: turn.text,
                  failure: "before-accept",
                });
                promptTurn = { ...turn, text: recovery.text };
                rebuiltFromReplay = recovery.replayed;
              }
              sessionResult = await request("session/new", { cwd, mcpServers: sessionServers }, NEW_SESSION_TIMEOUT, (result) => {
                session.sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
                session.sessionKey = sessionKey;
                receiveModelVariants(result);
              });
              break;
            }
            // every establishment path leaves a native session id behind
            const sessionId = session.sessionId;
            if (sessionId === null) throw new Error("session/new returned no sessionId");
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
                ...(rebuiltFromReplay ? { rebuilt: true } : {}),
              });
            };

            try {
              if (support.selectModel) {
                const { configId } = support.selectModel;
                selectedModel = modelOf(session.sessionConfigResult);
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  sessionResult = await request(
                    "session/set_config_option",
                    { sessionId, configId, value: cliTurn.model },
                    INIT_TIMEOUT,
                    receiveModelVariants,
                  );
                  selectedModel = modelOf(session.sessionConfigResult);
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                });
                // initialize's currentModelId is the CLI default,
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
              if (turn.variant !== undefined) {
                const option = requestedVariantOption();
                await request(
                  "session/set_config_option",
                  { sessionId, configId: option.configId, value: turn.variant },
                  SESSION_CONFIG_TIMEOUT,
                  receiveModelVariants,
                );
                if (requestedVariantOption().currentValue !== turn.variant) {
                  throw new Error(`${support.displayName} did not apply variant ${turn.variant}`);
                }
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            const text = support.buildPromptText
              ? support.buildPromptText(promptTurn)
              : promptTurn.system
                ? `${promptTurn.system}\n\n${promptTurn.text}`
                : promptTurn.text;
            const imageBlocks = support.images === true && runtimeAcceptsImages
              ? await readAcpImageBlocks(turn.images ?? [])
              : [];
            if (support.modelVariants && cliTurn.model && modelOf(session.sessionConfigResult) !== cliTurn.model) {
              throw new Error(`${support.displayName} changed model before the prompt`);
            }
            if (turn.variant !== undefined && requestedVariantOption().currentValue !== turn.variant) {
              throw new Error(`${support.displayName} changed variant before the prompt`);
            }
            state.promptSent = true;
            const promptIdleMs = promptIdleTimeoutMs();
            const result = await request(
              "session/prompt",
              { sessionId, prompt: [{ type: "text", text }, ...imageBlocks] },
              undefined,
              undefined,
              promptIdleMs,
              `${DRIVER_KIND} went fully silent ${Math.round(promptIdleMs / 1000)} s after the message and the turn was stopped. ` +
                "Raise OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS if this model legitimately takes longer to answer.",
            );
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(threadId, session, true, null);
            else if (reason === "cancelled") settle(threadId, session, true, "cancelled");
            else {
              const errorMessage = typeof result?.error === "string" && result.error
                ? result.error
                : typeof result?.message === "string" && result.message
                  ? result.message
                  : `Model turn failed: ${reason ?? "unknown error"}`;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: errorMessage,
              });
              settle(threadId, session, false, reason ?? "failed");
            }
          } catch (e) {
            if (!state.settled) {
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || message === support.loginNote;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message,
                ...(needsAuth ? { setup: true } : {}),
              });
              // Internal RPC failures can leave a live child poisoned just
              // like a silent prompt. Evict before completion listeners can
              // start the next turn. Never replay this accepted prompt: it
              // may already have executed tools. The next explicit turn can
              // resume the recorded session on a fresh process.
              if (!needsAuth && ((e as any)?.acpPromptStall === true || (e as any)?.acpSessionFailure === true
                  || code === "upstream_outage") && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, (e as any)?.acpPromptStall === true ? "prompt-stall" : "rpc-failure");
              }
              settle(threadId, session, false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        if (support.snapshot) return support.snapshot(env, config, instanceId);
        const version = await new Promise<string | null>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        return { state: "available", version, authenticated: await support.isAuthenticated(env, config, instanceId) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
        customMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            nativeImageInput: support.images === true,
            effortLevels: support.effortLevels,
            modelVariants: support.modelVariants === true,
            // OpenMausBot supplies a per-bot approvalMode on every harness
            // turn, which safely overrides a legacy instance fullAuto value.
            // Direct adapter calls that omit it still fail closed in sendTurn.
            localComputerMcp: true,
          },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            finish(decision.behavior, "user", decision.message, decision.always === true);
            return decision.behavior === "allow"
              ? "allowed-once"
              : decision.behavior === "answer"
                ? "answered"
                : "rejected";
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
            // idle pooled sessions have no running turn — close them too
            for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "stopAll");
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          for (const { stop } of active.values()) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "dispose");
          listeners.clear();
        },
      };
    },
  };
}

// The shared ACP (JSON-RPC 2.0 over stdio) driver; per-CLI quirks live in an AcpSupport.
// ACP has no turn/completed: the session/prompt result (stopReason + usage) is the completion.
// session/load replays history as ordinary session/update notifications, so nothing emits before
// the prompt is sent and `_meta.isReplay` updates are dropped. Permissions fail closed: only an
// `allow`-kind option approves, and option order is never a security contract.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { openStartupModelCatalog, writeStartupModelCache } from "../../startup-model-catalog.ts";
import { decodeInjectId } from "../local-inject.ts";
import { DeviceAuthController, type DeviceSignIn } from "../device-auth.ts";
import { deletePromptSplitReceipt, promptHalves, readPromptSplitReceipt, splitSessionPrompt, writePromptSplitReceipt } from "../prompt-split.ts";
import type { PromptSplitReceipt } from "../prompt-split.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { runAcpOneShot } from "./background-text.ts";
import { sanitizeAcpToolMessage } from "./tool-log.ts";
import { stripLeakedSystemHarnessMessages } from "../../../shared/system-message-guard.ts";
import {
  classifyQuiet, describeQuiet, formatQuietLimit, lastSeenPhrase, LogTail, promptIdleTimeoutMs, quietKey, sampleProcessTree,
  type LogSignal, type ProcessSample, type QuietState,
} from "./quiet-status.ts";
import { readSessionReport } from "./session-reports.ts";
import { acpVariantOption, offeredModels } from "./config-options.ts";
import { versionFromProbe } from "./version-probe.ts"; import { engineHomes } from "../../engine-homes/engine-homes.ts";

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
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
  RequestOutcome,
  TextGenerationOptions,
  TurnImageInput,
} from "../../contracts.ts";
import { newEventId, newId, TurnNotStartedError } from "../../contracts.ts";
import { augmentedPath } from "../../env-path.ts";
import { supportsApprovalMode } from "../../../shared/approval-mode.ts";
import { MAX_QUESTION_TEXT, parseAskQuestions, parseChoices, questionAnswersByQuestion } from "../../../shared/ask-question.ts";

import { appendNative } from "../native.ts";
import { acpSessionOperationKey, acpShellRequest, answersAlone, permissionLaunchCwd } from "../permission-command.ts";
import { openQuestionRequest, questionRequestFor, type AcpQuestionRequest } from "./question-requests.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { extractMcpImages } from "../../mcp-tool-images.ts";
import { AcpHost, type AcpLink } from "./host.ts";
import { recoveryPromptFor } from "../../resume-recovery.ts";
import { engineIdleMs, sessionIdlePolicy } from "../session-idle.ts";
import { classifyError } from "../retry.ts";
import { engineFailureKind, engineFailureMessage } from "../engine-errors.ts";
import { narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope.ts";
import { acpMcpServers, type AcpMcpServer } from "../turn-mcp.ts"; import { acpToolProgress } from "../tool-progress.ts";
import { learnedToolCountLimit, mcpToolBudget, retryUnderToolLimit } from "../../tool-count-limit.ts"; import { instanceEnvNames } from "../../bot-box/env.ts";

/** Failures fixed on the provider account, not by retrying; the reporting process stays pooled. */
export type AccountErrorCode = Extract<ProviderErrorCode,
  "invalid_credentials" | "inactive_subscription" | "insufficient_funds" | "quota_or_region_restriction">;
const ACCOUNT_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set<AccountErrorCode>([
  "invalid_credentials", "inactive_subscription", "insufficient_funds", "quota_or_region_restriction",
]);
const isAccountError = (code: ProviderErrorCode | undefined): code is AccountErrorCode =>
  code !== undefined && ACCOUNT_ERROR_CODES.has(code);

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

type AcpAskFinish = (
  behavior: string,
  source?: "user" | "timeout" | "system",
  message?: string,
  always?: boolean,
) => RequestOutcome;

interface AcpTurn {
  turnId: string;
  turn: SendTurnInput;
  turnConfig: AcpConfig;
  controlsHost: boolean;
  state: {
    settled: boolean; promptSent: boolean; text: string; textMessageId: string | null; producedItem: boolean; startupActivity: boolean; stopped: boolean;
    usagePeak: number | null;
    usageLast: number | null;
    usageCompacted: boolean;
    turnUsage?: { input: number; output: number; cachedInput?: number };
  };
  acknowledge: () => void;
  asks: Map<string, AcpAskFinish>;
  /** Tool calls started and not yet finished: a tool such as `sleep` sends nothing while it runs. */
  runningTools: Set<string>;
  unkeyedToolIds: string[];
  interruptTimer: ReturnType<typeof setTimeout> | null;
  stopQuietWatch: (() => void) | null;
  flushAssistantText: () => void;
  receiveModelVariants: (result: any) => void;
}

interface AcpSession {
  child: ReturnType<typeof spawnCli>;
  host: AcpHost;
  acp: AcpLink;
  launch: { command: string; args?: string[] };
  env: Record<string, string | undefined>;
  cwd: string;
  contractKey: string;
  /** mcpServers the native session was built with. They ride session/new and session/load, not argv,
   *  and bearer tokens rotate every turn, so a change re-establishes the session on the same child. */
  sessionKey: string | null;
  sessionId: string | null;
  sessionConfigResult: any;
  initResult: any;
  authenticated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  dead: boolean;
  readonly stderr: string;
  current: AcpTurn | null;
  fallbackNotice?: string;
  launchModel?: string;
}

/** Per-CLI specifics plugged into the shared ACP runtime. */
export interface AcpSupport {
  questionRequests?: Readonly<Record<string, AcpQuestionRequest>>;
  /** Verified native catalog parameters, applied before both new and restored sessions. */
  toolScopeSessionParams?(turn: SendTurnInput, initializeResult: unknown, hasMcp: boolean,
    context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): Record<string, unknown>;
  /** Existing native restrictions also participate in scoped session reuse. */
  toolScopeCacheKey?(context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): string;
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs. Custom-only CLIs have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels the CLI accepts, ascending; omit when it has none. Static because describe()
   * runs before any session exists. */
  effortLevels?: readonly EffortLevel[];
  /** Discover and select opaque model variants through ACP config options. */
  modelVariants?: boolean;
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog; a failed lookup keeps the last usable one. `config` lets a
   *  support ask the binary it will spawn, not whatever is on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Some managed agents are not probed at app startup; their Refresh is the only lookup. */
  resolveModelsOnCreate?: boolean;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this CLI can consume a referenced image. */
  images?: boolean;
  /** Narrow compatibility exception for a CLI with verified native image
   * transport but a defective initialize capability (never a path fallback). */
  acceptsUnadvertisedImages?(initializeResult: unknown): boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** The CLI's own device-code login (`grok login --device-auth`), run with the turns' binary and
   * environment and confirmed by isAuthenticated. */
  deviceSignIn?: DeviceSignIn;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv (opencode's ACP subcommand
   *  takes no -m). The agent must confirm it before the prompt. */
  selectModel?: { configId: string };
  /** With `selectModel`: the model a turn runs when it asked for none or for one this session does
   * not offer; null keeps the strict behaviour. */
  fallbackModel?(sessionConfig: unknown, catalogDefault: string): string | null;
  /** Env var the runtime reads its new-session default model from, set at spawn so session/new runs
   * it. The runtime takes any id unchecked, so it is set only for a model this account offered. Not
   * part of the spawn contract. */
  sessionModelEnv?: string;
  /** Spawn-contract state outside the env that a running process never re-reads (OpenCode's auth.json). */
  spawnFingerprint?(env: Record<string, string | undefined>, config: AcpConfig): string;
  /** The approval mode is applied per turn by configureSession, which must throw unless the runtime
   * confirms it; an approval change never respawns the process. */
  sessionScopedApproval?: boolean;
  /** False when this engine cannot run memory upkeep's one-shot text call cleanly. */
  backgroundText?: false;
  /** Mutate the child env in place. `instanceEnvironment` tells a key put there on purpose from one
   *  riding along in the server's own env. */
  transformEnv?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
    instanceEnvironment: Readonly<Record<string, string>>,
  ): void;
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
  /** Some agents acknowledge a live load without applying new MCP credentials. */
  restartOnMcpChange?: boolean;
  /** hermes-agent 0.22.4 re-sends a streamed reply whole under its messageId, as its `💭` reasoning block, a blank line,
   * then the reply; that chunk is dropped instead of appended. */
  resendsReasoningReply?: boolean;
  /** Threads with the same spawn contract run their sessions in one process (OpenCode 1.19: about 100 MB a session
   * instead of about 450 MB a process), up to SHARED_SESSIONS_MAX. */
  shareProcess?: boolean;
  /** Route workspace file access through ACP so edits retain approval cards. */
  clientFileSystem?: boolean;
  /** Sent as `clientCapabilities._meta` on initialize, where agents read vendor capabilities. */
  clientCapabilitiesMeta?: Record<string, unknown>;
  /** The agent reaches MCP servers by URL: OpenMausBot's own servers are this server's endpoints, no process each. */
  ownMcpOverHttp?: boolean;
  /** How many tools the agent lists of its own beside the MCP servers', counted against a provider's tool limit. */
  engineTools?: number;
  /** Do not retain stderr from providers that may place OAuth material there. */
  redactStderr?: boolean;
  /** The agent's own debug log, read while a prompt is quiet: a new line proves it alive and `parse`
   * picks what to tell the person. Null when this process keeps none. */
  statusLog?: {
    path(env: Record<string, string | undefined>, sessionId: string): string | null;
    parse(line: string): LogSignal | null;
  };
  /** Bound provider-native tool payloads before writing diagnostic logs. */
  sanitizeToolPayload?: boolean;
  /** Mutate the child env once the turn model is known; catalog refresh and snapshot see only `transformEnv`. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string; fullAuto: boolean; botId?: string; cwd: string; toolScope?: SendTurnInput["toolScope"]; threadId: string; mcpServers: AcpMcpServer[] },
  ): void;
  /** The authenticate methodId from initialize's authMethods; null skips authenticate. */
  pickAuthMethod(authMethods: Array<{ id?: string }>, env: Record<string, string | undefined>): string | null;
  /** "fail": abort if auth is missing/errors (subscription CLIs).
   * "fail-request": cached API credentials need no method, but a requested
   * OAuth login must succeed. "continue": proceed on an ambient login. */
  authFailure: "fail" | "fail-request" | "continue";
  /** Whether this CLI can run a turn (env carries the merged config). */
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
  /** Plain words for an account failure (bad key, no credit, a used-up
   * quota, no subscription) in place of the provider's raw RPC text. */
  describeAccountError?(code: AccountErrorCode, model?: string): string;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn and session/select. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Per-session settings between session/new (or load) and the first prompt. Some CLIs ignore argv
   * and take the model/mode over the wire (droid); a throw fails the turn rather than run another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    env: Record<string, string | undefined>;
    config: AcpConfig;
    turn: SendTurnInput;
    /** The session's advertised models, verbatim: some CLIs name ACP model ids differently from
     * their argv slugs (Cursor answers `default[]` for the CLI's `auto`). */
    sessionModels: Array<{ modelId?: string; name?: string }>;
    /** Last model acknowledged by session/new/load/set_model, preserved for pooled turns. */
    currentModelId?: string;
    /** session/new's or session/load's `configOptions`, verbatim. */
    configOptions: Array<{ id?: unknown; currentValue?: unknown }>;
    /** Tell the person the session runs another model than the one picked. */
    notice: (message: string) => void;
  }): Promise<void>;
}

const envOr = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);
const INIT_TIMEOUT = 300_000;
const SESSION_CONFIG_TIMEOUT = 300_000;
const NEW_SESSION_TIMEOUT = 300_000;
const LOAD_SESSION_TIMEOUT = 120_000;
const ACP_STUCK_AFTER_MS = 180_000;
const SHARED_SESSIONS_MAX = 6, SHARED_SESSIONS_LIFETIME = 12;
/** Closing a session for these leaves its process fit for other threads' sessions; any other reason retires it. */
const HEALTHY_CLOSE = new Set(["idle", "reset", "contract", "stop", "stopAll", "dispose", "approval-unconfirmed"]);
/** ACP agents may compact their history silently; re-send the full prompt after this many bare turns. */
const ACP_PROMPT_RE_ANCHOR_TURNS = 8;
/** A `tool_call` without a status is pending (ACP's default); a `tool_call_update` without one leaves the call as it was. */
function trackRunningTool(current: AcpTurn, update: { toolCallId?: unknown; status?: unknown }, defaultStatus?: "pending"): void {
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return;
  const status = update.status ?? defaultStatus;
  if (status === "completed" || status === "failed") current.runningTools.delete(update.toolCallId);
  else if (status === "pending" || status === "in_progress") current.runningTools.add(update.toolCallId);
}

function isHermesReasoningReplay(chunk: string, streamed: string): boolean {
  const reply = streamed.trim();
  const replay = chunk.trim();
  return reply !== "" && /^(?:> |-# )?💭/.test(replay) && replay.endsWith(reply)
    && /\n\n[ \t]*$/.test(replay.slice(0, -reply.length));
}

let unkeyedToolSeq = 0;
/** A synthetic id for a `tool_call` without `toolCallId`, paired FIFO with the first terminal update. */
function nextUnkeyedToolId(current: AcpTurn): string {
  const id = `acp-tool-unkeyed-${++unkeyedToolSeq}`;
  current.unkeyedToolIds.push(id);
  return id;
}
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
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

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  if (support.sessionScopedApproval && !support.configureSession) {
    throw new Error(`${support.displayName}: sessionScopedApproval needs configureSession to apply each turn's mode`);
  }
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
  const QUESTION_NO_MATCH_NOTE =
    "That answer isn't one of the choices this AI can take, so the question was closed and the turn stopped. Ask again and pick one of the options.";

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
        // Foreign provider keys would flip billing off the CLI's login, and workspace credentials are
        // the harness's: only credentialEnv passes.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        stripControlPlaneEnv(env);
        support.transformEnv?.(env, activeConfig, instanceId, input.environment);
        return env;
      };
      let models = support.models;
      let accountModels: ReadonlySet<string> | null = null;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config, instanceId);
          if (resolved.options.length) {
            models = resolved;
            accountModels = new Set(resolved.options.map((option) => option.id));
          }
        } catch {}
        try { writeStartupModelCache(instanceId, models); } catch {}
      };
      let startupModelRefresh: Promise<void> | null = null;
      if (support.resolveModels && support.resolveModelsOnCreate !== false) {
        startupModelRefresh = (await openStartupModelCatalog({
          instanceId,
          use: (catalog) => { models = catalog; },
          current: () => models,
          refresh: refreshModels,
        }))?.pending ?? null;
      } else if (support.resolveModelsOnCreate !== false) {
        await refreshModels();
      }
      const deviceSignIn = support.deviceSignIn
        ? new DeviceAuthController(support.deviceSignIn, { cli: config.cli, environment: () => childEnv(), onAuthenticated: refreshModels })
        : null;
      const listeners = new Set<RuntimeEventListener>();
      let disposing = false;
      const requireRunning = () => {
        if (disposing) throw new Error(`${support.displayName} is shutting down`);
      };
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, AcpAskFinish>;
      }
      const active = new Map<string, Turn>();
      const sessions = new Map<string, AcpSession>();
    // Retain every closing Qwen child until its tree is gone: closing drops the pool entry, not its native writer lease.
      const retiring = new Map<string, Set<ReturnType<typeof spawnCli>>>();
      const retireChild = async (threadId: string, child: ReturnType<typeof spawnCli>): Promise<boolean> => {
        let children = retiring.get(threadId);
        if (!children) retiring.set(threadId, children = new Set());
        children.add(child);
        const stopped = await killCliTree(child);
        if (stopped) {
          children.delete(child);
          if (!children.size && retiring.get(threadId) === children) retiring.delete(threadId);
        }
        return stopped;
      };
      const sessionIdle = sessionIdlePolicy("ACP");

      const closeSession = (threadId: string, why: string) => {
        const session = sessions.get(threadId);
        if (!session || session.closing) return;
        session.closing = true;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { close: why } });
        sessions.delete(threadId);
        const { host, sessionId } = session;
        if (!HEALTHY_CLOSE.has(why)) host.draining = true;
        session.acp.close();
        if (host.links.size) {
          host.retired += 1;
          recycleWhenIdle(host);
          if (sessionId && host.initResult?.agentCapabilities?.sessionCapabilities?.close) {
            void host.request(null, "session/close", { sessionId }, 30_000).catch(() => undefined);
          }
          return;
        }
        host.draining = true;
      // EOF is no guaranteed exit: Qwen is tracked before another turn can resume its history.
        try {
          session.child.stdin.end();
        } catch {}
        if (support.restartOnMcpChange) void retireChild(threadId, session.child);
        else {
          const kill = setTimeout(() => {
            void killCliTree(session.child);
          }, 5_000);
          kill.unref?.();
        }
      };
      // A shared process holding closed sessions gives their memory back only by exiting: once none of its sessions has
      // run a turn for a while, it ends and each thread's next turn loads its session in a new one.
      const hostBusy = (host: AcpHost) => [...host.links].some((link) => sessions.get(link.threadId)?.current);
      const recycleWhenIdle = (host: AcpHost) => {
        if (!host.retired || host.recycle || hostBusy(host)) return;
        host.recycle = setTimeout(() => {
          if (!hostBusy(host)) {
            host.draining = true;
            for (const link of host.links) closeSession(link.threadId, "recycle");
          }
          host.recycle = null;
        }, envOr("OMB_ACP_SHARED_RECYCLE_MS", 60_000));
        host.recycle.unref?.();
      };
      const armIdle = (threadId: string) => {
        const session = sessions.get(threadId);
        if (!session) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => closeSession(threadId, "idle"), engineIdleMs(threadId, sessionIdle));
        session.idleTimer.unref?.();
      };
    // Session allows the driver keeps when the agent offered no `allow_always`: exact operations per
    // thread, for the native session's life. A generic title with no input is never remembered.
      const sessionAllows = new Map<string, Set<string>>();

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };

    // Inline images stay on the wire but never go into the native log as base64.
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


      const startQuietWatch = (threadId: string, session: AcpSession, current: AcpTurn) => {
        const noticeAfterMs = envOr("OMB_ACP_QUIET_NOTICE_MS", 60_000);
        const tickMs = envOr("OMB_ACP_QUIET_TICK_MS", 15_000);
        const logPath = support.statusLog && session.sessionId
          ? support.statusLog.path(session.env, session.sessionId)
          : null;
        const tail = logPath ? new LogTail(logPath) : null;
        tail?.read();
        let logged: { signal: LogSignal; at: number } | null = null;
        let context: { tokens: number; threshold: number } | null = null;
        let previous: ProcessSample | null = null;
        let previousAt = 0;
        let shownKey: string | null = null;
        let noSignsSince: number | null = null;
        let notices = 0;
        let probing = false;
        let state: QuietState | null = null;
        const promptStartedAt = Date.now();
        const tick = async () => {
          if (probing || current.state.settled || session.current !== current) return;
          const now = Date.now();
          for (const line of tail?.read() ?? []) {
            session.acp.touch();
            const signal = support.statusLog!.parse(line);
            if (signal?.kind === "context") context = { tokens: signal.tokens, threshold: signal.threshold };
            else if (signal) logged = { signal, at: now };
          }
          const quietMs = now - Math.max(promptStartedAt, session.acp.lastInboundAt);
          if (quietMs < noticeAfterMs || current.asks.size || current.runningTools.size) {
            if (quietMs < noticeAfterMs) logged = null;
            previous = null;
            shownKey = null;
            noSignsSince = null;
            state = null;
            return;
          }
          // Qwen's SDK retries on its own for about a minute before the next logged attempt.
          if (logged?.signal.kind === "retry"
              && now - logged.at > (logged.signal.delayMs ?? 60_000) + 120_000) logged = null;
          probing = true;
          const sample = session.child.pid ? await sampleProcessTree(session.child.pid) : { cpuMs: null, connections: null };
          probing = false;
          if (current.state.settled || session.current !== current) return;
          let next = classifyQuiet({
            logged: logged?.signal ?? null, context, sample, previous, sinceMs: previous ? now - previousAt : 0,
          });
          const first = previous === null;
          previous = sample;
          previousAt = now;
          if (first && next.kind === "unknown") return;
          // An SDK sleeping between retries holds no socket and burns no CPU (Qwen against a 429ing endpoint).
          if (next.kind === "no-signs") {
            noSignsSince ??= now;
            if (now - noSignsSince < ACP_STUCK_AFTER_MS) next = { kind: "between-requests" };
          } else {
            noSignsSince = null;
          }
          state = next;
          const key = quietKey(next);
          if (key === shownKey || notices >= 12) return;
          shownKey = key;
          notices += 1;
          emit({
            ...base(threadId, current.turnId),
            type: "runtime.notice",
            message: describeQuiet(support.displayName, next, quietMs, promptIdleTimeoutMs()),
          });
        };
        const timer = setInterval(() => { void tick(); }, tickMs);
        timer.unref?.();
        current.stopQuietWatch = () => clearInterval(timer);
        return { lastState: () => state };
      };

      const settle = (threadId: string, session: AcpSession, ok: boolean, stopReason: string | null) => {
        const current = session.current;
        if (!current || current.state.settled) return;
        current.state.settled = true;
        current.acknowledge();
        current.stopQuietWatch?.();
        if (current.interruptTimer) clearTimeout(current.interruptTimer);
        for (const finish of current.asks.values()) finish("cancel", "system");
        session.acp.failAll(new Error("turn settled"));
      // Detach before the final events: a listener may start the next turn synchronously.
        session.current = null;
        active.delete(threadId);
        current.flushAssistantText();
      // `end_turn` with nothing to show is a lost turn: a provider may cut a reasoning-only stream
      // and still answer end_turn.
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
        emit({ ...base(threadId, current.turnId), type: "turn.completed", ok: finalOk, stopReason: finalStopReason, cost: null,
          ...(current.state.turnUsage ? { usage: current.state.turnUsage } : {}) });
        if (session.child.exitCode === null && !session.closing && !session.dead) {
          armIdle(threadId);
          recycleWhenIdle(session.host);
        } else if (session.dead && sessions.get(threadId) === session) {
          sessions.delete(threadId);
        }
      };

      const hosts = new Set<AcpHost>();
      // Between turns nothing is brokered; the agent must never block on an unanswered request.
      const refuse = (msg: any, send: (obj: unknown) => void) => {
        const question = questionRequestFor(support.questionRequests, msg.method);
        send(msg.method === "session/request_permission"
          ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
          : question
            ? { jsonrpc: "2.0", id: msg.id, result: question.cancelled }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      };
      const sharedHost = (hostKey: string | null): AcpHost | null => {
        if (hostKey === null) return null;
        for (const host of hosts) if (host.key === hostKey && host.accepts(SHARED_SESSIONS_MAX, SHARED_SESSIONS_LIFETIME)) return host;
        return null;
      };
      const hostFor = (launch: { command: string }, argv: string[], env: Record<string, string | undefined>, cwd: string,
        hostKey: string | null): AcpHost => {
        const running = sharedHost(hostKey);
        if (running) return running;
        const child = spawnCli(launch.command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], box: { allowEnv: instanceEnvNames(input.environment, env) } }, "bot");
        const host = new AcpHost(child, hostKey, { source: SOURCE, logMessage: nativeLogMessage, keepStderr: !support.redactStderr, unrouted: refuse });
        hosts.add(host);
        child.once("close", () => hosts.delete(host));
        child.once("error", () => hosts.delete(host));
        return host;
      };

      const openSession = (
        threadId: string,
        launch: { command: string; args?: string[] },
        argv: string[],
        env: Record<string, string | undefined>,
        cwd: string,
        contractKey: string,
        hostKey: string | null,
      ): AcpSession => {
        const commandCwd = permissionLaunchCwd(cwd);
        const host = hostFor(launch, argv, env, cwd, hostKey);
        const acp = host.link(threadId);
        const send = (obj: unknown) => acp.send(obj);

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

        const handleServerRequest = (msg: any, current: AcpTurn) => {
          current.state.startupActivity = true;
          if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
            void handleClientFileRequest(msg);
            return;
          }
          const question = questionRequestFor(support.questionRequests, msg.method);
          if (question) return openQuestionRequest(msg, question, current, send, emit, () => base(threadId, current.turnId));
          if (msg.method !== "session/request_permission") {
          // An unanswered server request blocks the agent.
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
          if (current.turnConfig.fullAuto && current.turn.approvalMode === undefined && !isQuestion && answersAlone(toolCall.rawInput?.command)) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const operationKey = isQuestion || current.controlsHost ? null : acpSessionOperationKey(toolCall);
          if (operationKey && answersAlone(toolCall.rawInput?.command) && sessionAllows.get(threadId)?.has(operationKey)) {
            const allow = optionFor("allow");
            if (allow) {
              return send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow } } });
            }
          }
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const isShellCommand = !isQuestion && kind === "execute" && !/^mcp(?:__|[.:])/i.test(String(toolCall.title ?? ""));
          const rawSummary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool);
          const summary = rawSummary.slice(0, isQuestion ? MAX_QUESTION_TEXT : 200);
          const questionChoices = isQuestion
            ? options.flatMap((option) => typeof option.name === "string" && option.name.trim() ? [option.name.trim()] : [])
            : [];
          const askQuestions = isQuestion && questionChoices.length
            // An ACP question answers with one of its option ids, never free text.
            ? parseAskQuestions({ questions: [{ question: summary, options: questionChoices, custom: false }] }) ?? undefined
            : undefined;
          const requestId = newId();
          const finish = (
            behavior: string,
            source: "user" | "timeout" | "system" = "user",
            message?: string,
            always?: boolean,
          ): RequestOutcome => {
            if (!current.asks.delete(requestId)) return "unavailable";
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const forSession = want === "allow" && always === true && !isQuestion && !current.controlsHost;
            const picked = askQuestions
              ? questionAnswersByQuestion(message ?? "", askQuestions)[askQuestions[0]!.question] ?? message
              : message;
            const named = isQuestion && behavior === "answer"
              ? options.filter((option) => option.optionId === picked || parseChoices([option.name], 1)?.[0] === picked)
              : [];
            const optionId = behavior === "cancel"
              ? null
              : isQuestion
                ? named.length === 1 && typeof named[0].optionId === "string" ? named[0].optionId : null
                : forSession
                  ? optionAlways ?? optionFor("allow")
                  : optionFor(want);
            if (forSession && !optionAlways && optionId && operationKey) {
              const remembered = sessionAllows.get(threadId) ?? new Set<string>();
              remembered.add(operationKey);
              sessionAllows.set(threadId, remembered);
            }
            if (behavior !== "cancel" && !optionId) {
              if (!isQuestion) missing(want);
              else if (behavior === "answer") {
                emit({ ...base(threadId, current.turnId), type: "runtime.error", message: QUESTION_NO_MATCH_NOTE });
              }
            }
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            // ACP means "cancelled" only while cancelling the prompt turn, so an agent may then wait for
            // session/cancel (Antigravity does): end the turn.
            if (!optionId && behavior !== "cancel" && session.current === current) active.get(threadId)?.interrupt();
            emit({
              ...base(threadId, current.turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && isQuestion ? "answer" : optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: current.controlsHost ? "local-computer" : undefined,
            });
            return !optionId ? "rejected" : isQuestion ? "answered" : behavior === "allow" ? "allowed-once" : "rejected";
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
            ...acpShellRequest(isShellCommand, isQuestion ? undefined : toolCall.rawInput, commandCwd),
            requiresExplicitApproval: isShellCommand && (
              toolCall.rawInput?.dangerouslyDisableSandbox === true || toolCall.rawInput?.sandbox_permissions === "require_escalated"
            ) || undefined,
            choices: askQuestions?.[0]?.options.map(option => option.label) ?? (isQuestion ? questionChoices : undefined),
            ...(askQuestions ? { questions: askQuestions } : {}),
            approvalScope: current.controlsHost ? "local-computer" : undefined,
            allowSession: !isQuestion && !current.controlsHost ? true : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          // Vendor side-channels (grok's `_x.ai/*`) are only teed to the native log.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (p._meta?.isReplay === true) return;
          const current = session.current;
          if (support.modelVariants && p.update?.sessionUpdate === "config_option_update") {
            if (current && !current.state.settled && session.sessionId && p.sessionId === session.sessionId) current.receiveModelVariants(p.update);
            return;
          }
          if (current && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(p.update?.sessionUpdate)) {
            current.state.startupActivity = true;
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
                const messageId = typeof u.messageId === "string" ? u.messageId : null;
                if (support.resendsReasoningReply && messageId && messageId === current.state.textMessageId
                    && isHermesReasoningReplay(delta, current.state.text)) break;
                current.state.textMessageId = messageId;
                current.state.text += delta;
                const trimmed = current.state.text.trimStart();
                if (!trimmed.startsWith("<SYSTEM_MESSAGE") &&
                    !trimmed.startsWith("The following is a <SYSTEM_MESSAGE") &&
                    !trimmed.startsWith("<SYSTEM_NOTIFICATION")) {
                  emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "assistant_text", delta });
                }
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              break;
            }
            case "tool_call": {
              current.flushAssistantText();
              trackRunningTool(current, u, "pending");
              emit({
                ...base(threadId, current.turnId),
                type: "item.started",
                itemType: "tool",
                itemId: (typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId : nextUnkeyedToolId(current),
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
                summary: commandSummary(u.rawInput),
                input: toolDetailPreview(u.rawInput),
              });
              break;
            }
            case "tool_call_update": {
              trackRunningTool(current, u);
              if (u.status === "completed" || u.status === "failed") {
                current.state.producedItem = true;
                emit({
                  ...base(threadId, current.turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: (typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId : current.unkeyedToolIds.shift(),
                  ok: u.status !== "failed",
                  output: toolDetailPreview(u.rawOutput ?? u.content),
                });
                for (const img of extractMcpImages(u.content ?? u.rawOutput)) {
                  emit({ ...base(threadId, current.turnId), type: "item.completed", itemType: "assistant_image", data: img.data });
                }
              }
              break;
            }
            case "usage_update":
            case "session_info_update":
            case "plan": {
              const report = readSessionReport(u, p._meta, current.state, session);
              if (report.context) emit({ ...base(threadId, current.turnId), type: "thread.token-usage.updated", input: 0, output: 0, ...report.context });
              if (!report.step) break;
              current.flushAssistantText();
              const itemId = `plan-${newId()}`;
              emit({ ...base(threadId, current.turnId), type: "item.started", itemType: "tool", itemId, ...report.step });
              emit({ ...base(threadId, current.turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
              break;
            }
          }
          // A call still running (its kind, file and diff so far) feeds the chat's status line.
          const draft = acpToolProgress(u); if (draft) emit({ ...base(threadId, current.turnId), ...draft });
        };

        const session: AcpSession = {
          child: host.child,
          host,
          acp,
          launch,
          env,
          cwd,
          contractKey,
          sessionKey: null,
          get sessionId() { return acp.sessionId; },
          set sessionId(id: string | null) { acp.sessionId = id; },
          sessionConfigResult: null,
          get initResult() { return host.initResult; },
          set initResult(result: any) { host.initResult = result; },
          get authenticated() { return host.authenticated; },
          set authenticated(done: boolean) { host.authenticated = done; },
          idleTimer: null,
          closing: false,
          dead: false,
          get stderr() { return host.stderr; },
          current: null,
        };
        acp.inbound = {
          request: (msg) => {
            const current = session.current;
            if (!current) refuse(msg, send);
            else handleServerRequest(msg, current);
          },
          notification: handleNotification,
          busy: () => Boolean(session.current?.asks.size || session.current?.runningTools.size),
          error: (e) => {
            session.dead = true;
            const current = session.current;
            if (!current) return;
            emit({ ...base(threadId, current.turnId), type: "runtime.error", ...describeSpawnFailure(e, launch.command, cwd) });
            settle(threadId, session, false, "spawn_error");
          },
          exit: (code) => {
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
              // The identity check keeps an old child's exit from unlinking its replacement.
              sessions.delete(threadId);
            }
          },
        };
        return session;
      };

      const sendTurn = async (turn: SendTurnInput, retryOf?: string) => {
        requireRunning();
        if (startupModelRefresh) await startupModelRefresh;
        requireRunning();
        const parsedScope = parseToolScope(turn.toolScope);
        if (!parsedScope.ok) throw new Error(parsedScope.error);
        turn = { ...turn, toolScope: parsedScope.scope };
        if (narrowsNativeTools(turn.toolScope) && !support.toolScopeSessionParams) {
          throw new Error(`${support.displayName}: native tool selection is not supported by this engine. Keep native:* in the selection or choose a supported engine.`);
        }
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnConfig = turn.approvalMode === undefined
          ? config
          : { ...config, fullAuto: turn.approvalMode === "full" && supportsApprovalMode(DRIVER_KIND, "full") };
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && turnConfig.fullAuto && turn.approvalMode !== "full") {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = retryOf ?? newId();
        const cwd = turn.cwd ?? turnConfig.workspace ?? homedir();
        const env = childEnv(turnConfig);
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
        ) {
          const authenticated = await support.isAuthenticated(env, turnConfig, instanceId);
          requireRunning();
          if (!authenticated) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
            return { turnId };
          }
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env);
        const toolLimitKey = JSON.stringify([instanceId, resolvedModel ?? null]);
        const mcpServers = acpMcpServers(turn, { http: support.ownMcpOverHttp === true, engine: support.driverKind,
          toolBudget: mcpToolBudget(learnedToolCountLimit(toolLimitKey), support.engineTools ?? 32) });
        support.applyTurnEnv?.(env, {
          model: resolvedModel, requestedModel: turn.model, fullAuto: turnConfig.fullAuto === true, botId: turn.botId, cwd, toolScope: turn.toolScope,
          threadId, mcpServers,
        });
        let cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        let launch: { command: string; args?: string[]; env?: Record<string, string | undefined> };
        try {
          launch = support.resolveCommand
            ? await support.resolveCommand(env, turnConfig, instanceId)
            : { command: turnConfig.cli };
        } catch (error) {
          requireRunning();
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

        requireRunning();
        const spawnArgs = support.spawnArgs(turnConfig, cliTurn);
        const spawnEnv = launch.env ?? env;
      // The child env is part of the spawn contract, hashed so secrets never sit in the key.
        const envFingerprint = createHash("sha256").update(JSON.stringify(spawnEnv)).digest("hex").slice(0, 16);
        const inheritedScopeFingerprint = narrowsNativeTools(turn.toolScope) && support.toolScopeCacheKey
          ? createHash("sha256").update(support.toolScopeCacheKey({ config: turnConfig, env, cwd })).digest("hex") : null;
        const processContract = [launch.command, launch.args ?? [], spawnArgs,
          support.sessionScopedApproval ? null : turnConfig.fullAuto === true, envFingerprint,
          support.spawnFingerprint?.(spawnEnv, turnConfig) ?? null];
        const contractKey = JSON.stringify([...processContract, cwd, turn.toolScope ?? null, inheritedScopeFingerprint]);
        const launchModel = support.sessionModelEnv && cliTurn.model && /^[\w.:/-]{1,200}$/u.test(cliTurn.model)
          && accountModels?.has(cliTurn.model) ? cliTurn.model : undefined;
        const launchEnv = support.sessionModelEnv && launchModel
          ? { ...spawnEnv, [support.sessionModelEnv]: launchModel }
          : spawnEnv;
        let launchedThisTurn = false;
        // The folder and the tool selection ride session/new, so threads differing only there can share a process; never two audiences of a Team Cloud, whose engine homes differ.
        const hostKey = support.shareProcess && inheritedScopeFingerprint === null ? JSON.stringify([...processContract, launchModel ?? null, engineHomes.scope()]) : null;
        const launchSession = () => {
          const opened = openSession(threadId, launch, [...(launch.args ?? []), ...spawnArgs], launchEnv, cwd, contractKey, hostKey);
          opened.launchModel = launchModel;
          launchedThisTurn = true;
          return opened;
        };
        const sessionKey = JSON.stringify([mcpServers, turn.toolScope ?? null, inheritedScopeFingerprint]);

        if (turn.sessionReset) {
          closeSession(threadId, "reset");
          sessionAllows.delete(threadId);
        }
        const pooled = sessions.get(threadId);
        let session: AcpSession;
        if (pooled && !pooled.dead && !pooled.closing && pooled.contractKey === contractKey
            && (!support.restartOnMcpChange || pooled.sessionKey === sessionKey)) {
          if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
          pooled.idleTimer = null;
          session = pooled;
        } else {
          if (pooled) {
            if (pooled.dead) sessions.delete(threadId);
            else closeSession(threadId, "contract");
          }
          const joining = sharedHost(hostKey);
          await turn.engineAdmission?.(joining ? "session" : "process", joining?.child.pid);
          requireRunning();
          if (active.has(threadId)) throw new Error("a turn is already running on this thread");
          session = launchSession();
          sessions.set(threadId, session);
        }
      // `session` rebinds when the establishment retry respawns the child: never capture its connection.
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          receive?: (result: any) => void,
          idleMs?: number,
          idleMessage?: string | (() => string),
        ): Promise<any> =>
          session.acp.request(method, params, timeoutMs, receive, idleMs, idleMessage);

        const state: AcpTurn["state"] = { settled: false, promptSent: false, text: "", textMessageId: null, producedItem: false, startupActivity: false, stopped: false, usagePeak: null, usageLast: null, usageCompacted: false };
        let acknowledge = () => {};
        let rejectStartup = (_error: TurnNotStartedError) => {};
        const startupAck = turn.startupRecovery ? new Promise<{ turnId: string }>((resolve, reject) => {
          acknowledge = () => resolve({ turnId });
          rejectStartup = reject;
        }) : null;
        const asks = new Map<string, AcpAskFinish>();
        let reportedModel = turn.model;
        let variant = turn.variant;
        let staleProcess = false;
      // Still set if configuring throws: the pooled session may keep an earlier turn's looser mode.
        let approvalUnconfirmed = false;
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
            model: nativeModel === cliTurn.model ? (reportedModel ?? nativeModel) : nativeModel,
            variants: {
              options: option?.options ?? [],
              ...(option?.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
            },
          });
        };
        const requestedVariantOption = () => {
          if (!support.modelVariants) throw new Error(`${support.displayName} does not support model variants`);
          const option = acpVariantOption(session.sessionConfigResult);
          if (!option || !option.options.some((entry) => entry.id === variant)) {
            throw new Error(`${support.displayName} does not advertise variant ${variant} for this model`);
          }
          return option;
        };

        const flushAssistantText = () => {
          const raw = state.text;
          state.text = "";
          const text = stripLeakedSystemHarnessMessages(raw);
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
          acknowledge,
          asks,
          runningTools: new Set(),
          unkeyedToolIds: [],
          interruptTimer: null,
          stopQuietWatch: null,
          flushAssistantText,
          receiveModelVariants,
        };

        const interrupt = () => {
          state.stopped = true;
          if (session.sessionId) {
            session.acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } });
            if (current.interruptTimer) clearTimeout(current.interruptTimer);
            current.interruptTimer = setTimeout(() => {
              closeSession(threadId, "cancel-timeout");
              settle(threadId, session, true, "cancelled");
            }, 5_000);
            current.interruptTimer.unref?.();
          } else {
            closeSession(threadId, "stop");
          }
        };
        active.set(threadId, { stop: () => { state.stopped = true; closeSession(threadId, "stop"); }, interrupt, turnId, asks });
        if (retryOf === undefined) emit({ ...base(threadId, turnId), type: "turn.started" });
        session.current = current;

        (async () => {
          let pendingSplitReceipt: { key: string; receipt: PromptSplitReceipt; previous: PromptSplitReceipt | null } | null = null;
          try {
            const handshake = async (): Promise<boolean> => {
              for (const child of retiring.get(threadId) ?? []) {
                const stopped = await retireChild(threadId, child);
                if (state.settled || session.closing) throw new Error("session closed");
                if (!stopped) {
                  closeSession(threadId, "replace-failed");
                  throw new Error(`${support.displayName} could not close its previous tool session. Try again.`);
                }
              }
              if (state.settled || session.closing) throw new Error("session closed");
              if (!session.initResult) {
                session.initResult = await session.host.once("initialize", () => request(
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
                      ...(support.clientCapabilitiesMeta ? { _meta: support.clientCapabilitiesMeta } : {}),
                    },
                  },
                  INIT_TIMEOUT,
                ));
              }
              if (!skipSubscriptionAuthForLocalInject(turn.model) && !session.authenticated) {
                const methods: Array<{ id?: string }> = Array.isArray(session.initResult?.authMethods)
                  ? session.initResult.authMethods
                  : [];
                const methodId = support.pickAuthMethod(methods, spawnEnv);
                if (methodId) {
                  try {
                    await session.host.once("authenticate", () => request("authenticate", { methodId }, INIT_TIMEOUT));
                    session.authenticated = true;
                  } catch {
                    if (support.authFailure !== "continue") throw new Error(support.loginNote);
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
            let promptTurn = turn;
            let rebuiltFromReplay = false;
            for (;;) {
              const liveSessionId = session.sessionId;
              if (liveSessionId !== null && session.sessionKey === sessionKey && (cursor === null || cursor === liveSessionId)) {
                break;
              }
              const selectionParams = narrowsNativeTools(turn.toolScope)
                ? support.toolScopeSessionParams!(turn, init, mcpServers.length > 0, { config: turnConfig, env, cwd }) : {};
              let loaded = false;
              if (cursor) {
                try {
                  await request(
                    support.resumeMethod === "resume" ? "session/resume" : "session/load",
                    { sessionId: cursor, cwd, mcpServers, ...selectionParams },
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
                  // OpenCode encodes ACPSessionNotFoundError as invalidParams with just the rejected
                  // sessionId; other invalidParams (model/config errors) must not erase history.
                  const data = (error as any)?.data;
                  const missingSession = data && typeof data === "object" && !Array.isArray(data)
                    && data.sessionId === cursor && Object.keys(data).length === 1;
                  if (classification === "invalid_credentials" || classification === "inactive_subscription"
                      || ((error as any)?.code === -32602 && !missingSession)) throw error;
                }
              }
              if (loaded) break;
              if (cursor && liveSessionId === cursor) {
                session.current = null;
                closeSession(threadId, "reestablish");
                session = launchSession();
                sessions.set(threadId, session);
                session.current = current;
                runtimeAcceptsImages = await handshake();
                init = session.initResult;
                continue;
              }
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
              await request("session/new", { cwd, mcpServers, ...selectionParams }, NEW_SESSION_TIMEOUT, (result) => {
                session.sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
                session.sessionKey = sessionKey;
                receiveModelVariants(result);
              });
              break;
            }
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
                const wanted = cliTurn.model;
                const offered = offeredModels(session.sessionConfigResult, configId);
                if (support.sessionModelEnv && !session.launchModel && offered.length) accountModels = new Set(offered);
                // A pooled process missing a catalog model predates the catalog: fail and respawn, never run another (the catalog holds picker ids; `wanted` may be the resolved wire id, so check both).
                staleProcess = Boolean(support.fallbackModel && wanted && !launchedThisTurn && offered.length
                  && !offered.includes(wanted) && models.options.some((option) => option.id === wanted || option.id === turn.model));
                if (support.fallbackModel && offered.length && !skipSubscriptionAuthForLocalInject(turn.model)
                    && !staleProcess && (!wanted || !offered.includes(wanted))) {
                  const fallback = support.fallbackModel(session.sessionConfigResult, models.default);
                  if (fallback && fallback !== wanted && offered.includes(fallback)) {
                    const notice = wanted ? `${wanted}\n${fallback}` : null;
                    if (notice && session.fallbackNotice !== notice) {
                      session.fallbackNotice = notice;
                      emit({
                        ...base(threadId, turnId),
                        type: "runtime.notice",
                        message: `${support.displayName} no longer offers ${wanted}, so this conversation uses ${fallback}. ` +
                          "Choose another model for this bot to stop seeing this.",
                      });
                    }
                    cliTurn = { ...cliTurn, model: fallback };
                    current.turn = cliTurn;
                    reportedModel = fallback;
                    variant = undefined;
                  }
                }
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  await request(
                    "session/set_config_option",
                    { sessionId, configId, value: cliTurn.model },
                    INIT_TIMEOUT,
                    receiveModelVariants,
                  );
                  selectedModel = modelOf(session.sessionConfigResult);
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                approvalUnconfirmed = support.sessionScopedApproval === true;
                await support.configureSession({
                  request: async (method, params, timeoutMs) => {
                    const result = await request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT);
                    if (method === "session/set_model" && params && typeof params === "object" &&
                        "modelId" in params && typeof params.modelId === "string") {
                      session.sessionConfigResult = {
                        ...session.sessionConfigResult,
                        models: { ...session.sessionConfigResult?.models, currentModelId: params.modelId },
                      };
                    }
                    return result;
                  },
                  sessionId,
                  env: spawnEnv,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(session.sessionConfigResult?.models?.availableModels)
                    ? session.sessionConfigResult.models.availableModels
                    : [],
                  currentModelId: session.sessionConfigResult?.models?.currentModelId,
                  configOptions: Array.isArray(session.sessionConfigResult?.configOptions)
                    ? session.sessionConfigResult.configOptions
                    : [],
                  notice: (message) => {
                    if (session.fallbackNotice === message) return;
                    session.fallbackNotice = message;
                    emit({ ...base(threadId, turnId), type: "runtime.notice", message });
                  },
                });
                approvalUnconfirmed = false;
                // initialize's currentModelId is the CLI default, not this turn's model.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
              if (variant !== undefined) {
                const option = requestedVariantOption();
                await request(
                  "session/set_config_option",
                  { sessionId, configId: option.configId, value: variant },
                  SESSION_CONFIG_TIMEOUT,
                  receiveModelVariants,
                );
                if (requestedVariantOption().currentValue !== variant) {
                  throw new Error(`${support.displayName} did not apply variant ${variant}`);
                }
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            const halves = promptHalves(turn);
            let promptInput = promptTurn;
            if (halves.stable !== null) {
              const receiptKey = JSON.stringify([threadId, sessionId]);
              const previousReceipt = readPromptSplitReceipt(DRIVER_KIND, receiptKey);
              state.usagePeak = previousReceipt?.peakUsed ?? previousReceipt?.lastUsed ?? null;
              const composed = splitSessionPrompt(
                halves.stable,
                halves.volatile,
                previousReceipt,
                promptTurn.system,
                promptTurn.text,
                Boolean(turn.mentionTurn),
                ACP_PROMPT_RE_ANCHOR_TURNS,
              );
              promptInput = { ...promptTurn, system: "", text: composed.text };
              pendingSplitReceipt = { key: receiptKey, receipt: composed.receipt, previous: previousReceipt };
            }
            const text = support.buildPromptText
              ? support.buildPromptText(promptInput)
              : promptInput.system
                ? `${promptInput.system}\n\n${promptInput.text}`
                : promptInput.text;
            const imageBlocks = support.images === true && runtimeAcceptsImages
              ? await readAcpImageBlocks(turn.images ?? [])
              : [];
            if (support.modelVariants && cliTurn.model && modelOf(session.sessionConfigResult) !== cliTurn.model) {
              throw new Error(`${support.displayName} changed model before the prompt`);
            }
            if (variant !== undefined && requestedVariantOption().currentValue !== variant) {
              throw new Error(`${support.displayName} changed variant before the prompt`);
            }
            if (state.settled || state.stopped || session.closing) throw new Error("turn stopped");
            state.promptSent = true;
            acknowledge();
            const promptIdleMs = promptIdleTimeoutMs();
            const quiet = startQuietWatch(threadId, session, current);
            const result = await request(
              "session/prompt",
              { sessionId, prompt: [{ type: "text", text }, ...imageBlocks] },
              undefined,
              undefined,
              promptIdleMs,
              () => {
                const last = quiet.lastState();
                return `${DRIVER_KIND} sent nothing for ${formatQuietLimit(promptIdleMs)} with no tool running, so the turn was stopped as stuck` +
                  `${last ? ` (last seen: ${lastSeenPhrase(last)})` : ""}. ` +
                  "Send the message again to retry. On a self-hosted server, OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS sets this limit (0 turns it off).";
              },
              );
            if (pendingSplitReceipt) {
              // session/prompt resolving is the acceptance boundary: a rejected prompt leaves no receipt.
              if (state.usageCompacted) {
                deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
              } else {
                const previousLastUsed = typeof pendingSplitReceipt.previous?.lastUsed === "number"
                  ? pendingSplitReceipt.previous.lastUsed
                  : undefined;
                const lastUsed = state.usageLast ?? previousLastUsed;
                writePromptSplitReceipt(
                  DRIVER_KIND,
                  pendingSplitReceipt.key,
                  {
                    ...pendingSplitReceipt.receipt,
                    ...(lastUsed === undefined ? {} : { lastUsed }),
                    ...(state.usagePeak === null ? {} : { peakUsed: state.usagePeak }),
                  },
                );
              }
            }
            // opencode 1.18.18 reports usage at the result root; grok and gemini under _meta.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              // opencode 1.18.25 keeps only the uncached share in inputTokens and reports cache reads
              // beside it (omitted when 0); other agents count them inside. Absent is not zero.
              const input = usage.inputTokens ?? 0;
              const output = usage.outputTokens ?? 0;
              const cachedRead = typeof usage.cachedReadTokens === "number" && usage.cachedReadTokens > 0
                ? usage.cachedReadTokens
                : null;
              const exclusive = cachedRead !== null
                && (typeof usage.totalTokens !== "number"
                  || usage.totalTokens >= input + output + cachedRead);
              const normalizedInput = cachedRead !== null && exclusive ? input + cachedRead : input;
              if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
                && typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
                && Number.isFinite(normalizedInput)) {
                state.turnUsage = { input: normalizedInput, output,
                  ...(cachedRead !== null ? { cachedInput: exclusive ? cachedRead : Math.min(cachedRead, input) }
                    : usage.cachedReadTokens === 0 ? { cachedInput: 0 } : {}) };
              }
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: normalizedInput,
                output,
                ...(cachedRead !== null
                  ? { cachedInput: exclusive ? cachedRead : Math.min(cachedRead, input) }
                  : {}),
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
                message: engineFailureMessage(support.displayName, errorMessage) ?? errorMessage,
              });
              settle(threadId, session, false, reason ?? "failed");
            }
          } catch (e) {
            if (pendingSplitReceipt && state.promptSent && state.usageCompacted) {
              deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
            }
            if (!state.settled) {
              const untouched = retryOf === undefined && !state.producedItem && !state.text && !current.runningTools.size && !asks.size && !state.stopped && !session.closing;
              if (untouched && retryUnderToolLimit(e, { key: toolLimitKey, model: resolvedModel, engine: DRIVER_KIND, retry: () => {
                state.settled = true; session.current = null; active.delete(threadId); current.stopQuietWatch?.();
                return sendTurn({ ...turn, startupRecovery: undefined, sessionReset: undefined, resumeCursor: session.sessionId ?? turn.resumeCursor }, turnId);
              }, failed: (error) => { emit({ ...base(threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "rpc_error", cost: null }); } })) return;
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e) ?? (engineFailureKind(message) === "credits" ? "insufficient_funds" : undefined);
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || code === "insufficient_funds" || message === support.loginNote;
              const accountError = isAccountError(code);
              const failure = classifyError({ text: message });
              const transientStartup = failure.transient || (failure.reason === "unknown" && code === "upstream_outage");
              const denied = /\b(?:(?:permission|access) denied|(?:approval|permission) (?:required|denied|rejected)|requires? (?:approval|permission)|policy (?:restriction|violation)|(?:blocked|denied|restricted) by (?:the )?policy)\b/i.test(message);
              const retryableStartup = approvalUnconfirmed || (transientStartup && (!code || code === "upstream_outage")
                && ![-32700, -32600, -32601, -32602].includes((e as any)?.code));
              if (turn.startupRecovery && retryableStartup && !needsAuth && !accountError && !denied
                  && !state.promptSent && !state.startupActivity && !state.producedItem && !state.text
                  && !state.stopped && !session.closing && !asks.size && !current.runningTools.size) {
                // Quiesce first: the close must not publish a completion before the harness recovers.
                state.settled = true;
                session.current = null;
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                closeSession(threadId, "startup-recovery");
                const stopped = session.host.links.size > 0 || await killCliTree(session.child).catch(() => false);
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                active.delete(threadId);
                if (stopped && !state.stopped) {
                  rejectStartup(new TurnNotStartedError(turnId, message));
                  return;
                }
                acknowledge();
                if (!state.stopped) emit({ ...base(threadId, turnId), type: "runtime.error", message: engineFailureMessage(support.displayName, message) ?? message });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: state.stopped,
                  stopReason: state.stopped ? "cancelled" : "rpc_error", cost: null });
                return;
              }
              emit({
                ...base(threadId, turnId), type: "runtime.error",
                message: (accountError ? support.describeAccountError?.(code, cliTurn.model) : undefined) ?? engineFailureMessage(support.displayName, message) ?? message,
                ...(needsAuth ? { setup: true } : {}), ...((e as any)?.acpPromptStall === true ? { stalled: true } : {}),
              });
              // Never replay an accepted prompt (it may have run tools); evict before listeners start the next turn.
              if (!needsAuth && !accountError && ((e as any)?.acpPromptStall === true || (e as any)?.acpSessionFailure === true
                  || code === "upstream_outage") && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, (e as any)?.acpPromptStall === true ? "prompt-stall" : "rpc-failure");
              } else if (approvalUnconfirmed && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "approval-unconfirmed");
              } else if (staleProcess && !state.promptSent && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "stale-models");
              }
              settle(threadId, session, false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return startupAck ?? { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        if (support.snapshot) return support.snapshot(env, config, instanceId);
        const probe = await new Promise<{ version?: string; reason?: string }>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout, stderr) => {
            if (err) {
              const failure = err as NodeJS.ErrnoException & { killed?: boolean };
              const reason = failure.code === "ENOENT"
                ? `\`${config.cli}\` isn't installed, or isn't on this app's PATH. Install it for the user running OpenMausBot or use Set CLI, then check again.`
                : failure.code === "EACCES" || failure.code === "EPERM"
                  ? `\`${config.cli}\` isn't executable. Check its file permissions, then check again.`
                  : failure.killed && failure.code == null
                    ? `\`${config.cli}\` version check timed out after 8 seconds. Check it in a terminal on the server, then try again.`
                    : `\`${config.cli}\` version check failed. Run it with --version on the server to diagnose the installation, then check again.`;
              // Do not echo arbitrary CLI output or its environment into Settings.
              resolve({ reason });
              return;
            }
            const version = versionFromProbe(stdout, stderr);
            resolve(version ? { version } : { reason: `\`${config.cli}\` returned no version. Check the configured executable with --version, then try again.` });
          });
        });
        if (!probe.version) return { state: "unavailable", reason: probe.reason };
        return { state: "available", version: probe.version, authenticated: await support.isAuthenticated(env, config, instanceId) };
      };

    /** Memory upkeep's one-shot: a fresh process and session, no MCP servers, an empty folder, and
     * every tool, file or permission request refused. */
      const generateMemoryText = async (prompt: string, options: TextGenerationOptions = {}): Promise<string> => {
        if (startupModelRefresh) await startupModelRefresh;
        const turnConfig: AcpConfig = { ...config, fullAuto: false };
        const env = childEnv(turnConfig);
        if (support.requireAuthenticationBeforeSpawn && !(await support.isAuthenticated(env, turnConfig, instanceId))) {
          throw new Error(support.loginNote);
        }
        const cwd = mkdtempSync(join(tmpdir(), "omb-acp-memory-"));
        try {
          const turn = { threadId: `memory-text-${newId()}`, text: prompt, approvalMode: "ask", cwd } as SendTurnInput;
          support.applyTurnEnv?.(env, { fullAuto: false, cwd, threadId: turn.threadId, mcpServers: [] });
          const launch = support.resolveCommand ? await support.resolveCommand(env, turnConfig, instanceId) : { command: turnConfig.cli };
          const spawnEnv = launch.env ?? env;
          return await runAcpOneShot({
            displayName: support.displayName,
            spawn: spawnCli,
            kill: killCliTree,
            command: launch.command,
            argv: [...(launch.args ?? []), ...support.spawnArgs(turnConfig, turn)],
            env: spawnEnv,
            cwd,
            prompt,
            defaultModel: models.default,
            pickAuthMethod: (methods) => support.pickAuthMethod(methods, spawnEnv),
            authRequired: support.authFailure === "fail-request" ? "if-requested" : support.authFailure === "fail",
            loginNote: support.loginNote,
            clientCapabilitiesMeta: support.clientCapabilitiesMeta,
            ...(support.configureSession ? {
              configure: ({ request, sessionId, session }) => support.configureSession!({
                request,
                sessionId,
                env: spawnEnv,
                config: turnConfig,
                turn,
                sessionModels: Array.isArray(session?.models?.availableModels) ? session.models.availableModels : [],
                currentModelId: session?.models?.currentModelId,
                configOptions: Array.isArray(session?.configOptions) ? session.configOptions : [],
                notice: () => undefined,
              }),
            } : {}),
            options,
          });
        } finally {
          // On Windows the engine can hold the folder a moment after exit.
          try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
        }
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        ...(support.backgroundText === false ? {} : { generateMemoryText }),
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        ...(startupModelRefresh ? { startupModelRefresh } : {}),
        ...(deviceSignIn ? {
          startAuthentication: () => deviceSignIn.start(),
          getAuthentication: (flowId: string) => deviceSignIn.get(flowId),
          cancelAuthentication: () => deviceSignIn.cancel(),
        } : {}),
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
            dataMcp: true, highlevelMcp: true,
            images: support.images !== false,
            nativeImageInput: support.images === true,
            effortLevels: support.effortLevels,
            modelVariants: support.modelVariants === true,
            localComputerMcp: true,
            contextReading: "meter",
            engineAdmission: true,
          },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable";
            return finish(decision.behavior, "user", decision.message, decision.always === true);
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
            for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "stopAll");
            for (const [threadId, children] of retiring) {
              for (const child of children) void retireChild(threadId, child);
            }
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          disposing = true;
          await deviceSignIn?.dispose();
          const disposingSessions = Array.from(sessions);
          for (const { stop } of active.values()) stop();
          for (const [threadId, session] of disposingSessions) {
            closeSession(threadId, "dispose");
            settle(threadId, session, true, "cancelled");
          }
          for (const [threadId, children] of retiring) {
            for (const child of children) void retireChild(threadId, child);
          }
          listeners.clear();
        },
      };
    },
  };
}

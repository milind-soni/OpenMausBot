import { type ServerText } from "../../../shared/server-text.ts";
// The shared ACP (JSON-RPC 2.0 over stdio) driver; per-CLI quirks live in an AcpSupport.
// ACP has no turn/completed: the session/prompt result (stopReason + usage) is the completion.
// session/load replays history as ordinary session/update notifications, so nothing emits before
// the prompt is sent and `_meta.isReplay` updates are dropped. Permissions fail closed: only an
// `allow`-kind option approves, and option order is never a security contract.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { answerClientFileRequest } from "./client-file-request.ts"; import { loadUntilReplayQuiet } from "./load-replay.ts";
import { createHash } from "node:crypto";

import { PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { openStartupModelCatalog } from "../../startup-model-catalog.ts";
import { acpModelCatalog } from "./model-catalog.ts";
import { acpDiscoveryProblem } from "./custom-model-catalog.ts";
import { decodeInjectId } from "../local-inject.ts";
import { DeviceAuthController, deviceAuthInstanceSurface, type DeviceSignIn } from "../device-auth.ts";
import { AcpBrowserAuth, acpBrowserAuthInstanceSurface, type AcpBrowserSignInSpec } from "./browser-auth.ts";
import { commitPromptSplitReceipt, deletePromptSplitReceipt, type PendingPromptSplitReceipt } from "../prompt-split.ts";
import { liveSessionKey, sessionSystem, turnPrompt } from "./session-system.ts";
import { boxAudienceKey, describeSpawnFailure, killCliTree, sharedBoxScope, spawnCli } from "../../procs.ts"; import { execCliProbe } from "../../cli-probe-cache.ts"; import { stopEngineTree, stopEngineTrees } from "../../engine-stop.ts";
import { applyOneShotEnv, oneShotTurnModel, runAcpOneShot } from "./background-text.ts"; import type { AcpBackgroundWork } from "./background-work.ts";
import { acpCapabilities } from "./capabilities.ts"; import { ACP_MEDIA_MAX_BYTES, readAcpMediaLinks } from "./media-links.ts";
import { acpNativeLogMessage } from "./tool-log.ts";
import { stripLeakedSystemHarnessMessages } from "../../../shared/system-message-guard.ts";
import { formatQuietLimit, lastSeenPhrase, LIMIT_WORDS, promptIdleTimeoutMs, type LogSignal } from "./quiet-status.ts"; import { startAcpQuietWatch } from "./quiet-watch.ts"; import { AppliedConfig } from "./applied-config.ts"; import { modelRefused, roomForReadBeside, startupRefresh } from "./startup-refresh.ts"; import { stderrFailureOf, watchStderrFailure, type StderrFailure } from "./harness-failure.ts"; import { timed, turnStartClock, type TurnStartClock } from "../../perf/turn-starts.ts";
import { acpMissingSession, retryTransient } from "./rpc-error.ts"; import { busyOf, inconclusiveMark } from "../../harness/probe-hold.ts"; import { sessionNewRetried } from "./busy-start.ts";
import { readSessionReport } from "./session-reports.ts";
import { promptTokenUsage } from "./prompt-usage.ts";
import { advertisedCommands, turnAnswers, turnSteering, type AcpSteerSupport } from "./steer.ts";
import { pickSessionModel, SessionModelControls, type AcpModelSelection } from "./session-model-controls.ts"; import { currentModeUpdateId, readSessionModes, withSessionMode, type AcpSessionModes } from "./session-modes.ts";
import { notThisCli, versionFromProbe } from "./version-probe.ts"; import { engineHomes } from "../../engine-homes/engine-homes.ts"; import { apiKeyAccount } from "./api-key-account.ts";

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
import { acpAnswersAlone, acpSessionOperationKey, acpShellRequest, permissionLaunchCwd } from "../permission-command.ts"; import { acpReadPaths } from "../../own-file-reads.ts";
import { openQuestionRequest, questionRequestFor, type AcpQuestionRequest } from "./question-requests.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { acpToolEndEvents } from "./tool-items.ts";
import { AcpHost } from "./host.ts"; import { LiveSwitchRefused, SignInRequests, type AcpDriverHooks } from "./driver-hooks.ts";
import { exitBeforeResult } from "./exit-report.ts"; import { readNodeVersion } from "./node-version.ts";
import { decodeAcpConfig } from "./config-decode.ts";
import { endTurn, receiveText, trackAssistantImage, trackAssistantWords, trackThoughtAfterTool, trackRunningTool, trackToolEndShown, type AcpAskFinish, type AcpSession, type AcpTurn } from "./turn-state.ts";
import { recoveryPromptFor } from "../../resume-recovery.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { armIdleClose, engineIdleMs, sessionIdlePolicy, stopIdleClose, type ColdStartCost } from "../session-idle.ts";
import { startupFailureRecoverable } from "./startup-recovery.ts";
import { engineFailure, engineFailureKind } from "../engine-errors.ts";
import { acpRuntimeFailure, acpStopFailure } from "./failure-words.ts";
import { narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope.ts";
import { acpMcpServers, type AcpMcpServer } from "../turn-mcp.ts"; import { acpOwnMcpTransport, acpSessionMcpServers, loopbackUnproxied } from "../own-mcp-http.ts"; import { acpToolOutput, acpToolProgress } from "../tool-progress.ts";
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
  cli: string; fullAuto: boolean; workspace?: string;
  /** Custom ACP only: the agent advertises a `steer` command and answers `/steer <text>` during a turn as Hermes does. */ steer?: boolean;
}

/** Per-CLI specifics plugged into the shared ACP runtime; `askTool` is the native tool `questionRequests` come from. */
export interface AcpSupport extends AcpDriverHooks {
  questionRequests?: Readonly<Record<string, AcpQuestionRequest>>; askTool?: string;
  /** Verified native catalog parameters, applied before both new and restored sessions. */
  toolScopeSessionParams?(turn: SendTurnInput, initializeResult: unknown, hasMcp: boolean,
    context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): Record<string, unknown>;
  /** Existing native restrictions also participate in scoped session reuse. */
  toolScopeCacheKey?(context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): string;
  driverKind: string;
  displayName: string; /** What this CLI's own `--version` looks like: any other answer is another program behind the CLI path. */ cliVersion?: RegExp;
  /** The oldest Node.js the CLI runs on: an exit before its reply on an older one names both versions. */ minNodeVersion?: string;
  /** Omit for subscription CLIs. Custom-only CLIs have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: ModelCatalog;
  /** Effort levels the CLI accepts, ascending; omit when it has none. Static because describe()
   * runs before any session exists. */
  effortLevels?: readonly EffortLevel[];
  /** Discover and select opaque model variants through ACP config options. */
  modelVariants?: boolean;
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog; a failed lookup keeps the last usable one. `config` lets a support ask the binary it will
   *  spawn, not whatever is on PATH; `fresh` is the person's Refresh; `allowEnv`, the instance's own keys for the bot box. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string, fresh?: boolean, allowEnv?: readonly string[],
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
  /** Sign-ins from the app, run with the turns' binary and environment: the CLI's own device-code login (`grok login
   * --device-auth`, confirmed by isAuthenticated), or its ACP `authenticate` with the engine opening the browser (browser-auth.ts). */
  deviceSignIn?: DeviceSignIn; browserSignIn?: AcpBrowserSignInSpec;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv (opencode's ACP subcommand
   *  takes no -m). The agent must confirm it before the prompt. */
  selectModel?: AcpModelSelection;
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
  /** False when this engine cannot run memory upkeep's one-shot text call cleanly; oneShotFolder holds a one-shot's folder. */
  backgroundText?: false; oneShotFolder?(): Promise<string>; oneShotModel?(model: string, env: Record<string, string | undefined>, models: ModelCatalog): string | undefined; /** Work the agent goes on with after its turn: ended at Stop and when it wakes a turn between ours. */ backgroundWork?: AcpBackgroundWork;
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
  ): Promise<{ command: string; args?: string[]; env?: Record<string, string | undefined>; ro?: readonly string[] }>;
  /** Snapshot override for agents whose binary has no conventional --version. */
  snapshot?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<ProviderSnapshot>;
  /** A cold start of this engine takes tens of seconds: where memory allows, its idle process is kept longer (session-idle.ts). */
  coldStartCost?: ColdStartCost;
  /** A turn the saved model list serves goes ahead while the startup read runs (startup-refresh.ts). */
  modelListStandsIn?: boolean;
  /** Lines on the agent's stderr after which its process cannot run a turn (harness-failure.ts). */
  stderrFailure?: StderrFailure;
  /** How long session/new and session/resume (or load) may go unanswered on a live process; initialize keeps its own limit. */
  sessionSetupTimeoutMs?: number;
  /** Google Antigravity resumes through session/resume, not session/load. */
  resumeMethod?: "load" | "resume";
  /** Some agents acknowledge a live load without applying new MCP credentials. */
  restartOnMcpChange?: boolean; /** The turn's MCP servers come from launcher-owned configuration, not ACP session parameters. */ mcpServersFromLaunch?: boolean;
  /** How the agent takes a person's message into its running turn; without it a message sent mid-turn waits for the next. */
  steer?: AcpSteerSupport;
  /** hermes-agent 0.22.4 re-sends a streamed reply whole under its messageId, as its `💭` reasoning block, a blank line,
   * then the reply; that chunk is dropped instead of appended. */
  resendsReasoningReply?: boolean;
  /** Threads with the same spawn contract run their sessions in one process (OpenCode 1.19: about 100 MB a session
   * instead of about 450 MB a process), up to SHARED_SESSIONS_MAX. */
  shareProcess?: boolean; /** mistral-vibe 3.1.2 loads its live session as a second open copy, and both stream every reply. */ closeBeforeLiveLoad?: boolean;
  /** Route workspace file access through ACP so edits retain approval cards. */
  clientFileSystem?: boolean;
  /** Additional server-owned directories this turn may read; writes remain confined to cwd. */
  clientReadRoots?(turn: SendTurnInput): readonly string[];
  /** Sent as `clientCapabilities._meta` on initialize, where agents read vendor capabilities. */
  clientCapabilitiesMeta?: Record<string, unknown>;
  /** Made once per process: rewrites a session/update before the turn reads it, or drops it by returning null; `calls` is this session's tool-call record, shared with permissionRequest. */
  updateFilter?(calls: Map<string, Record<string, any>>): (update: Record<string, any>) => Record<string, any> | null; /** Rewrites a session/request_permission's params (its options and tool call) before the card is built, with the tool calls this session's filter recorded. */ permissionRequest?(params: Record<string, any>, calls: ReadonlyMap<string, Record<string, any>>): Record<string, any>;
  /** OpenMausBot's own MCP servers as this server's endpoints, no process each: always, or in each session whose agent's `initialize` says it reaches MCP servers by URL. */
  ownMcpOverHttp?: boolean | "advertised"; /** Under `ownMcpOverHttp: "advertised"`, whether an agent whose `initialize` advertises no MCP transport reaches MCP servers by URL anyway. */ takesUnadvertisedHttpMcp?(init: unknown): boolean; /** The agent's budget in bytes for all of a session's MCP tool definitions, by its `initialize` answer: OpenMausBot's own servers share it out. */ sessionToolBudget?(init: unknown): number | undefined;
  /** How many tools the agent lists of its own beside the MCP servers', counted against a provider's tool limit. */
  engineTools?: number;
  /** The agent's own debug log, read while a prompt is quiet: a new line proves it alive and `parse`
   * picks what to tell the person. Null when this process keeps none. A `shared` log holds every session's
   * and process's lines, so its lines prove nothing about this turn and only `parse` reads them. */
  statusLog?: {
    path(env: Record<string, string | undefined>, sessionId: string): string | null;
    parse(line: string, sessionId: string): LogSignal | null;
    shared?: true;
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
    instanceId: string, allowEnv?: readonly string[],
  ): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** A session/prompt error saying the agent never reached its model; startup recovery then holds the ACK for it. */
  promptUnreachedModel?(error: unknown): boolean;
  /** How far a usage limit the engine reports reaches: its whole account, or one allowance its models share (OpenCode's free models), with the models that allowance holds. */ limitFacts?(text: string, model?: string): { limit: "engine" | "model"; limitModels?: string[] };
  /** Plain words for an account failure (bad key, no credit, a used-up
   * quota, no subscription) in place of the provider's raw RPC text. */
  describeAccountError?(code: AccountErrorCode, model?: string): string;
  accountErrorText?(code: AccountErrorCode): ServerText | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn and session/select. */
  resolveTurnModel?(model: string | undefined, env: Record<string, string | undefined>, catalog: ModelCatalog): string | undefined;
  /** Map a saved selection onto the live session's catalog (a retired model id), once session/new or load answers. */
  normalizeSessionSelection?(turn: SendTurnInput, offeredModels: readonly string[], catalog: ModelCatalog): SendTurnInput;
  /** Per-session settings between session/new (or load) and the first prompt. Some CLIs ignore argv
   * and take the model/mode over the wire (droid); a throw fails the turn rather than run another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string; instanceId: string;
    env: Record<string, string | undefined>;
    config: AcpConfig;
    turn: SendTurnInput;
    /** The session's advertised models, verbatim: some CLIs name ACP model ids differently from
     * their argv slugs (Cursor answers `default[]` for the CLI's `auto`). */
    sessionModels: Array<{ modelId?: string; name?: string }>;
    /** Last model acknowledged by session/new/load/set_model, preserved for pooled turns. */
    currentModelId?: string; sessionModes?: AcpSessionModes; expectMode?: (modeId: string) => void;
    /** The session's effort, and where a live change to it is recorded. */ currentEffort?: EffortLevel; effortApplied?(effort: EffortLevel | undefined): void;
    /** What this live session last confirmed per config option; absent for a one-shot session. */ applied?: AppliedConfig;
    /** session/new's or session/load's `configOptions`, verbatim. */
    configOptions: Array<{ id?: unknown; currentValue?: unknown }>;
    /** Tell the person the session runs another model than the one picked. */
    notice: (message: string) => void;
  }): Promise<void>;
}

const envOr = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);
const INIT_TIMEOUT = 300_000;
const SESSION_CONFIG_TIMEOUT = 300_000;
const STEER_REQUEST_TIMEOUT_MS = 15_000;
const NEW_SESSION_TIMEOUT = 300_000;
const LOAD_SESSION_TIMEOUT = 120_000;
const ACP_STUCK_AFTER_MS = 180_000;
const SHARED_SESSIONS_MAX = 6, SHARED_SESSIONS_LIFETIME = 12;
/** Closing a session for these leaves its process fit for other threads' sessions; any other reason retires it. */
const HEALTHY_CLOSE = new Set(["idle", "reset", "contract", "stop", "stopAll", "dispose", "approval-unconfirmed"]);
/** ACP agents may compact their history silently; re-send the full prompt after this many bare turns. */
const ACP_PROMPT_RE_ANCHOR_TURNS = 8;
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

async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
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
      access: support.access ?? "subscription", ...(support.cliVersion ? { cliVersion: support.cliVersion } : {}),
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
      const catalog = acpModelCatalog({
        instanceId,
        fixed: support.models,
        startFromSaved: Boolean(support.resolveModels) && support.resolveModelsOnCreate === false,
        resolve: support.resolveModels && ((fresh) => { const env = childEnv(); return support.resolveModels!(env, config, instanceId, fresh, instanceEnvNames(input.environment, env)); }),
        explain: (error) => acpDiscoveryProblem(error, support.classifyError) });
      const refreshModels = (fresh?: boolean) => catalog.refresh(fresh);
      let startupModelRefresh: Promise<void> | null = null, startupSaved = false;
      if (support.resolveModels && support.resolveModelsOnCreate !== false) {
        startupModelRefresh = (await openStartupModelCatalog({
          instanceId,
          use: (saved) => { catalog.models = saved; startupSaved = true; },
          current: () => catalog.models,
          refresh: refreshModels,
        }))?.pending ?? null;
      } else if (support.resolveModelsOnCreate !== false) {
        await refreshModels();
      }
      const startup = startupRefresh({ enabled: support.modelListStandsIn === true, room: roomForReadBeside, pending: startupModelRefresh, saved: () => startupSaved, catalog: () => catalog.models, normalize: support.normalizeSessionSelection });
      const deviceSignIn = support.deviceSignIn ? new DeviceAuthController(support.deviceSignIn, { cli: config.cli, environment: () => childEnv(), onAuthenticated: refreshModels }) : null;
      const browserSignIn = support.browserSignIn ? new AcpBrowserAuth(support.browserSignIn, { cli: config.cli, engine: DRIVER_KIND, environment: () => childEnv(), onAuthenticated: refreshModels }) : null;
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
      // Other agents get 5 s to leave on their own after EOF, as before, then their tree is stopped; no turn waits for them,
      // dispose does.
      const leaving = new Set<ReturnType<typeof spawnCli>>();
      const retireChild = async (threadId: string, child: ReturnType<typeof spawnCli>): Promise<boolean> => {
        let children = retiring.get(threadId);
        if (!children) retiring.set(threadId, children = new Set());
        children.add(child);
        const stopped = await stopEngineTree(child, 0, 5_000);
        if (stopped) {
          children.delete(child);
          if (!children.size && retiring.get(threadId) === children) retiring.delete(threadId);
        }
        return stopped;
      };
      const sessionIdle = sessionIdlePolicy("ACP", process.env, undefined, support.coldStartCost);

      const backgroundEnds = new Map<string, Promise<void>>(), endBackground = (threadId: string, session: AcpSession) => support.backgroundWork && !backgroundEnds.has(threadId) && session.child.exitCode === null
        && backgroundEnds.set(threadId, support.backgroundWork.end(session, (m, p, t) => session.host.request(null, m, p, t)).then(async (ended) => { if (ended === false) await endUncancelled(threadId, session); }).finally(() => backgroundEnds.delete(threadId)));
      const closeSession = (threadId: string, why: string) => {
        const session = sessions.get(threadId);
        if (!session || session.closing) return;
        session.closing = true;
        stopIdleClose(`${instanceId}\0${threadId}`, session.idleTimer);
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { close: why } });
        sessions.delete(threadId);
        const { host, sessionId } = session;
        if (!HEALTHY_CLOSE.has(why)) host.draining = true;
        session.acp.close();
        if (host.links.size) {
          host.retired += 1;
          recycleWhenIdle(host);
          if (sessionId && host.initResult?.agentCapabilities?.sessionCapabilities?.close) {
            session.closeConfirmed = host.request(null, "session/close", { sessionId }, why === "cancel-timeout" ? 5_000 : 30_000).then(() => true, () => false);
          }
          return;
        }
        host.draining = true;
        // EOF is no guaranteed exit: Qwen is tracked before another turn can resume its history.
        if (support.restartOnMcpChange) void retireChild(threadId, session.child);
        else void (leaving.add(session.child), stopEngineTree(session.child, 5_000, 5_000).then((stopped) => stopped && leaving.delete(session.child)));
      };
      // A session that ignores session/cancel goes on working, and EOF on stdin does not stop it either. Only a confirmed
      // session/close or the end of its process stops it, and ending a shared process ends the other sessions' turns too.
      const endUncancelled = async (threadId: string, session: AcpSession): Promise<boolean> => {
        const { host } = session;
        closeSession(threadId, "cancel-timeout");
        if (host.links.size && await session.closeConfirmed) return true;
        for (const link of host.links) {
          const other = sessions.get(link.threadId);
          if (other?.host !== host) continue;
          const running = other.current;
          closeSession(link.threadId, "cancel-timeout");
          if (running) {
            emit({ ...base(link.threadId, running.turnId), type: "runtime.error", ...noticeFailure("chat.notice.acpRestarted", { provider: support.displayName }) });
            settle(link.threadId, other, false, "exit_before_result");
          }
        }
        if (await killCliTree(host.child)) return true;
        if (session.current) emit({ ...base(threadId, session.current.turnId), type: "runtime.error",
          ...noticeFailure("chat.notice.acpStopFailed", { provider: support.displayName }) });
        return false;
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
        }, envOr("OMB_ACP_SHARED_RECYCLE_MS", 60_000)); // shared: a process several conversations used, recycled once none is left
        host.recycle.unref?.();
      };
      const armIdle = (threadId: string) => {
        const session = sessions.get(threadId);
        if (!session) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = armIdleClose(`${instanceId}\0${threadId}`, engineIdleMs(threadId, sessionIdle), { close: () => closeSession(threadId, "idle"), threadId, policy: sessionIdle, // per-chat
          idle: () => sessions.get(threadId) === session && !session.closing && !session.current });
      };
    // Session allows the driver keeps when the agent offered no `allow_always`: exact operations per
    // thread, for the native session's life. A generic title with no input is never remembered.
      const sessionAllows = new Map<string, Set<string>>();
      /** Native sessions whose saved history the agent can no longer send (a reported `acpSessionBroken`): never resumed. */
      const brokenSessions = new Set<string>();

      /** Each turn's start timings, by turn id, until its turn.completed writes the line (perf/turn-starts.ts). */
      const clocks = new Map<string, TurnStartClock>();
      const finishClock = (turnId: string | undefined, outcome: string) => { const clock = turnId ? clocks.get(turnId) : undefined; if (clock) { clocks.delete(turnId!); clock.finish(outcome, Date.now()); } };
      const emit = (event: RuntimeEvent) => {
        if (event.type === "turn.completed") finishClock(event.turnId, event.stopReason ?? (event.ok ? "end_turn" : "failed"));
        for (const listener of listeners) listener(event);
      };

      const nativeLogMessage = (msg: any): unknown => acpNativeLogMessage(msg, support.sanitizeToolPayload === true);
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const startQuietWatch = (threadId: string, session: AcpSession, current: AcpTurn) => startAcpQuietWatch({ support, session, current, stuckAfterMs: ACP_STUCK_AFTER_MS,
        notice: (message, text) => emit({ ...base(threadId, current.turnId), type: "runtime.notice", message, text }) });

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
        session.current = null; session.settledAt = Date.now();
        active.delete(threadId); if (current.state.stopped) endBackground(threadId, session);
        const end = endTurn(current, ok, stopReason, support.displayName);
        if (end.error) emit({ ...base(threadId, current.turnId), type: "runtime.error", ...end.error });
        emit({ ...base(threadId, current.turnId), type: "turn.completed", ok: end.ok, stopReason: end.stopReason, cost: null, ...(end.stopReason === "auth_required" && !current.state.promptSent ? { unsent: true as const } : {}) });
        if (session.child.exitCode === null && !session.closing && !session.dead) {
          armIdle(threadId);
          recycleWhenIdle(session.host);
        } else if (session.dead && sessions.get(threadId) === session) {
          sessions.delete(threadId);
        }
      };

      const hosts = new Set<AcpHost>(), signIn = new SignInRequests(support, instanceId);
      // Between turns nothing is brokered; the agent must never block on an unanswered request.
      const refuse = (msg: any, send: (obj: unknown) => void) => {
        const question = questionRequestFor(support.questionRequests, msg.method);
        send(msg.method === "session/request_permission"
          ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
          : question
            ? { jsonrpc: "2.0", id: msg.id, result: question.cancelled }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      };
      const sharedHost = (hostKey: string | null, threadId: string, cwd: string): AcpHost | null => {
        if (hostKey === null) return null;
        for (const host of hosts) if (host.key === hostKey && host.accepts(SHARED_SESSIONS_MAX, SHARED_SESSIONS_LIFETIME, threadId, cwd)) return host;
        return null;
      };
      const hostFor = (threadId: string, launch: { command: string; ro?: readonly string[] }, argv: string[], env: Record<string, string | undefined>, cwd: string,
        hostKey: string | null): AcpHost => {
        const running = sharedHost(hostKey, threadId, cwd);
        if (running) return running;
        const child = spawnCli(launch.command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], box: { allowEnv: instanceEnvNames(input.environment, env), botThreads: hostKey !== null, ro: launch.ro, engine: DRIVER_KIND } }, "bot");
        const host = new AcpHost(child, hostKey, { source: SOURCE, logMessage: nativeLogMessage, unrouted: refuse, promptCompletion: support.promptCompletion });
        hosts.add(host); signIn.watch(host); if (support.stderrFailure) watchStderrFailure(host, support.stderrFailure);
        child.once("close", () => hosts.delete(host));
        child.once("error", () => hosts.delete(host));
        return host;
      };

      const openSession = (
        threadId: string,
        launch: { command: string; args?: string[]; ro?: readonly string[] },
        argv: string[],
        env: Record<string, string | undefined>,
        cwd: string,
        contractKey: string,
        hostKey: string | null,
      ): AcpSession => {
        const commandCwd = permissionLaunchCwd(cwd);
        const host = hostFor(threadId, launch, argv, env, cwd, hostKey);
        const acp = host.link(threadId, cwd); const toolCalls = new Map<string, Record<string, any>>();
        const send = (obj: unknown) => acp.send(obj); const nodeVersion = support.minNodeVersion ? readNodeVersion(env) : undefined;

        const handleServerRequest = (msg: any, current: AcpTurn) => {
          current.state.startupActivity = true; if (current.state.promptSent) current.acknowledge();
          if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
            void answerClientFileRequest(msg, { send, cwd, enabled: support.clientFileSystem === true, readRoots: () => support.clientReadRoots?.(current.turn) });
            return;
          }
          const question = questionRequestFor(support.questionRequests, msg.method);
          if (question) return openQuestionRequest(msg, question, current, send, emit, () => base(threadId, current.turnId));
          if (msg.method !== "session/request_permission") {
          // An unanswered server request blocks the agent.
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = support.permissionRequest ? support.permissionRequest(msg.params ?? {}, toolCalls) : msg.params ?? {};
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
              message: `${support.displayName} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const isQuestion = String(toolCall.toolCallId ?? "").startsWith("interaction_");
          if ((support.allowsAlone?.(instanceId, current.turn, toolCall) || (current.turnConfig.fullAuto && current.turn.approvalMode === undefined)) && !isQuestion && acpAnswersAlone(toolCall.rawInput)) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({ jsonrpc: "2.0", id: msg.id, result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled });
          }
          const kind = String(toolCall.kind ?? "");
          const operationKey = isQuestion || current.controlsHost ? null : acpSessionOperationKey(toolCall);
          if (operationKey && acpAnswersAlone(toolCall.rawInput) && sessionAllows.get(threadId)?.has(operationKey)) {
            const allow = optionFor("allow");
            if (allow) {
              return send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow } } });
            }
          }
          const mcpTitle = !isQuestion && !/^(?:execute|edit|delete|move)$/.test(kind) && typeof toolCall.title === "string" && /^mcp__[\w-]+__[\w.-]+$/.test(toolCall.title) ? toolCall.title : undefined; // an MCP call keeps its name, so a saved grant finds it
          const tool = mcpTitle ?? (kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool");
          const isShellCommand = !isQuestion && kind === "execute" && !/^mcp(?:__|[.:])/i.test(String(toolCall.title ?? ""));
          const rawSummary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool);
          const summary = rawSummary.slice(0, isQuestion ? MAX_QUESTION_TEXT : 200) + (!isQuestion && typeof toolCall.rawInput?.justification === "string" ? `\nReason: ${toolCall.rawInput.justification.slice(0, 300)}` : "");
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
          timer.unref?.(); current.asks.set(requestId, finish);
          emit({
            ...base(threadId, current.turnId),
            type: "request.opened",
            requestId,
            requestType: isQuestion ? "question" : "permission",
            tool,
            summary,
            ...acpShellRequest(isShellCommand, isQuestion ? undefined : toolCall.rawInput, commandCwd), ...(!isQuestion && acpReadPaths(toolCall) ? { reads: acpReadPaths(toolCall) } : {}),
            requiresExplicitApproval: isShellCommand && (
              toolCall.rawInput?.dangerouslyDisableSandbox === true || toolCall.rawInput?.sandbox_permissions === "require_escalated"
            ) || undefined,
            choices: askQuestions?.[0]?.options.map(option => option.label) ?? (isQuestion ? questionChoices : undefined),
            ...(askQuestions ? { questions: askQuestions } : {}),
            approvalScope: current.controlsHost ? "local-computer" : undefined,
            allowSession: !isQuestion && !current.controlsHost ? true : undefined,
          });
        };

        const filterUpdate = support.updateFilter?.(toolCalls);
        const handleNotification = (msg: any) => {
          // Vendor side-channels (grok's `_x.ai/*`) are only teed to the native log.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (p._meta?.isReplay === true) return;
          session.commands = advertisedCommands(p.update) ?? session.commands;
          const updatedModeId = currentModeUpdateId(p.update); if (updatedModeId && (!p.sessionId || p.sessionId === session.sessionId)) { session.modeVersion += 1; session.sessionConfigResult = withSessionMode(session.sessionConfigResult, updatedModeId); return; }
          const current = session.current;
          if (support.modelVariants && p.update?.sessionUpdate === "config_option_update") {
            if (current && !current.state.settled && session.sessionId && p.sessionId === session.sessionId) current.receiveModelVariants(p.update);
            else session.appliedConfig.clear(); // a change between turns is not read: the next turn sends its values again
            return;
          }
          if (current && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"].includes(p.update?.sessionUpdate)) {
            current.state.startupActivity = true; if (current.state.promptSent) { current.acknowledge(); clocks.get(current.turnId)?.firstUpdate(Date.now()); }
          }
          if (!current || !current.state.promptSent) return void (!current && support.backgroundWork?.wakes(p.update, Date.now() - (session.settledAt ?? 0)) && endBackground(threadId, session));
          const u = filterUpdate ? filterUpdate(p.update ?? {}) : p.update ?? {};
          if (!u || (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string" && current.steering?.swallow(u.content.text))) return;
          const finished = u.status === "completed" || u.status === "failed";
          const toolEnded = (itemId: string | undefined) => {
            // a repeat update names an already-ended tool and emits nothing; the window only opens on a real end
            for (const event of acpToolEndEvents(u, itemId, current.endedToolIds)) {
              trackToolEndShown(current.state);
              emit({ ...base(threadId, current.turnId), ...event });
            }
          };
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                current.flushAssistantText();
                trackAssistantImage(current.state);
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
                const streamed = receiveText(current.state, delta, support.replyFailure);
                const trimmed = current.state.text.trimStart();
                if (streamed && !trimmed.startsWith("<SYSTEM_MESSAGE") &&
                    !trimmed.startsWith("The following is a <SYSTEM_MESSAGE") &&
                    !trimmed.startsWith("<SYSTEM_NOTIFICATION")) {
                  emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "assistant_text", delta: streamed });
                }
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) trackThoughtAfterTool(current.state);
              if (typeof delta === "string" && delta) emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              break;
            }
            case "tool_call": {
              current.flushAssistantText();
              trackRunningTool(current, u, "pending");
              // ACP can send a tool_call already marked completed or failed (e.g. on a denied permission) with no
              // tool_call_update after it.
              const itemId = (typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId
                : finished ? `acp-tool-unkeyed-${++unkeyedToolSeq}` : nextUnkeyedToolId(current);
              emit({
                ...base(threadId, current.turnId),
                type: "item.started",
                itemType: "tool",
                itemId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
                summary: commandSummary(u.rawInput),
                input: toolDetailPreview(u.rawInput),
              });
              if (finished) toolEnded(itemId);
              break;
            }
            case "tool_call_update": {
              trackRunningTool(current, u);
              if (finished) toolEnded((typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId : current.unkeyedToolIds.shift());
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
          for (const live of [acpToolProgress(u), acpToolOutput(u)]) if (live) emit({ ...base(threadId, current.turnId), ...live });
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
          sessionConfigResult: null, modeVersion: 0,
          get initResult() { return host.initResult; },
          set initResult(result: any) { host.initResult = result; },
          get authenticated() { return host.authenticated; },
          set authenticated(done: boolean) { host.authenticated = done; },
          idleTimer: null, appliedConfig: new AppliedConfig(),
          closing: false,
          dead: false,
          get stderr() { return host.stderrTail.text; },
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
            if (!current || current.state.cancelling) return;
            emit({ ...base(threadId, current.turnId), type: "runtime.error", ...describeSpawnFailure(e, launch.command, cwd) });
            settle(threadId, session, false, "spawn_error");
          },
          exit: function exit(code, signal, found?: string | null) {
            session.dead = true;
            // An engine with a Node.js minimum waits for the version read at launch, to say when that is too old.
            if (nodeVersion && found === undefined) return void nodeVersion.then((version) => exit(code, signal, version ?? null));
            const current = session.current;
            if (current?.state.cancelling) return;
            if (current) {
              if (!current.state.stopped) emit({ ...base(threadId, current.turnId), type: "runtime.error",
                ...exitBeforeResult(support.displayName, code, signal, session.stderr, support.minNodeVersion, found, session.host.startRefused) });
              settle(threadId, session, current.state.stopped, current.state.stopped ? "cancelled" : "exit_before_result");
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
        // A saved list that offers this turn's model stands in while the startup read runs (startup-refresh.ts).
        const standIn = startup.standsIn(turn), startedAt = Date.now();
        if (startupModelRefresh && !standIn) await startupModelRefresh;
        const modelsWaitedMs = Date.now() - startedAt;
        await backgroundEnds.get(turn.threadId); requireRunning();
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
        const clock = (retryOf !== undefined ? clocks.get(turnId) : undefined) ?? turnStartClock(DRIVER_KIND, startedAt);
        if (clocks.has(turnId)) clock.retried(); else clocks.set(turnId, clock);
        clock.waited("models", modelsWaitedMs);
        const cwd = turn.cwd ?? turnConfig.workspace ?? homedir();
        const env = childEnv(turnConfig);
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
        ) {
          const authenticated = await support.isAuthenticated(env, turnConfig, instanceId, instanceEnvNames(input.environment, env));
          requireRunning();
          if (!authenticated) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null, unsent: true });
            return { turnId };
          }
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env, catalog.models);
        const toolLimitKey = JSON.stringify([instanceId, resolvedModel ?? null]);
        const ownMcp = acpOwnMcpTransport(support), mcpServers = acpMcpServers(turn, { http: loopbackUnproxied(env, ownMcp !== "stdio") && ownMcp === "http", engine: support.driverKind,
          toolBudget: mcpToolBudget(learnedToolCountLimit(toolLimitKey), support.engineTools ?? 32) });
        support.applyTurnEnv?.(env, {
          model: resolvedModel, requestedModel: turn.model, fullAuto: turnConfig.fullAuto === true, botId: turn.botId, cwd, toolScope: turn.toolScope,
          threadId, mcpServers,
        });
        let cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        let launch: { command: string; args?: string[]; env?: Record<string, string | undefined>; ro?: readonly string[] };
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
        const processContract = [launch.command, launch.args ?? [], support.spawnContractArgs?.(turnConfig, cliTurn) ?? spawnArgs,
          support.sessionScopedApproval ? null : turnConfig.fullAuto === true, envFingerprint,
          support.spawnFingerprint?.(spawnEnv, turnConfig) ?? null, launch.ro ?? [], boxAudienceKey(cwd)];
        const contractKey = JSON.stringify([...processContract, cwd, turn.toolScope ?? null, inheritedScopeFingerprint]);
        const launchModel = support.sessionModelEnv && cliTurn.model && /^[\w.:/-]{1,200}$/u.test(cliTurn.model)
          && catalog.accountModels?.has(cliTurn.model) && !standIn ? cliTurn.model : undefined;
        const launchEnv = support.sessionModelEnv && launchModel
          ? { ...spawnEnv, [support.sessionModelEnv]: launchModel }
          : spawnEnv;
        let launchedThisTurn = false;
        // The folder and the tool selection ride session/new, so threads differing only there can share a process (in the bot box, only one bot's); never two audiences of a Team Cloud, whose engine homes differ.
        const hostKey = support.shareProcess && inheritedScopeFingerprint === null ? JSON.stringify([...processContract, launchModel ?? null, engineHomes.scope(), sharedBoxScope(cwd)]) : null;
        const launchSession = () => {
          const opened = openSession(threadId, launch, [...(launch.args ?? []), ...spawnArgs], launchEnv, cwd, contractKey, hostKey);
          opened.launchModel = launchModel; opened.effort = cliTurn.effort;
          launchedThisTurn = true; if (opened.host.opened === 1) clock.spawned(Date.now());
          return opened;
        };
        const sessionKey = JSON.stringify([mcpServers, turn.toolScope ?? null, inheritedScopeFingerprint]);

        if (turn.sessionReset) {
          closeSession(threadId, "reset");
          sessionAllows.delete(threadId);
        }
        const pooled = sessions.get(threadId);
        let session: AcpSession;
        if (pooled && !pooled.dead && !pooled.closing && pooled.contractKey === contractKey && !stderrFailureOf(pooled.host)
            && (!support.restartOnMcpChange || pooled.sessionKey === liveSessionKey(sessionKey, sessionSystem(support, pooled.initResult, instanceId, turn)))) {
          stopIdleClose(`${instanceId}\0${threadId}`, pooled.idleTimer); // busy again: no longer idle
          pooled.idleTimer = null;
          session = pooled;
        } else {
          if (pooled) {
            if (pooled.dead) sessions.delete(threadId);
            else closeSession(threadId, "contract");
          }
          const joining = sharedHost(hostKey, threadId, cwd);
          const admittingAt = Date.now();
          await turn.engineAdmission?.(joining ? "session" : "process", joining?.child.pid);
          clock.waited("room", Date.now() - admittingAt);
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
          timed(clock, method, signIn.refused(session.host) ?? session.acp.request(method, params, timeoutMs, receive, idleMs, idleMessage));

        const state: AcpTurn["state"] = { settled: false, promptSent: false, text: "", textMessageId: null, producedItem: false, repliedText: false, startupActivity: false, stopped: false, toolsSinceShown: false, thoughtSinceTool: false, usagePeak: null, usageLast: null, usageCompacted: false, failedChunk: null, cancelling: false };
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
        let approvalUnconfirmed = false, expectedModeId: string | undefined;
        const modelControls = new SessionModelControls({
          selection: support.selectModel, variants: support.modelVariants === true, displayName: support.displayName,
          model: () => cliTurn.model, reportedModel: () => reportedModel,
          state: () => session.sessionConfigResult, store: (result) => { session.sessionConfigResult = result; },
          report: (model, variants) => emit({ ...base(threadId, turnId), type: "session.model-variants", model, variants }),
        });
        const receiveModelVariants = (result: any, replace = false) => { if (replace) session.appliedConfig.clear(); modelControls.receive(result, replace); };
        const requestedVariantOption = () => modelControls.variant(variant);

        const flushAssistantText = () => {
          const raw = state.text;
          state.text = "";
          const text = stripLeakedSystemHarnessMessages(raw);
          if (!text.trim()) return;
          trackAssistantWords(state);
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
          endedToolIds: new Set(),
          interruptTimer: null,
          stopQuietWatch: null,
          flushAssistantText,
          receiveModelVariants,
          steering: support.steer && turnSteering(support.steer, {
            open: () => state.promptSent && !state.settled && !state.stopped && !session.closing,
            commands: () => session.commands,
            initializeResult: () => session.initResult, env,
            prompt: (text) => request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] }, undefined, undefined, promptIdleTimeoutMs()),
            extension: (method, text) => request(method, { sessionId: session.sessionId, prompt: [{ type: "text", text }] }, STEER_REQUEST_TIMEOUT_MS),
          }),
        };

        const interrupt = () => {
          state.stopped = true;
          if (session.sessionId) {
            session.acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId, ...(support.cancelMeta ? { _meta: support.cancelMeta } : {}) } });
            if (current.interruptTimer) clearTimeout(current.interruptTimer);
            current.interruptTimer = setTimeout(() => {
              state.cancelling = true;
              void endUncancelled(threadId, session).then((ended) => settle(threadId, session, ended, ended ? "cancelled" : "stop_failed"));
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
          let pendingSplitReceipt: PendingPromptSplitReceipt | null = null;
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
                    protocolVersion: 1, ...(support.initializeMeta ? { _meta: support.initializeMeta } : {}),
                    clientInfo: support.clientInfo?.(instanceId) ?? { name: "openmausbot", version: "0.0.0" },
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
              if (!skipSubscriptionAuthForLocalInject(turn.model) && !session.authenticated && !support.skipsAuthenticate?.(instanceId)) {
                const methods: Array<{ id?: string }> = Array.isArray(session.initResult?.authMethods)
                  ? session.initResult.authMethods
                  : [];
                const methodId = support.pickAuthMethod(methods, spawnEnv);
                if (methodId) {
                  try {
                    await session.host.once("authenticate", () => retryTransient(request, "authenticate", { methodId }, INIT_TIMEOUT));
                    session.authenticated = true;
                  } catch (error) {
                    const failed = signIn.authenticateFailed(error, support.authFailure); if (failed) throw failed;
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
            const heldSystem = () => sessionSystem(support, init, instanceId, turn);

            await backgroundEnds.get(threadId); const cursor = turn.sessionReset ? null : support.backgroundWork ? support.backgroundWork.resumeCursor(turn.resumeCursor, session.sessionId, session) : typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let promptTurn = turn;
            let rebuiltFromReplay = false;
            for (;;) {
              const liveSessionId = session.sessionId;
              if (liveSessionId !== null && session.sessionKey === liveSessionKey(sessionKey, heldSystem()) && (cursor === null || cursor === liveSessionId)) {
                break;
              }
              const selectionParams = narrowsNativeTools(turn.toolScope)
                ? support.toolScopeSessionParams!(turn, init, mcpServers.length > 0, { config: turnConfig, env, cwd }) : {};
              let loaded = false;
              if (cursor && !brokenSessions.has(cursor) && (!support.closeBeforeLiveLoad || liveSessionId !== cursor || await request("session/close", { sessionId: cursor }, 30_000).then(() => { session.sessionId = session.sessionKey = null; return true; }, () => false))) {
                try {
                  await loadUntilReplayQuiet({
                    link: session.acp, sessionId: cursor, quietMs: support.loadReplayQuietMs?.(turn), replayed: () => session.sessionConfigResult ?? {},
                    send: (receive) => request(
                      support.resumeMethod === "resume" ? "session/resume" : "session/load",
                      { sessionId: cursor, cwd, mcpServers: support.mcpServersFromLaunch ? [] : acpSessionMcpServers(mcpServers, ownMcp, init, support.takesUnadvertisedHttpMcp, support.sessionToolBudget), ...selectionParams, ...support.sessionSetupParams?.(init, heldSystem()) },
                      support.sessionSetupTimeoutMs ?? LOAD_SESSION_TIMEOUT, receive),
                    receive: (result) => {
                      if (result) {
                        loaded = true;
                        session.sessionId = cursor;
                        session.sessionKey = liveSessionKey(sessionKey, heldSystem());
                        receiveModelVariants(result, true);
                      }
                    },
                  });
                } catch (error) {
                  const classification = support.classifyError?.(error);
                  // OpenCode sends invalidParams with only the rejected sessionId. Cursor puts the id in the
                  // message: Invalid params: Session "<id>" not found (session/load). Other invalidParams must not
                  // erase history.
                  const missingSession = acpMissingSession(error, cursor);
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
                if (!turn.recoveryText?.trim()) throw new Error(`${support.displayName} session could not be resumed and the turn carries no recovery text to rebuild from`);
                const recovery = recoveryPromptFor({
                  recoveryText: turn.recoveryText,
                  currentText: turn.text,
                  failure: "before-accept",
                });
                promptTurn = { ...turn, text: recovery.text };
                rebuiltFromReplay = recovery.replayed;
              }
              await sessionNewRetried(() => request("session/new", { cwd, mcpServers: support.mcpServersFromLaunch ? [] : acpSessionMcpServers(mcpServers, ownMcp, init, support.takesUnadvertisedHttpMcp, support.sessionToolBudget), ...selectionParams, ...support.sessionSetupParams?.(init, heldSystem()) }, support.sessionSetupTimeoutMs ?? NEW_SESSION_TIMEOUT, (result) => {
                session.sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
                session.sessionKey = liveSessionKey(sessionKey, heldSystem());
                receiveModelVariants(result, true);
              }), () => session.child.exitCode === null && !session.closing && !session.dead, undefined, threadId); // a busy machine: once more, then plain words
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
                selectedModel = modelControls.modelOf(session.sessionConfigResult);
                // Committed before the setter runs: a failed switch still reports the session and respawns a stale process.
                const pick = pickSessionModel(support, {
                  configId: support.selectModel.configId, session, requested: turn, turn: cliTurn, variant, reportedModel,
                  catalog: catalog.models, launchedThisTurn,
                });
                if (pick.accountModels) catalog.accountModels = pick.accountModels;
                staleProcess = pick.staleProcess;
                if (pick.notice) emit({ ...base(threadId, turnId), type: "runtime.notice", message: pick.notice, text: pick.noticeText });
                ({ turn: cliTurn, variant, reportedModel } = pick);
                current.turn = cliTurn;
                selectedModel = await modelControls.select((m, p, t, r) => (session.appliedConfig.clear(), request(m, p, t, r)), sessionId, INIT_TIMEOUT);
              }

              if (support.configureSession) {
                approvalUnconfirmed = support.sessionScopedApproval === true;
                await support.configureSession({
                  request: async (method, params, timeoutMs) => {
                    const modeVersion = session.modeVersion;
                    const result = await request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT).catch((error) => { session.appliedConfig.clear(); throw error; });
                    if (method === "session/set_model" && params && typeof params === "object" && "modelId" in params && typeof params.modelId === "string") session.sessionConfigResult = { ...session.sessionConfigResult, models: { ...session.sessionConfigResult?.models, currentModelId: params.modelId } };
                    if (method === "session/set_mode" && params && typeof params === "object" && "modeId" in params && session.modeVersion === modeVersion) session.sessionConfigResult = withSessionMode(session.sessionConfigResult, params.modeId);
                    if (method === "session/set_config_option" && Array.isArray(result?.configOptions)) session.sessionConfigResult = { ...session.sessionConfigResult, configOptions: result.configOptions };
                    return result;
                  },
                  sessionId, instanceId,
                  env: spawnEnv,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(session.sessionConfigResult?.models?.availableModels) ? session.sessionConfigResult.models.availableModels : [],
                  currentModelId: session.sessionConfigResult?.models?.currentModelId, currentEffort: session.effort, effortApplied: (effort) => { session.effort = effort; }, applied: session.appliedConfig,
                  configOptions: Array.isArray(session.sessionConfigResult?.configOptions) ? session.sessionConfigResult.configOptions : [],
                  sessionModes: readSessionModes(session.sessionConfigResult) ?? undefined, expectMode: (modeId) => { expectedModeId = modeId; },
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
              const option = variant === undefined ? null : requestedVariantOption();
              if (option && variant !== undefined && !session.appliedConfig.holds(option.configId, variant, option.currentValue)) {
                await request("session/set_config_option", { sessionId, configId: option.configId, value: variant }, SESSION_CONFIG_TIMEOUT, receiveModelVariants)
                  .catch((error) => { session.appliedConfig.clear(); throw error; });
                if (requestedVariantOption().currentValue !== variant) throw (session.appliedConfig.clear(), new Error(`${support.displayName} did not apply variant ${variant}`));
                session.appliedConfig.accepted(option.configId, variant);
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded.
              emitSessionStarted();
              if (error instanceof LiveSwitchRefused && !launchedThisTurn && retryOf === undefined && !state.stopped && !session.closing) {
                acknowledge(); state.settled = true; session.current = null; active.delete(threadId); closeSession(threadId, "contract");
                return void sendTurn({ ...turn, startupRecovery: undefined, sessionReset: undefined, resumeCursor: sessionId }, turnId).catch((failure) => {
                  emit({ ...base(threadId, turnId), type: "runtime.error", message: failure instanceof Error ? failure.message : String(failure) });
                  emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "rpc_error", cost: null });
                });
              }
              throw error;
            }
            emitSessionStarted();
            const { input: promptInput, note: contextNote, split } = turnPrompt(DRIVER_KIND, { threadId, sessionId }, turn, promptTurn, heldSystem(), ACP_PROMPT_RE_ANCHOR_TURNS);
            if (split) { state.usagePeak = split.previous?.peakUsed ?? split.previous?.lastUsed ?? null; pendingSplitReceipt = split; }
            const text = support.buildPromptText
              ? support.buildPromptText(promptInput)
              : promptInput.system
                ? `${promptInput.system}\n\n${promptInput.text}`
                : promptInput.text;
            const imageBlocks = support.images === true && runtimeAcceptsImages
              ? await readAcpImageBlocks(turn.images ?? [])
              : []; const media = await readAcpMediaLinks(support.mediaLinks === true && !turn.guestConfined ? turn.text : "", imageBlocks.reduce((sum, block) => sum + Math.floor(block.data.length * 3 / 4), 0), ACP_MEDIA_MAX_BYTES, cwd);
            if (support.modelVariants && !modelControls.confirms(cliTurn.model)) {
              throw new Error(`${support.displayName} changed model before the prompt`);
            }
            if (variant !== undefined && requestedVariantOption().currentValue !== variant) {
              throw new Error(`${support.displayName} changed variant before the prompt`);
            } const promptOutcome = await support.promptOutcome?.(instanceId, sessionId);
            if (state.settled || state.stopped || session.closing) throw new Error("turn stopped");
            if (expectedModeId !== undefined && readSessionModes(session.sessionConfigResult)?.currentModeId !== expectedModeId) throw new Error(`${support.displayName} changed mode before the prompt`);
            state.promptSent = true; clock.promptSent(Date.now());
            if (!support.promptUnreachedModel) acknowledge();
            const promptIdleMs = promptIdleTimeoutMs();
            const quiet = startQuietWatch(threadId, session, current);
            const result = await request(
              "session/prompt",
              { sessionId, prompt: [{ type: "text", text: text + media.note }, ...imageBlocks, ...media.blocks, ...(contextNote ? [{ type: "text", text: contextNote }] : [])] },
              undefined,
              undefined,
              promptIdleMs,
              () => {
                const last = quiet.lastState();
                return `${support.displayName} sent nothing for ${formatQuietLimit(promptIdleMs)} with no tool running, so the turn was stopped as stuck` +
                  `${last ? ` (last seen: ${lastSeenPhrase(last)})` : ""}. Send the message again to retry.`;
              },
              );
            const harnessFailed = stderrFailureOf(session.host); if (harnessFailed) throw harnessFailed;
            const steersOut = current.steering?.promptAnswered();
            if (steersOut && !state.stopped) { current.flushAssistantText(); await steersOut; }
            const failure = state.failedChunk?.failure;
            // session/prompt resolving is the acceptance boundary: a rejected or reported-failed prompt leaves no receipt.
            if (pendingSplitReceipt && !failure) commitPromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt, { compacted: state.usageCompacted, last: state.usageLast, peak: state.usagePeak });
            const answers = turnAnswers(support.steer, result, current.steering?.replies);
            if (current.steering?.failure !== undefined && !state.stopped) throw current.steering.failure;
            const runOf = (answer: unknown) => support.steer && "run" in support.steer ? support.steer.run?.(answer) : undefined;
            for (const [index, answer] of answers.entries()) {
              const run = runOf(answer);
              if (run !== undefined && answers.slice(index + 1).some((later) => runOf(later) === run)) continue;
              const tokens = promptTokenUsage(answer);
              if (tokens) emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...tokens });
            }
            const final = answers.at(-1);
            const reason = final?.stopReason, reported = await promptOutcome?.(final); if (reported) throw reported;
            if (failure && reason === "end_turn") { flushAssistantText(); throw new Error(failure); }
            if (reason === "end_turn") settle(threadId, session, true, null);
            else if (reason === "cancelled" || state.stopped) settle(threadId, session, true, "cancelled");
            else {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                ...acpStopFailure(final, support.displayName),
              });
              settle(threadId, session, false, reason ?? "failed");
            }
          } catch (raw) { const e = signIn.asked(raw) ?? support.reportedFailure?.(raw) ?? raw;
            if (pendingSplitReceipt && state.promptSent && state.usageCompacted) {
              deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
            }
            if (!state.settled && !state.cancelling) {
              const untouched = retryOf === undefined && !state.producedItem && !state.text && !current.runningTools.size && !asks.size && !state.stopped && !session.closing;
              if (untouched && standIn && !state.promptSent && modelRefused(e)) { // the saved list was stale: read it, then once more
                acknowledge(); state.settled = true; session.current = null; current.stopQuietWatch?.(); closeSession(threadId, "stale-models");
                let stopped = false; // a Stop while the list is read ends the turn at once, and it is not tried again
                const stopWaiting = () => { if (stopped) return; stopped = true; active.delete(threadId); emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null }); };
                active.set(threadId, { stop: stopWaiting, interrupt: stopWaiting, turnId, asks: new Map() });
                return void startup.done().then(() => {
                  if (stopped) return;
                  if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
                  return sendTurn({ ...turn, startupRecovery: undefined }, turnId);
                }).catch((failure) => {
                  emit({ ...base(threadId, turnId), type: "runtime.error", message: failure instanceof Error ? failure.message : String(failure) });
                  emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "rpc_error", cost: null });
                });
              }
              if (untouched && retryUnderToolLimit(e, { key: toolLimitKey, model: resolvedModel, engine: DRIVER_KIND, retry: () => {
                acknowledge(); state.settled = true; session.current = null; active.delete(threadId); current.stopQuietWatch?.();
                return sendTurn({ ...turn, startupRecovery: undefined, sessionReset: undefined, resumeCursor: session.sessionId ?? turn.resumeCursor }, turnId);
              }, failed: (error) => { acknowledge(); emit({ ...base(threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "rpc_error", cost: null }); } })) return;
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e) ?? (engineFailureKind(message) === "credits" ? "insufficient_funds" : undefined);
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || code === "insufficient_funds" || message === support.loginNote;
              const accountError = isAccountError(code);
              if (turn.startupRecovery && startupFailureRecoverable(e, message, code, { approvalUnconfirmed, promptSent: state.promptSent, promptUnreachedModel: support.promptUnreachedModel?.(e) === true })
                  && !needsAuth && !accountError && !state.startupActivity && !state.producedItem && !state.text
                  && !state.stopped && !session.closing && !asks.size && !current.runningTools.size) {
                // Quiesce first: the close must not publish a completion before the harness recovers.
                state.settled = true;
                session.current = null; current.stopQuietWatch?.();
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                closeSession(threadId, "startup-recovery");
                const stopped = session.host.links.size > 0 || await killCliTree(session.child).catch(() => false);
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                active.delete(threadId);
                if (stopped && !state.stopped) {
                  finishClock(turnId, "not-started"); rejectStartup(new TurnNotStartedError(turnId, message));
                  return;
                }
                acknowledge();
                if (!state.stopped) emit({ ...base(threadId, turnId), type: "runtime.error", ...(engineFailure(support.displayName, message) ?? { message }) });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: state.stopped,
                  stopReason: state.stopped ? "cancelled" : "rpc_error", cost: null });
                return;
              }
              // After the person's Stop, a request the stop cut short is not an error.
              if (!state.stopped) emit({
                ...base(threadId, turnId), type: "runtime.error",
                ...acpRuntimeFailure(e, support.displayName, accountError ? { message: support.describeAccountError?.(code, cliTurn.model), text: support.accountErrorText?.(code) } : undefined),
                ...(needsAuth ? { setup: true } : {}), ...((e as any)?.acpPromptStall === true ? { stalled: true } : {}),
                ...((e as any)?.acpUsageLimit === true || (code === "quota_or_region_restriction" && LIMIT_WORDS.test(message)) ? modelControls.usageLimit((model) => support.limitFacts?.(message, model) ?? { limit: "engine" as const }) : {}), // waited out, or the engine gave up: another AI can carry on
              });
              // Never replay an accepted prompt (it may have run tools); evict before listeners start the next turn.
              if ((e as any)?.acpSessionBroken === true && session.sessionId) brokenSessions.add(session.sessionId);
              if (signIn.is(e)) closeSession(threadId, "sign-in-required"); else if (!needsAuth && !accountError && ((e as any)?.acpPromptStall === true || (e as any)?.acpUsageLimit === true || (e as any)?.acpSessionFailure === true
                  || code === "upstream_outage") && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, (e as any)?.acpPromptStall === true ? "prompt-stall" : "rpc-failure");
              } else if (approvalUnconfirmed && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "approval-unconfirmed");
              } else if (staleProcess && !state.promptSent && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "stale-models");
              }
              settle(threadId, session, state.stopped, state.stopped ? "cancelled" : needsAuth ? "auth_required" : (e as any)?.acpUsageLimit === true ? "quota" : "rpc_error");
            }
          }
        })();

        return startupAck ?? { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        if (support.snapshot) return support.snapshot(env, config, instanceId);
        const probe = await new Promise<{ version?: string; reason?: string; other?: true }>((resolve) => {
          execCliProbe(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout, stderr) => {
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
              resolve({ reason, ...inconclusiveMark(err) }); // `busy`: the check could not finish, which says nothing about the install
              return;
            }
            const version = versionFromProbe(stdout, stderr);
            resolve(!version ? { reason: `\`${config.cli}\` returned no version. Check the configured executable with --version, then try again.` } : support.cliVersion && !support.cliVersion.test(version) ? { reason: notThisCli(config.cli, support.displayName), other: true } : { version });
          });
        });
        if (!probe.version) return { state: "unavailable", reason: probe.reason, ...(probe.other ? { notEngineCli: true } : {}), ...busyOf(probe) };
        const authenticated = await support.isAuthenticated(env, config, instanceId, instanceEnvNames(input.environment, env)); return { state: "available", version: probe.version, authenticated, ...apiKeyAccount(env, support.credentialEnv, authenticated) };
      };

    /** Memory upkeep's one-shot: a fresh process and session, no MCP servers, an empty folder, every tool/permission refused. */
      const generateMemoryText = async (prompt: string, options: TextGenerationOptions = {}): Promise<string> => {
        if (startupModelRefresh) await startupModelRefresh;
        const turnConfig: AcpConfig = { ...config, fullAuto: false };
        const env = childEnv(turnConfig);
        if (support.requireAuthenticationBeforeSpawn && !(await support.isAuthenticated(env, turnConfig, instanceId, instanceEnvNames(input.environment, env)))) {
          throw new Error(support.loginNote);
        }
        const cwd = mkdtempSync(join(await support.oneShotFolder?.() ?? tmpdir(), "omb-acp-memory-"));
        try {
          const turnModel = oneShotTurnModel(support, env, options, catalog.models);
          const turn = { threadId: `memory-text-${newId()}`, text: prompt, approvalMode: "ask", cwd, ...(turnModel ? { model: turnModel } : {}) } as SendTurnInput;
          const model = applyOneShotEnv(support, env, options, catalog.models, { fullAuto: false, cwd, threadId: turn.threadId, mcpServers: [], ...(turnModel ? { model: turnModel } : {}) });
          const launch: { command: string; args?: string[]; env?: Record<string, string | undefined>; ro?: readonly string[] } = support.resolveCommand ? await support.resolveCommand(env, turnConfig, instanceId) : { command: turnConfig.cli };
          const spawnEnv = launch.env ?? env;
          return await runAcpOneShot({
            displayName: support.displayName,
            spawn: (...args) => { const child = spawnCli(...args); support.processStarted?.(child, instanceId); return child; }, kill: killCliTree, box: { allowEnv: instanceEnvNames(input.environment, spawnEnv), ro: launch.ro, engine: DRIVER_KIND },
            command: launch.command,
            argv: [...(launch.args ?? []), ...support.spawnArgs(turnConfig, turn)],
            env: spawnEnv,
            cwd,
            prompt,
            defaultModel: turnModel ?? catalog.models.default, model, ...(turnModel ? { configuredModel: turnModel } : {}),
            pickAuthMethod: (methods) => support.skipsAuthenticate?.(instanceId) ? null : support.pickAuthMethod(methods, spawnEnv),
            authRequired: turnModel && skipSubscriptionAuthForLocalInject(options.model ?? options.fallback?.model) ? false : !support.skipsAuthenticate?.(instanceId) && (support.authFailure === "fail-request" ? "if-requested" : support.authFailure === "fail"),
            loginNote: support.loginNote, signInRefused: support.skipsAuthenticate?.(instanceId) && support.signInRequest ? (error) => { const refused = support.signInRequest!.rpcError(error, instanceId); if (refused) support.signInRequest!.required(instanceId); return refused; } : undefined,
            clientCapabilitiesMeta: support.clientCapabilitiesMeta,
            ...(support.configureSession ? {
              configure: ({ request, sessionId, session }) => support.configureSession!({
                request,
                sessionId, instanceId,
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
          return catalog.models;
        },
        get modelsUnconfirmed() { return catalog.unconfirmed; },
        get modelsUnreadable() { return catalog.unreadable; },
        refreshModels: support.resolveModels ? () => refreshModels(true) : undefined,
        ...(startupModelRefresh ? { startupModelRefresh } : {}),
        ...(support.deviceSignIn && deviceSignIn ? deviceAuthInstanceSurface(deviceSignIn, support.deviceSignIn) : {}), ...(support.browserSignIn && browserSignIn ? acpBrowserAuthInstanceSurface(browserSignIn, support.browserSignIn) : {}),
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: acpCapabilities(support),
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          ...(support.steer ? { steer: async (threadId: string, text: string, images?: readonly TurnImageInput[]) =>
            images?.length ? "refused" as const : await sessions.get(threadId)?.current?.steering?.steer(text) ?? "refused" } : {}),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable";
            return finish(decision.behavior, "user", decision.message, decision.always === true);
          },
          hasSession: (threadId) => active.has(threadId),
          enginePid: (threadId) => (active.has(threadId) ? sessions.get(threadId)?.child.pid : undefined),
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
          await deviceSignIn?.dispose(); await browserSignIn?.dispose();
          const disposingSessions = Array.from(sessions);
          for (const { stop } of active.values()) stop();
          for (const [threadId, session] of disposingSessions) {
            closeSession(threadId, "dispose");
            settle(threadId, session, true, "cancelled");
          }
          listeners.clear(); clocks.clear();
          // Engines lead sessions of their own, so nothing stops them once this server exits.
          await stopEngineTrees([...disposingSessions.map(([, session]) => session.child), ...[...retiring.values()].flatMap((children) => [...children]), ...leaving]);
        },
      };
    },
  };
}

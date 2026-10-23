import { APPROVAL_REVIEW_RUBRIC } from "../shared/approval-review-policy.ts";

import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { ToolScope } from "../shared/tool-scope.ts";
import type { EffortLevel } from "../shared/wire.ts";
import type {
  DriverKind, InstanceId, ModelVariantOption, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";
import type { ProviderIcon } from "../shared/provider-icon.ts";

  export type { CloudBackend, EffortLevel, ModelSelection } from "../shared/wire.ts";
  export type {
  DriverKind, InstanceId, ModelVariantOption, ModelVariantState, RuntimeEvent,
  RuntimeEventBase, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";


export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
  /** The account has no credit left for a pay-as-you-go model. */
  | "insufficient_funds"
  | "quota_or_region_restriction"
  | "upstream_outage"
  | "model_catalog_outage";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

 export class TurnNotStartedError extends Error {
  readonly turnId: TurnId;

  constructor(turnId: TurnId, message: string) {
    super(message);
    this.name = "TurnNotStartedError";
    this.turnId = turnId;
  }
}

/** The CLI refused sign-in before any model or tool activity, and its process stopped. */
export class TurnAuthenticationRefusedError extends TurnNotStartedError {
  override readonly name = "TurnAuthenticationRefusedError";
}

/** The engine's usage limit refused the turn before any model or tool activity (or is known to be refusing until
 * `resetsAt`), and no process of it is running the turn. */
export class TurnUsageLimitRefusedError extends TurnNotStartedError {
  override readonly name = "TurnUsageLimitRefusedError";
  readonly resetsAt: number | undefined;

  constructor(turnId: TurnId, message: string, resetsAt?: number) {
    super(turnId, message);
    this.resetsAt = resetsAt;
  }
}

/** Variants are opaque provider IDs, not the cross-engine effort enum. */
export function isModelVariant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}


 export interface TurnImageInput {
  path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
}

    export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  icon?: ProviderIcon;
  environment?: Record<string, string>;
  enabled?: boolean;
  access?: EngineAccess;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

  export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

     export interface SendTurnInput {
  threadId: ThreadId;
  botId?: string;
  text: string;
  recalled?: string;
  approvalMode?: ApprovalMode;
  /** Fresh owner selection, independent of execution approval and resume state. */
  toolScope?: ToolScope;
  /** Review full arguments for app-owned gates or confirmed inactive native review. */
  reviewTool?: (action: { tool: string; arguments: Record<string, unknown> }, signal: AbortSignal) => Promise<{ decision: "allow" | "ask" | "deny"; reason: string }>;
  /** Record an exact action grant after a positive permission-card answer, before dispatch. */
  toolApproved?: (action: { tool: string; arguments: Record<string, unknown> }, signal: AbortSignal) => void | Promise<void>;
  guestConfined?: boolean;
  confinedWhy?: string;
  images?: TurnImageInput[];
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  resumeCursor?: unknown;
  sessionReset?: boolean;
  /** Hold the startup ACK until prompt dispatch (Claude: first model activity); a retired transient setup failure or sign-in refusal may reject with TurnNotStartedError. */
  startupRecovery?: boolean;
  /** Given to a driver with `capabilities.engineAdmission`: awaited right before it starts an engine process ("process") or
   * adds this thread's session to the running one whose pid is `joining` ("session"); rejects with TurnNotStartedError when
   * the turn is stopped first. */
  engineAdmission?: (start: "process" | "session", joining?: number) => Promise<void>;
  /** The turn with the conversation replayed inline, sent once on a fresh session when the provider refuses resumeCursor before reading the prompt. */
  recoveryText?: string;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  systemStable?: string;
  systemVolatile?: string;
  mentionTurn?: boolean;
  preloadBrowserTools?: boolean;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** The same bridge to a Team Cloud member's own apps, only in that member's own turns. */
    composioOwn?: { command: string; args: string[]; env: Record<string, string> };
    /** Stdio connection to a computer MCP server. `scope` is set only for the host desktop, so host-only approval rules never apply elsewhere. */
    localComputer?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform?: "darwin" | "linux" | "win32";
      generation?: string;
      scope?: "local-computer";
    };
    hooks?: { url: string; token: string };
    agents?: { command: string; args: string[]; env: Record<string, string> };
    /** Physical Android phone tools over authorized USB debugging. */
    phone?: { command: string; args: string[]; env: Record<string, string> };
    browser?: { command: string; args: string[]; env: Record<string, string> };
    data?: { command: string; args: string[]; env: Record<string, string> };
    /** The HighLevel CRM tools' MCP proxy: the harness holds the tokens and the per-bot verdict. */
    highlevel?: { command: string; args: string[]; env: Record<string, string> };
    /** dweb daemon tools; `url` is the dweb HTTP base. */
    dweb?: { url: string };
    custom?: Record<string, McpServerSpec>;
    /** The `custom` servers this turn mounts through an MCP Apps observer; `extension`: advertise the
     * UI extension (false once the server refused it). A server not named here is mounted unchanged. */
    mcpApps?: Record<string, { extension: boolean }>;
    /** Characters of one tool result per `custom` server; 0 = never trim, a missing name = the app default. */
    customResultBudgets?: Record<string, number>;
  };
  cwd?: string;
  mcpFromUserConfig?: boolean;
  /** Claude Code loads the person's own `~/.claude/skills` from this folder's `.claude/skills` (`--add-dir`). */
  userSkillsDir?: string;
  /** Per-call ceiling (ms) for this turn's MCP tools; absent is the driver's default (10 min). */
  mcpCallTimeoutMs?: number;
  /** Times an API-model turn that answers after a failed tool call is sent back to re-run it (`loopGuard.correctiveRounds`); never after a denial. */
  toolErrorCorrectiveRounds?: number;
}

/** An MCP server this machine starts and talks to over stdio. */
export interface StdioMcpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

 export interface RemoteMcpSpec {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpServerSpec = StdioMcpSpec | RemoteMcpSpec;

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    agentsMcp?: boolean;
    computerMcp?: boolean;
    composioMcp?: boolean;
    /** True when the driver can mount the first-party physical-phone MCP. */
    phoneMcp?: boolean;
    browserMcp?: boolean;
    dataMcp?: boolean;
    /** The driver can mount the HighLevel CRM tools MCP. */
    highlevelMcp?: boolean;
    /** The engine accepts images in the prompt (gates composer paste). */
    images?: boolean;
    nativeImageInput?: boolean;
    effortLevels?: readonly EffortLevel[];
    /** Isolated review may support effort even when the working session does not. */
    approvalReviewEffortLevels?: readonly EffortLevel[];
    /** The driver validates and applies model-specific variant IDs per session. */
    modelVariants?: boolean;
    queueing?: boolean;
    steerImages?: boolean;
    localComputerMcp?: boolean;
    customMcp?: boolean;
    strictResume?: boolean;
    hooks?: boolean;
    guestTurns?: "confined";
    /** "meter": `contextTokens` / `contextWindow` are the engine's own report, shown on the context meter but never used to time compaction. */
    contextReading?: "meter";
    /** sendTurn calls `engineAdmission` itself before it starts an engine process or joins one. */
    engineAdmission?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: {
      behavior: "allow" | "deny" | "answer";
      message?: string;
      always?: boolean;
    },
  ): Promise<RequestOutcome>;
  steer?(threadId: ThreadId, text: string, images?: readonly TurnImageInput[]): Promise<SteerOutcome>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
  cacheKeepWarm?: {
    ping(threadId: ThreadId, options?: { signal?: AbortSignal }): Promise<CacheWarmPingResult>;
    hold(threadId: ThreadId, until: number | null): boolean;
  };
}

 export type CacheWarmPingResult =
  | { ok: true; input: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number | null; model: string | null }
  | { ok: false; reason: string; busy?: boolean; limit?: boolean };

 export type SteerOutcome = "steered" | "refused" | "indeterminate";

 export interface ProviderSnapshot {
  /** Separate, explicitly authorized ChatGPT-plan billing (not Codex login). */
  chatgptPlan?: boolean;
  authenticationUnavailableReason?: string;
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  account?: { email?: string; organization?: string; method?: "login" | "api-key" };
  version?: string | null;
  update?: {
    title: string;
    message: string;
    command: string;
  };
  billing?: "metered" | "subscription";
  warning?: {
    title: string;
    message: string;
  };
}

           export interface EngineInstall {
  /** Added by the registry: commands run on this server, not its web client. */
  platform?: "darwin" | "win32" | "linux";
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** Docs or download page. The only route for GUI-installed engines. */
  docsUrl?: string;
  /** Interactive sign-in run after installing, when install isn't enough. */
  signInCommand?: string;
  /** `command` needs npm on PATH, so the UI can say so when Node is absent. */
  needsNode?: boolean;
  /** The app downloads and verifies a pinned provider runtime itself. */
  managed?: {
    label: string;
    downloadBytes: number;
  };
  settings?: "connections";
  server?: { package: string };
}

export interface ProviderAuthenticationStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
  /** A short-lived code to enter only at the provider's authorization URL. */
  userCode?: string;
}

export interface ProviderAuthenticationStatus extends Omit<ProviderAuthenticationStart, "phase"> {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  /** Safe, actionable copy; never unfiltered CLI output or credentials. */
  message?: string;
}

    export interface ModelCatalog {
  default: string;
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    provider?: string;
    contextWindow?: number;
    /** Discovery hints; the native session revalidates these before each turn. */
    variants?: ModelVariantOption[];
  }>;
}

 export function titleCaseModelId(id: string, wordBreaks: RegExp): string {
  return id
    .split(wordBreaks)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

 export function qualifiedModelLabel(
  id: string,
  qualifier: string | null | undefined,
  options: {
    redundantWhen?: (id: string, qualifier: string) => boolean;
    decorate?: (qualifier: string) => string;
  } = {},
): string {
  const { redundantWhen = () => false, decorate = (facet) => ` — ${facet}` } = options;
  if (!qualifier || redundantWhen(id, qualifier)) return id;
  return `${id}${decorate(qualifier)}`;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface TextGenerationUsage {
  model: string;
  input?: number;
  output?: number;
  cachedInput?: number;
  costUsd?: number;
}

export interface TextGenerationOptions {
  signal?: AbortSignal;
  onUsage?: (usage: TextGenerationUsage) => void;
  /** Only the helper model setting passes it: one of this instance's models instead of the driver's quick-call choice. */
  model?: string;
  /** How long the caller will wait; drivers with their own process timer use it instead of their default. */
  timeoutMs?: number;
}

export interface CheckpointGenerationOptions {
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  signal: AbortSignal;
  maxTokens: number;
  /** A null first-token deadline allows slow local prefill until Stop. */
  prefillTimeoutMs: number | null;
  idleTimeoutMs: number;
  continuation?: { partial: string; instruction: string };
  onProgress?: (progress: { textDelta?: string; reasoningDelta?: string }) => void;
  onUsage?: (usage: TextGenerationUsage) => void;
}

export interface CheckpointGenerationResult {
  text: string;
  stopReason: "stop" | "length";
  outputTokens?: number;
}

export interface PermissionReviewOptions {
  model: string;
  effort?: EffortLevel;
  variant?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TextGenerationUsage) => void;
}

export const PERMISSION_REVIEW_MAX_TOKENS = 2048;
export const PERMISSION_REVIEW_IDLE_TIMEOUT_MS = 5 * 60_000;
export const PERMISSION_REVIEW_SYSTEM_PROMPT = APPROVAL_REVIEW_RUBRIC;

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  /** Refresh a live catalog without recreating the provider instance. */
  readonly refreshModels?: () => Promise<void>;
  readonly startupModelRefresh?: Promise<void>;
  /** Optional first-party runtime installation and account setup. */
  readonly installRuntime?: () => Promise<void>;
  readonly startAuthentication?: () => Promise<ProviderAuthenticationStart>;
  readonly authenticationMethod?: "browser-pkce";
  readonly getAuthentication?: (flowId: string) => Promise<ProviderAuthenticationStatus>;
  readonly completeAuthentication?: (flowId: string, callbackUrl: string) => Promise<void>;
  readonly cancelAuthentication?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  generateCheckpoint?(prompt: string, options: CheckpointGenerationOptions): Promise<CheckpointGenerationResult>;
  generateText?(prompt: string, options?: TextGenerationOptions): Promise<string>;
  generateMemoryText?(prompt: string, options?: TextGenerationOptions): Promise<string>;
  reviewPermission?(prompt: string, options: PermissionReviewOptions): Promise<string>;
  dispose(): Promise<void>;
}

/** How an engine is presented in the picker rail.
 *  `subscription` — first-party cloud catalog; Custom is extra.
 *  `custom` — no subscription catalog; Custom is the product.
 *  `api` — a cloud model catalog billed through an API key. */
export type EngineAccess = "subscription" | "custom" | "api";

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  readonly install?: EngineInstall;
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();

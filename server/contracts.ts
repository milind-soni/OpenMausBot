// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

import type { ApprovalMode } from "../shared/approval-mode.ts";

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;
export type CloudBackend = "box" | "vps";

export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
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

/** Reasoning-effort levels, ascending. A union of everything any engine
 * accepts; each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrow untrusted API/config input before it becomes a model selection. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
}

/** An image already admitted to OpenMausBot's private attachment store.
 * Drivers receive this structured value instead of learning a host path from
 * prompt text. The harness validates the path and size before constructing it. */
export interface TurnImageInput {
  path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
}

// ── instance configuration envelope ────────────────────────────────────
// `driver` is any slug — NOT validated against known drivers; unknown
// drivers round-trip and surface as unavailable shadow snapshots so a
// config from a newer build downgrades safely.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── canonical runtime events ───────────────────────────────────────────
// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
}

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.retrying";
        /** 1-based: the retry about to be launched (1 = first relaunch). */
        attempt: number;
        delayMs: number;
        /** Why this failure was judged retry-worthy (classifyError's reason). */
        reason: string;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        /** THIS turn's token total, as the provider reports it at the end.
         * The one figure the harness accumulates — thread.token-usage.updated
         * is a live indicator whose meaning differs per driver (a per-call
         * delta, a thread total, a per-step figure) and must never be summed. */
        usage?: { input: number; output: number; cachedInput?: number };
      }
    | { type: "item.started"; itemType: "tool" | "reasoning"; title?: string }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    /** Provider-generated raster bytes. This event is folded into the
     * private attachment store and is never forwarded to renderer SSE: a
     * multi-megabyte base64 result belongs in one durable message URL, not
     * duplicated through every connected window. */
    | { type: "item.completed"; itemType: "assistant_image"; data: string; alt?: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
        approvalScope?: "local-computer";
        /** Provider asks to widen its configured sandbox. Only explicit Full
         * access may answer this automatically; Auto/remembered grants may not. */
        requiresExplicitApproval?: boolean;
      }
    | {
        type: "request.resolved";
        behavior: "allow" | "deny" | "answer";
        /** who decided: a person, auto mode, the ask's own timeout, the
         * harness (turn ended / settings changed), or nobody — the answerer
         * was already gone and the action never ran */
        source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
        approvalScope?: "local-computer";
      }
    | { type: "thread.token-usage.updated"; input: number; output: number; cachedInput?: number }
    // `setup: true` marks a failure the user fixes by installing or
    // configuring something, not by retrying — the UI offers setup instead.
    | { type: "runtime.error"; message: string; setup?: boolean }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** What became of an answer to an ask. `allowed-once` grants only the
 * asked-about action — broadening ("always allow") stays a separate,
 * explicit step. `unavailable` is the fail-closed default: no answerer,
 * no action. */
export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  /** Per-bot approval policy, reasserted by providers on every turn so a
   * resumed native session cannot retain a stale, more permissive mode. */
  approvalMode?: ApprovalMode;
  /** Images attached to this user turn only. They are deliberately kept out
   * of replay transcripts: the provider's native session owns earlier image
   * context, while a fresh replay retains the visible attachment marker. */
  images?: TurnImageInput[];
  model?: string;
  effort?: EffortLevel;
  resumeCursor?: unknown;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** A local stdio bridge owns the remote Composio transport. Keeping the
     * bridge harness-controlled lets it turn connection requests into trusted
     * chat cards consistently across provider CLIs. */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** Cloud computer, reached through OpenMausBot's REST-to-MCP adapter.
     * `control` is the harness's loopback who-is-driving endpoint: the
     * adapter consults it so a person who takes the wheel in the panel
     * pauses the bot's hands mid-turn instead of typing over them. */
    computer?: {
      kind?: "box";
      boxId: string;
      token: string;
      control?: { url: string; token: string };
    };
    /** Direct stdio connection to a Cua Driver MCP server (host, sandbox, or
     * VPS). `scope` is set only for the user's host desktop; isolated and
     * remote computers intentionally omit it so host-only approval rules
     * cannot change their semantics. */
    localComputer?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform?: "darwin" | "linux" | "win32";
      generation?: string;
      scope?: "local-computer";
    };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot) that routes back
     * through the harness so this bot can message other bots. The harness
     * owns turns, permissions, and recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
    /** Physical Android phone tools over authorized USB debugging. */
    phone?: { command: string; args: string[]; env: Record<string, string> };
    /** The app's built-in browser: an MCP proxy (server/drivers/browser-proxy)
     * that forwards to the Electron-owned WebContentsView the Browser tab
     * shows. One tab per bot, in its own persistent session partition. */
    browser?: { command: string; args: string[]; env: Record<string, string> };
    /** dweb network daemon: an MCP proxy exposing dweb status, repo, and
     * opencode model access as tools. url is the dweb HTTP base. */
    dweb?: { url: string };
    /** User-configured MCP servers (config.json `mcpServers`), already
     * validated and normalized by customMcpServers(). Mounted WITHOUT any
     * pre-allow: their tools ride each driver's normal permission flow. */
    custom?: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  cwd?: string;
}

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True when the driver mounts turn.integrations.computer (the box's
     * screenshot/click tools). Same rule as agentsMcp: a bot must never be
     * told it has a computer whose tools its driver cannot mount — it
     * burns turns hunting for tools that aren't there. */
    computerMcp?: boolean;
    /** True when the driver mounts turn.integrations.composio (the user's
     * connected apps). Same rule again: a key in the config says the user
     * HAS those connections, not that this driver can reach them. */
    composioMcp?: boolean;
    /** True when the driver can mount the first-party physical-phone MCP. */
    phoneMcp?: boolean;
    /** True when the driver can mount the built-in browser MCP. Same rule:
     * a bot must never be told it has a browser its driver cannot hand it. */
    browserMcp?: boolean;
    /** True when this engine accepts images in the prompt — gates image
     * paste in the composer. Same rule as computerMcp: never offer an
     * attachment an engine cannot open (a bot told it has an image it
     * cannot read burns the turn). */
    images?: boolean;
    /** True only when sendTurn consumes `images` as structured provider
     * input. Image-capable legacy drivers may instead read the attachment
     * path kept in `text`; central dispatch strips that tag only here. */
    nativeImageInput?: boolean;
    /** Effort levels this driver can pass to its CLI, ascending. Absent =
     * the driver cannot set effort, so the app never offers the control —
     * same rule as computerMcp: never show a knob the driver cannot turn. */
    effortLevels?: readonly EffortLevel[];
    /** True when the driver keeps a live session across turns and can take
     * a user message MID-TURN (delivered before the model's next call —
     * "steer"). The composer stays open during a turn on such an engine;
     * others keep the queue-one-and-wait behaviour. Same rule as the other
     * flags: never show a control the driver cannot honour. */
    queueing?: boolean;
    /** True only when local MCP calls can reach the human approval channel.
     * Full-auto/bypass provider instances must leave this false. */
    localComputerMcp?: boolean;
    /** True when the driver mounts turn.integrations.custom (the user's own
     * MCP servers from config). Same rule as composioMcp: an entry in the
     * config says the servers exist, not that this engine can reach them. */
    customMcp?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  /** Answer a pending ask. Resolves with what actually happened — never
   * throws for an ask that is no longer there: `unavailable` means nobody
   * could take the answer (the turn ended, the broker died, the driver
   * has no asks), and the caller treats it as a deny. Callers branch on the
   * outcome, not on prose. */
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string },
  ): Promise<RequestOutcome>;
  /** Deliver a user message into the RUNNING turn on this thread. Resolves
   * false when there is no live turn to steer (the caller then sends it as
   * a normal turn). Only drivers with `capabilities.queueing` implement it. */
  steer?(threadId: ThreadId, text: string): Promise<boolean>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
  /** A non-blocking provider update that unlocks newer capabilities. The
   * engine remains usable; renderer surfaces the exact terminal command. */
  update?: {
    title: string;
    message: string;
    command: string;
  };
  /** How this instance is paid for, when the driver can tell: a reported
   * cost on a subscription is notional and the UI labels it as such. */
  billing?: "metered" | "subscription";
}

// ── engine install descriptor ───────────────────────────────────────────
// How a user gets this engine onto their machine. Declared by the driver so
// that adding a provider stays "one file in drivers/ plus a registration":
// onboarding, the model picker, and settings all render from this instead of
// hardcoding per-engine copy in the UI.
//
// Installing is rarely the whole job — most CLIs then need an interactive
// sign-in, which is why signInCommand exists and why the UI sends people to a
// terminal rather than trying to shell out silently.
export interface EngineInstall {
  /** One-liner per platform. Omit a platform that has no such command —
   * the UI falls back to docsUrl rather than offering something that
   * cannot work there (a curl|bash line is not a Windows command). */
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
}

export interface ProviderAuthenticationStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    /** upstream provider id (e.g. "zai", "nous") when the engine can report
     * it — the picker shows it as a muted badge so BYOK duplicates of the
     * same model id stay distinguishable. */
    provider?: string;
    /** total context window in tokens, when the driver knows it — sizes
     * the model-facing rebuild (server/context-rebuild.ts). Unknown falls
     * back to a pattern table over the model id, then a conservative default. */
    contextWindow?: number;
  }>;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  /** Refresh a live catalog without recreating the provider instance. */
  readonly refreshModels?: () => Promise<void>;
  /** Optional first-party runtime installation and account setup. */
  readonly installRuntime?: () => Promise<void>;
  readonly startAuthentication?: () => Promise<ProviderAuthenticationStart>;
  readonly completeAuthentication?: (flowId: string, callbackUrl: string) => Promise<void>;
  readonly cancelAuthentication?: () => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string): Promise<string>;
  /** Isolated, tool-free permission review on this same provider. Kept
   * separate from generateText so the UI never infers a security capability
   * from a generic helper that may expose prompts in argv or lack approvals. */
  reviewPermission?(prompt: string, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

/** How an engine is presented in the picker rail.
 *  `subscription` — first-party cloud catalog; Custom is extra.
 *  `custom` — no subscription catalog; Custom is the product. */
export type EngineAccess = "subscription" | "custom";

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  /** How to get this engine installed. Omit for engines that need no local
   * binary (API-key drivers), which is what makes it optional. */
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

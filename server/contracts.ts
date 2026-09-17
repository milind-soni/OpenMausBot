// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { EffortLevel } from "../shared/wire.ts";
import type {
  DriverKind, InstanceId, ModelVariantOption, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";

// These contract types live in shared/wire.ts now (part of the wire model);
// re-exported here so existing server-side importers keep working.
export type { CloudBackend, EffortLevel, ModelSelection } from "../shared/wire.ts";
// Runtime-event wire shapes live in shared/runtime-events.ts now (part of
// the wire model); re-exported here so existing importers keep working.
export type {
  DriverKind, InstanceId, ModelVariantOption, ModelVariantState, RuntimeEvent,
  RuntimeEventBase, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";


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


/** Variants are opaque provider IDs, not the cross-engine effort enum. */
export function isModelVariant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.

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
  /** The bot this turn belongs to. threadIds are meant to be unique per bot
   * task, but a driver's process-level resource maps (permission-broker
   * socket, CLI session) key off threadId alone — botId lets a driver namespace
   * those resources so a threadId that unexpectedly coincides across two
   * bots (e.g. a delegation still holding its own broker open) can never
   * collide with another bot's live session or broker (see #1017). */
  botId?: string;
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
  variant?: string;
  resumeCursor?: unknown;
  /** The turn with the conversation so far replayed inline, attached only
   * alongside resumeCursor. A cursor-resuming driver sends it once, on a
   * fresh session, when the provider refuses the cursor before reading the
   * prompt (server/resume-recovery.ts) — so a session the provider lost
   * does not brick the thread, and the new session is not blank. */
  recoveryText?: string;
  /** recoveryText is the replay this turn would have been sent without a
   * resume cursor (it carries an update from outside the session). A driver
   * that rebuilds only some lost sessions may also rebuild this one. */
  recoveryIsReplay?: boolean;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** `system` split at the sections that legitimately change mid-conversation
   * (memory today): `systemStable` is everything else, `systemVolatile` is
   * those sections' text. A driver that keeps one CLI process per thread keys
   * that process on the stable half, so a memory edit no longer respawns the
   * session and makes the provider re-cache the entire prompt; the changed half
   * is delivered inside the next turn instead. Drivers that rebuild their
   * request every turn ignore both and keep reading `system`. */
  systemStable?: string;
  systemVolatile?: string;
  /** Coordinated teammate turns may resume a Claude conversation whose
   * earlier system prompt contained a different assignment. Refresh that
   * prompt when the provider supports it; the current brief also arrives
   * in this turn's text. */
  refreshSystemPrompt?: boolean;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** A local stdio bridge owns the remote Composio transport. Keeping the
     * bridge harness-controlled lets it turn connection requests into trusted
     * chat cards consistently across provider CLIs. */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** Box's native agent runner input. Only the Box driver consumes this;
     * CLI engines cannot use it as an MCP server. Other computers use the
     * stdio descriptor below. */
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
     * pre-allow: their tools ride each driver's normal permission flow.
     * A server is either a command this machine runs (stdio) or a server
     * reached at a URL; a driver that cannot speak to one kind skips it. */
    custom?: Record<string, McpServerSpec>;
  };
  cwd?: string;
  /** Let the engine also load the MCP servers from the person's own CLI
   * setup (Claude Code's user-scope servers and claude.ai connectors). Off
   * by default: a bot gets the servers its owner gave it, and each extra
   * tool costs tokens on every model call. Codex already reads its own
   * config.toml and ignores this; the Claude driver drops
   * --strict-mcp-config for the turn. */
  mcpFromUserConfig?: boolean;
}

/** An MCP server this machine starts and talks to over stdio. */
export interface StdioMcpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** An MCP server reached over HTTP: streamable HTTP (`http`, the current
 * transport) or the older SSE transport. Header values are credentials
 * (`Authorization: Bearer …`) and travel like env values: never on argv. */
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
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True when the driver mounts isolated computer MCP descriptors (the
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
    /** The driver validates and applies model-specific variant IDs per session. */
    modelVariants?: boolean;
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
    /** True when a turn given a resumeCursor runs in that exact native
     * session, or, if the provider refuses the session before accepting the
     * prompt, fails or starts a new session from recoveryText — never a blank
     * session that silently lacks the history; session.started says `rebuilt`
     * for that new session. The harness then keeps such a session across
     * externally appended messages and sends only those. */
    strictResume?: boolean;
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
    decision: {
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** "Always allow this session": hand the provider its own remembered
       * approval (Claude's suggested permission rules, ACP `allow_always`)
       * so it stops asking about this operation for the rest of the
       * session. The app keeps no grant of its own. */
      always?: boolean;
    },
  ): Promise<RequestOutcome>;
  /** Deliver a user message into the RUNNING turn on this thread. Only
   * drivers with `capabilities.queueing` implement it.
   *
   * - "steered" — the engine accepted the input into the live turn.
   * - "refused" — provably NOT delivered (no live turn, explicit RPC
   *   refusal, failed stdin write): the caller may queue it for the next
   *   turn without risk of running it twice.
   * - "indeterminate" — delivered, but the outcome is unknown (the RPC
   *   timed out after accept, transport failed, or the turn settled while
   *   the answer was in flight). The caller must NOT re-queue: the words
   *   may already be running, and replaying them would execute them twice. */
  steer?(threadId: ThreadId, text: string): Promise<SteerOutcome>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

/** The tri-state result of Adapter.steer — see the contract above. */
export type SteerOutcome = "steered" | "refused" | "indeterminate";

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  /** Vetted display identity from the provider CLI, never credentials.
   * `method` says how it is signed in when the CLI reports it: a personal
   * login, or the workspace API key. */
  account?: { email?: string; organization?: string; method?: "login" | "api-key" };
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
  /** A standing condition worth a look but with nothing to run: the engine
   * works, and something about how it is set up is costing the person
   * without their asking. Shown beside the update notice on Engines. */
  warning?: {
    title: string;
    message: string;
  };
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
  /** Settings can install or update this engine on the machine running the
   * server, as the server's own user, into a directory the app owns. Set by
   * the registry for supported npm packages, including private prerequisite
   * setup when npm is absent; never something a client chooses. */
  server?: { package: string; phase?: "preparing" | "installing" };
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
    /** Discovery hints; the native session revalidates these before each turn. */
    variants?: ModelVariantOption[];
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
  readonly getAuthentication?: (flowId: string) => Promise<ProviderAuthenticationStatus>;
  readonly completeAuthentication?: (flowId: string, callbackUrl: string) => Promise<void>;
  readonly cancelAuthentication?: () => Promise<void>;
  /** Remove the sign-in the provider CLI stores on this server, so a
   * different account can connect. Never touches another instance's home. */
  readonly signOut?: () => Promise<void>;
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

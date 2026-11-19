import type { UsagePatch, UsageLimitFailure } from "./usage-types.ts";
// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
  label?: string;
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
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        failure?: UsageLimitFailure;
      }
    | { type: "item.started"; itemType: "tool" | "reasoning"; title?: string }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
        approvalSource?: "studio";
      }
    | { type: "request.resolved"; behavior: string; source: string; answer?: string }
    | { type: "thread.token-usage.updated"; input: number; output: number }
    | { type: "runtime.error"; message: string; failure?: UsageLimitFailure }
    | { type: "usage.updated"; usage: UsagePatch }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Base64 data URL (e.g. data:image/png;base64,... or data:application/octet-stream;base64,...) */
  dataUrl?: string;
  /** Extracted UTF-8 text for text/code/markup files */
  textContent?: string;
  /** Saved local path on disk in the thread's workspace */
  path?: string;
  /** Server route serving the saved file; replaces dataUrl once it's on disk */
  url?: string;
}

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  attachments?: Attachment[];
  model?: string;
  resumeCursor?: unknown;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** Local computer use via the Electron-hosted cua-driver daemon —
     * spawn config comes verbatim from cua-connection.json (the daemon
     * MUST be spawned by Electron main; the harness only points the agent
     * CLI at the already-running socket via this MCP proxy command). */
    localComputer?: { command: string; args: string[]; env: Record<string, string> };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot) that routes back
     * through the harness so this bot can message other bots. The harness
     * owns turns, permissions, and recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
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
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  /** Add input to a live turn; reject if it has already ended. */
  steerTurn?(threadId: ThreadId, text: string): Promise<void>;
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string },
  ): Promise<void>;
  /** Cheap account read only; absent for apps without a verified endpoint. */
  refreshUsage?(): Promise<void>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  subscriptionPlan?: string;
  version?: string | null;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  options: Array<{ id: string; label: string }>;
}

export interface DiscoveredModelCatalog extends ModelCatalog {
  status: "ready" | "stale" | "unverified" | "error";
  source: string;
  refreshedAt?: string;
  error?: string;
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
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  setupStatus?(): Promise<Pick<ProviderSnapshot, "authenticated" | "subscriptionPlan">>;
  /** Fetch selectable models using this instance's CLI login or API credentials. */
  discoverModels?(): Promise<ModelCatalog>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: { displayName: string; supportsMultipleInstances?: boolean };
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
  /** Unified auto-approve toggle (Settings UI). Omit on drivers with no
   * permission concept — the UI then hides the control for that instance. */
  getAutoApprove?(config: Config): boolean;
  setAutoApprove?(config: Config, autoApprove: boolean): Config;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();

/** The client-visible wire model for tasks, bots, messages and rooms. A field
 * here is one the server emits in every response and SSE frame that carries
 * the shape. */
import type { DataBroadcast } from "./data-surface.ts";
import type { ApprovalMode } from "./approval-mode.ts";
import type { ToolScope } from "./tool-scope.ts";
import type { CommandAllowlistCandidate } from "./command-allowlist.ts";
import type { TurnDigest } from "./digest.ts";
import type { BotAvatarCrop } from "./bot-avatar.ts";
import type { BotBodyId } from "./bot-body.ts";
import type { ReplyStyle } from "./reply-style.ts";
import type { CredentialTargetId } from "./credential-request.ts";
import type { TeamSetupRequest } from "./team-setup.ts"; import type { DefaultBotFields, HelperIntroField } from "./default-bot.ts";
import type { RoutineRequestCardData } from "./routine-request.ts";
import type { WebhookRequestCardData } from "./webhook-request.ts";
import type { AppEventAttempt, AppTrigger, AppTriggerRequestCardData, AppTriggerService } from "./app-triggers.ts";
import type { ProfileRequestCardData } from "./profile-request.ts";
import type { PlaceRow } from "./place-view.ts";
import type { ModelRequestCardData } from "./model-request.ts";
import type { SkillRequestCardData } from "./skill-request.ts";
import type { QuestionRequestCardData } from "./ask-question.ts";
import type { AutomationLine, RoutineRunCardData } from "./routine-run.ts";
import type { WidgetPayload } from "./widget.ts";
import type { AppFromRef, AppPayload, AppPointedRef } from "./app.ts";
import type { GroupGoalRunCardData } from "./group-goal-run.ts";
import type { RuntimeEvent } from "./runtime-events.ts";
import type { NotificationLogEntry } from "./notification.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { WebhookAttempt, WebhookTrigger } from "./webhooks.ts";
import type { PublishedPageCard } from "./published-page.ts";
import type { LiveCallRecord, LiveCallState } from "./live-call-wire.ts";
export type { LiveCallRecord, LiveCallState, LiveCallStatus, LiveClient, LiveEndReason, LiveKeySource, LiveSettings } from "./live-call-wire.ts";

/** Reasoning-effort levels, ascending: a union of what any engine accepts;
 * each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** instanceId is the routing key. */
export interface ModelSelection {
  instanceId: string;
  model: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
  /** Explicit model-specific variant. Omitted leaves the native session alone. */
  variant?: string;
}

/** Which cloud computer backs computer: "cloud"; absent means Boat. */
export type CloudBackend = "box" | "vps";

/** A place a bot can act. `cloud` covers both cloud backends. */
export type Surface = "cloud" | "vm" | "local" | "browser";

export const MAUS_COLOR_NAMES = [
  "green", "blue", "red", "orange", "purple", "cyan", "pink",
  "yellow", "teal", "coral", "silver", "chrome",
] as const;
export type MausColor = (typeof MAUS_COLOR_NAMES)[number];

export function isMausColor(value: unknown): value is MausColor {
  return typeof value === "string" && (MAUS_COLOR_NAMES as readonly string[]).includes(value);
}

/** The face a bot rests on, as one of the engine's state names. */
export type MausExpression = string;

/** What the bot is doing right now, as the harness sees it. `parked.computer`
 * is task-level only: a turn that settled at the computer wait ceiling and
 * resumes when the seat frees. It never elevates the bot-level activity and
 * never counts as busy. */
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" | "parked.computer";

/** The bot that opened a thread on itself or a teammate. */
export interface TaskOpenedBy {
  botId: string;
  name: string;
  delegationId?: string;
  /** What kind of conversation the opener made this: "pair" is the one
   * durable conversation between two bots; "work" closes itself once its
   * result has been reported. */
  kind?: "pair" | "work";
  /** The opener's own conversation this "work" thread was opened from.
   * Everything that conversation later sends this bot continues here. */
  threadId?: string;
  /** A parallel room job's thread: `threadId` is the room thread it came from, and the member must stay in that room. */
  roomLane?: true;
  at: number;
}

/** The bot that closed a thread it opened (or one of its own). */
export interface TaskClosedBy {
  botId: string;
  name: string;
  at: number;
}

/** What a task has spent, banked once per settled turn. */
export interface TaskUsage {
  input: number;
  output: number;
  /** cached share of input (context the model re-read) */
  cachedInput?: number;
  /** null until any turn reported a cost — most engines never do */
  costUsd: number | null;
  turns: number;
  /** the most recent settled turn on its own */
  lastTurn?: { input: number; output: number; cachedInput?: number; costUsd: number | null };
  /** what filled the model's window on the last model call, and the window's size when known */
  context?: { tokens: number; window?: number };
}

/** Accounting for the currently displayed room thread, across all speakers. */
export interface GroupThreadUsage extends TaskUsage {
  lastSpeaker?: { botId: string; name: string };
}

export interface BotMovedTo {
  team: { id: string; name: string };
  state: "moving" | "moved";
  at: number;
}

/** One task = one conversation with its own context, thread and provider
 * session. */
export interface WireTask {
  /** Outstanding handoffs, not an active provider turn. */
  waitingForTeammates?: boolean;
  threadId: string;
  title: string;
  createdAt: number;
  /** The first message already drove a title attempt for this thread, so a
   * later one does not rename a thread the person may have retitled. */
  titleFromFirstMessage?: true;
  /** Organizational grouping only; never a directory or provider context. */
  projectId?: string;
  /** Detached routine execution, reachable through its visible results card. */
  routineRunId?: string;
  /** Set when a bot, not a person, opened this thread. */
  openedBy?: TaskOpenedBy;
  /** On a team's server: one person's conversation, seen by them alone (never by another member or an admin). */
  private?: true;
  /** Set by close_thread; absent while the thread is open. */
  closedBy?: TaskClosedBy;
  archivedAt?: number;
  /** Only true is stored; absent means unpinned. */
  pinned?: boolean;
  link?: string;
  linkAuto?: boolean;
  /** Epoch ms of the newest message, or createdAt when the thread has none.
   * Server-derived. Clients must not write it. */
  updatedAt?: number;
  lastThreadOrderAt?: number;
  /** 0 means "until new activity"; a future epoch ms means "until then", and
   * an expired value reads as absent. Absent = not snoozed. */
  snoozedUntil?: number;
  /** The thread's own model when a person picked one in it, else its bot's.
   * Always the effective one on the wire. */
  modelSelection?: ModelSelection;
  /** true: the thread runs on its bot's model and moves with it; false: a
   * person picked this thread's model. Derived at projection, never stored. */
  followsBotModel?: boolean;
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  unread?: boolean;
  /** The newest message on screen the last time the person read this
   * conversation. The New divider goes after it. */
  lastReadMessageId?: string;
  /** true after an edit/branch-switch rewound the visible conversation. */
  rewound?: boolean;
  pinnedMessageId?: string;
  /** Runtime-only state, reset on load and never persisted. */
  activity?: BotActivity;
  busy?: boolean;
  /** Epoch ms when this task's current busy stretch began; runtime-only. */
  turnStartedAt?: number;
  /** Where this conversation works when pinned; absent = follow the bot. */
  surface?: Surface;
  /** The pin above was set by the machine (an Auto turn or the bot's
   * select_computer), not a person, so the next Works on change moves it.
   * Derived at projection, never stored. */
  surfaceAuto?: true;
  usage?: TaskUsage;
  /** Prompt-cache keep-warm status for this thread, derived at projection;
   * absent when no window is open. */
  cacheKeepWarm?: CacheKeepWarmStatus;
  /** the folder this task's turns run in, pinned on its first turn. */
  cwd?: string | null;
}

/** One thread's keep-warm window as a client shows it. Times are epoch ms. */
export interface CacheKeepWarmStatus {
  state: "warm" | "stopped";
  until?: number;
  nextPingAt?: number;
  last?: { at: number; read: number; write: number; costUsd: number | null };
  stopped?: string;
}

/** A lightweight organizational label within one bot. */
export interface BotProject {
  id: string;
  name: string;
  emoji?: string;
}

/** Public, package-authored playbooks installed for a bot. Process
 * guidance only — never executable code, credentials, or grants. */
export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

/** Listing provenance and connector intent. It never means the apps are
 * authorized. */
export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
  /** Absent means "file". */
  source?: "file" | "org";
  /** file: a random id per import; org: derived from the organization and package. */
  installId?: string;
  /** This bot's key in the package, so a re-export keeps its identity. */
  agentKey?: string;
  /** Set when the bot was created from a package preset. */
  presetKey?: string;
  /** What the package suggested. Never applied: imported bots start at the default level. */
  suggestedApproval?: "ask" | "auto";
  /** org only */
  publisher?: { organizationId: string; slug: string; name: string };
  /** org only: "<publisher slug>/<package id>" */
  ref?: string;
  /** org only: the release bytes that were applied */
  sha256?: string;
}

/** One service's connector tool grant: `"*"` widens to every tool on the
 * service, an explicit list names exact tools. */
export interface ConnectorToolGrant {
  tools: "*" | string[];
}

/** Lowercased Composio service slug, e.g. `gmail`. */
export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;
/** Composio tool names are upper-snake, e.g. `GMAIL_SEND_EMAIL`. */
export const CONNECTOR_TOOL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Fails closed: only an absent switch or a strict true allows the helper model; a hand-edited "false" or 0 reads as never. */
export const helperModelAllowed = (bot: { helperModel?: unknown }): boolean => bot.helperModel === undefined || bot.helperModel === true;

/** A bot as a client may see it. avatarUrl is always present (null when the
 * bot has none). */
export interface WireBot extends DefaultBotFields {
  waitingForTeammates?: boolean;
  id: string;
  /** The task selected in the UI; running turns keep their own thread id. */
  threadId: string;
  /** Where a routine without a thread of its own reports. Absent only for a
   * bot without threads. */
  mainThreadId?: string;
  /** newest first */
  tasks?: WireTask[];
  projects?: BotProject[];
  name: string;
  title: string;
  description: string;
  /** Standing instructions — the persona body. */
  soul?: string;
  /** sha256 of soul, for spotting a SOUL.md edited outside the app. */
  soulHash?: string;
  /** The SOUL.md mirror differed from soul at the last turn dispatch. */
  soulDrift?: boolean;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  mascotBody?: BotBodyId | null;
  /** App-owned attachment served as this bot's custom profile image;
   * always present on the wire, null when the bot has none. */
  avatarUrl: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  /** Zoom of a custom image. Absent means 1, the unzoomed cover crop. */
  avatarZoom?: number;
  /** Horizontal point of the image kept in the crop, 0–1. Absent means center. */
  avatarFocusX?: number;
  /** Vertical point of the image kept in the crop, 0–1. Absent means center. */
  avatarFocusY?: number;
  /** True when any task has unread output. */
  unread: boolean;
  /** The bot's model: every thread without a model of its own runs on it
   * and moves with it. Navigating tasks never changes this value. */
  modelSelection: ModelSelection;
  /** where the bot works ("Works on"). Unset = auto. */
  computer?: Surface | "off";
  /** Which cloud computer backs computer: "cloud"; absent means Boat. */
  cloudBackend?: CloudBackend;
  /** Auto mode may prepare/start this bot's managed VPS container. */
  autoStartVps?: boolean;
  /** This bot's own SSH config alias for its managed VPS computer; absent
   * means the default server from Settings → API keys. */
  vpsAlias?: string;
  /** where NEW tasks run their shell tools; absent = home folder. */
  cwd?: string;
  /** Auto mode: the bot approves its own tool permissions. */
  autoApprove?: boolean;
  /** Canonical approval level. Missing resolves through autoApprove. */
  approvalMode?: ApprovalMode;
  /** Tools this bot may always use without asking. */
  alwaysAllow?: string[];
  /** Speak this bot's replies aloud as they settle, without being asked. */
  speakReplies?: boolean;
  /** How replies are shaped. Absent = "default". */
  replyStyle?: ReplyStyle;
  /** This bot's own voice id, so a room of bots doesn't sound like one person. */
  voice?: string;
  /** Whether this bot may send voice notes. Absent/true = allowed; false
   * hides the tool and refuses the route even with a voice configured. */
  voiceNotes?: boolean;
  /** Whether this bot may use the X research tools (x_search, x_user_posts,
   * x_post, x_profile), which spend the workspace's treg balance.
   * Absent/false = off: the person turns it on per bot. */
  xResearch?: boolean;
  /** Whether this bot uses native memory. Absent/true = enabled. */
  memoryEnabled?: boolean;
  /** Queue direct-chat messages behind outstanding delegated work. */
  parkDirectMessages?: boolean;
  /** true after an edit/branch-switch rewound the visible conversation. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** On My Cloud, a bot its person moved into one of their teams: `moving` while it goes (no turns, its routines off),
   * `moved` once it lives there (archived here, shown as a line that opens the team). */
  movedTo?: BotMovedTo;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** The coordinator for this bot's sidebar section. */
  chiefOfStaff?: boolean;
  /** Owner-selected additional teams this Chief may coordinate. */
  managedSections?: string[];
  /** Team Cloud only: the lowercased email of the member who created the bot (or moved it in). */
  createdBy?: string;
  /** Team Cloud only: the lowercased email of the member the bot reports to, whose inbox its questions, approvals,
   * failures and routine results reach. Absent: it reports to `createdBy`. */
  reportsTo?: string;
  /** Pause for human approval before this bot talks to a peer. */
  approvePeerComms?: boolean;
  /** Bot ids this bot is allowed to contact. */
  peers?: string[];
  /** Whether this bot may use the workspace's connected apps. */
  composio?: boolean;
  /** Which connected-app tools this bot may call, by service slug. Absent
   * defers to `composio` (unset/true = every tool, false = none); `{}` grants
   * none. Grants never travel in shareable exports. */
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: { apps: Record<string, "read" | "write"> };
  outbound?: { policy: "ask" | "allow"; dailyCap: number };
  /** Ordered backups used only by opt-in, pre-prompt startup recovery. */
  fallback?: Array<{ instanceId: string; model: string }>;
  /** Whether this bot gets the app's built-in browser. */
  browser?: boolean;
  /** Record a screenshot and a short note of each browser action, kept with
   * the conversation. Off unless true. */
  recordBrowserSteps?: boolean;
  /** Memory upkeep: the harness captures facts from finished chats into
   * MEMORY.md and topic files, adds facts about the person to About me and
   * tidies nightly. On unless explicitly false. */
  memoryUpkeep?: boolean;
  /** Prompt-cache keep-warm for this bot's Claude threads: true or false
   * overrides the workspace setting; absent follows it. */
  cacheKeepWarm?: boolean;
  /** false: the workspace's helper model never writes this bot's background texts. Absent or true: allowed. */
  helperModel?: boolean;
  /** Which of the app-wide MCP servers this bot mounts, by name. */
  mcpServers?: string[];
  /** Owner-selected original tool identities. An empty allowlist permits none. */
  toolScope?: ToolScope;
  /** Id of a named browser profile; absent = the bot's own private session. */
  browserProfile?: string;
  playbooks?: InstalledPlaybook[];
  installedPackage?: InstalledPackageMetadata;
  /** Aggregate of task and room activity; transient, reset on load. */
  busy?: boolean;
  /** What the bot is doing right now; transient like busy. */
  activity?: BotActivity;
  createdAt: number;
  /** Who may see this bot on a workspace several people share. Absent means
   * everyone. Sent to admins only; a member's copy of a bot never carries it. */
  visibility?: BotVisibility;
}

/** Who may see a bot: every signed-in person, admins only, or the listed
 * addresses (and `@domain` entries) plus admins. */
export type BotVisibility = "everyone" | "admins" | { people: string[] };

/** The person a user message is from, as the server resolved it from their
 * own session; no request body can supply it. `name` is attribution only:
 * nothing may be allowed or refused because of it. `id` is an opaque
 * server-derived key that decides only whose session may answer a card this
 * request raised. */
export interface ResolvedSender {
  name: string;
  id?: string;
}

/** Who answered a card: a signed-in person (named as their messages are), the
 * owner on this machine, or a session-less local caller on a shared server
 * (`worker`: the Slack worker, or any other process on that machine). */
export type CardAnswerer = (
  /** `person`: the answering session's opaque person key, recorded on an OMB
   * Cloud home only. */
  | { kind: "session"; name: string; person?: string }
  | { kind: "loopback" }
  | { kind: "worker" }
) & {
  /** "call": decided by voice on a Live call; "reaction": by a 👍 or 👎 on the
   * card. Absent: tapped. */
  via?: "call" | "reaction";
};

/** One transcript line, serialized as stored. */
export interface WireMessage extends HelperIntroField {
  roomRequest?: { id: string; phase: "request" | "result" };
  /** Stable native assignment identity for idempotent lifecycle report delivery. */
  runtimeReportId?: string;
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "signin" | "routine.run" | "goal.run" | "digest" | "compaction" | "call" | "widget" | "app";
  text?: string;
  digest?: TurnDigest;
  compaction?: {
    summary: string;
    firstKeptId: string;
    foldedThroughId: string;
    tokensBefore: number;
    by: "person" | "harness";
  };
  /** Renderers receive only the allowlisted /api/attachments URL. `file`
   * entries are opened through the message-scoped file route, never by path. */
  attachments?: Array<
    | { kind: "image"; path: string; mime: string; name?: string }
    | { kind: "file"; path: string; mime: string; name: string }
    /** `text` is the words the note speaks (secret-redacted when stored): clients show it behind a
     * collapsed transcript, never as message body, and the model's replay folds it back after `text`. */
    | { kind: "audio"; path: string; mime: string; durationMs?: number; text?: string }
  >;
  card?: OptionCardData;
  /** widget rows (kind "widget"): a bot-authored UI tree. `text` is its
   * readable fallback for clients that do not know the kind. */
  widget?: WidgetPayload;
  /** widget rows the server built from records (mail, calendar, other
   * bots' work) rather than the bot: replayed to the bot only as labelled
   * data, never as its own words, and never edited by a bot. */
  serverCard?: true;
  /** A setup suggestion the device renders in its own words (server/host/helper-suggestion.ts); `text` is the English. */
  setupSuggestion?: { kind: "helperKey"; answer?: "notNow" };
  /** app rows (kind "app"): bot HTML or an MCP server's UI. `text` is always the readable fallback. */
  app?: AppPayload;
  /** user rows sent by an app's ui/message: the app row that sent them. Every client draws "Sent from <title>". */
  fromApp?: AppFromRef;
  /** user rows sent with parts of a bot's page the person pointed at in the preview: what each chip said. */
  pointed?: AppPointedRef[];
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** signin rows: the bot asked the person to sign in to a site themselves. */
  signIn?: SignInRequestCardData;
  /** One idempotently updated status card for a routine run. */
  routineRun?: RoutineRunCardData;
  automation?: AutomationLine;
  /** Terminal receipt for a bounded multi-bot channel goal. */
  goalRun?: GroupGoalRunCardData;
  /** call rows (kind "call"): the finished Live call this row records. */
  call?: LiveCallRecord;
  /** activity messages: tool name + outcome. */
  tool?: {
    name: string; ok?: boolean; spoken?: string; setup?: boolean; terminal?: boolean; summary?: string; input?: string; output?: string;
    /** error rows: the installed Claude Code is too old for the model, and
     * the UI can offer to update it in place. */
    claudeUpdate?: boolean;
  /** error rows: the place this turn could not use. */
    place?: PlaceRow;
    /** error rows: epoch ms when the usage limit that stopped the turn resets. */
    limitResetsAt?: number;
    /** Provider item identity, scoped to the owning turn. */
    itemId?: string;
    /** Whether the harness captured the full redacted result. Private
     * server-local spill paths are not exposed to clients. */
    fullResult?: boolean;
  };
  /** A bot line a "post" webhook wrote: whoever called the webhook chose
   * its words. On a room line this also carries `from`, so the room renders
   * the webhook's bot as the speaker. */
  webhookPost?: boolean;
  /** user messages sent INTO a running turn (capabilities.queueing). */
  steered?: boolean;
  /** user messages a peer bot handed to this thread's RUNNING turn: peer
   * context folded in mid-turn, never a new request. The text is stored
   * enveloped exactly as injected. */
  aside?: boolean;
  /** A user-role message that arrived through the server's HTTP API
   * ("api"), or a request a person spoke on a Live call ("call"). */
  via?: "api" | "call";
  /** The Live call a "call" line was spoken on (LiveCallState.callId). Set
   * only on user messages with `via: "call"`; a turn's own messages point
   * at their request through `requestMessageId` instead. */
  callId?: string;
  /** A user line an external interface relayed through the guarded send
   * route (the Slack worker): nobody typed it in one of this workspace's
   * clients. A Live call never reads it back as what the caller typed. */
  relayed?: boolean;
  /** Which person sent this user message, when the workspace has more than
   * one. Absent reads as the profile name. */
  sender?: ResolvedSender;
  /** Provider turn that produced this message. */
  turnId?: string;
  /** Server-proven originating user message, including supported harness
   * continuations. Absent means external clients must not infer ownership. */
  requestMessageId?: string;
  /** Provider completion outcome, independent of whether it emitted text. */
  turnSucceeded?: boolean;
  /** An exact request was stopped; a restart must not revive an old result. */
  requestCancelled?: boolean;
  jobCancellation?: import("./job-cancellation.ts").JobCancellationResult;
  /** Set before execution and cleared only after the request's verified
   * final turn and dependencies settle. A restart never clears it. */
  requestPending?: boolean;
  /** The last assistant text item from a settled provider turn. */
  turnTerminal?: boolean;
  turnCompletedAt?: number;
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. */
  parentId?: string | null;
  /** Optional flat reply reference for an inline quote. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** Per-send channel behavior. Absent is legacy quick chat. */
  channelMode?: "chat" | "goal";
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string };
  /** Set on a room message a bot pushed in with post_to_room. */
  peerPost?: { unattended?: boolean };
  /** A room reply whose speaker the decision model picked (an Auto room),
   * with how sure it was. Absent on every other message; clients that do
   * not know it ignore it. */
  routedBy?: { provider: "jev" | "workersai" | "openrouter"; probability: number };
  /** On a conversational bot's user line: the picker label of the quick model its reply ran on. */
  quickModel?: string;
  /** Set on the user-role line another bot delivered into this bot's own
   * conversation (coordinate_bots, start_thread). `incident`: the line is a
   * Team incidents report or Team escalations notice about that bot's thread
   * in `threadId`, not its words; `notified`: the person was already buzzed. */
  peerAsk?: { botId: string; name: string; unattended?: boolean; incident?: { threadId: string; notified?: boolean } };
  /** One reaction per person (shared/reactions.ts REACTIONS). `by` is "user"
   * on a workspace one person uses, otherwise that person's opaque key, the
   * one GET /api/auth/session returns as `reactor`. `name` is attribution
   * only; `at` is when they chose it. */
  reactions?: Array<{ emoji: string; by: string; name?: string; at?: number }>;
  /** user lines a 👍 or 👎 made: the person reacted with this emoji to
   * `replyToId` instead of typing. Clients show the reaction on that message
   * and draw no bubble for this line. */
  reaction?: string;
  /** comm chips: "Messaged @X", linking to the bot-bot channel. */
  comm?: { groupId: string; threadId?: string; withBotId: string; withName: string; withColor: string };
  /** thread chips: "Opened thread #Title on @X". */
  threadRef?: { botId: string; threadId: string; title: string };
  /** A page the bot published to a public link (publish_page), or why it couldn't. `text` carries the link too. */
  publishedPage?: PublishedPageCard;
  /** A published Data result, linked to its bot's main viewer. */
  dataResult?: { botId: string; cardId: string; title: string; kind: "table" | "chart" | "text"; sql?: string };
  /** user messages: the Data result the person was viewing when they sent
   * this. `text` stays exactly what they typed. */
  dataContext?: { cardId: string; draftSql?: string };
  /** user messages waiting in the steer-queue while the bot is mid-turn. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. */
  queueId?: string;
}

export const movesThreadToTop = (message: Pick<WireMessage, "role" | "kind" | "peerAsk" | "turnId" | "turnTerminal">): boolean =>
  message.role === "user" ? !message.peerAsk : message.kind === "text" && (message.turnTerminal === true || !message.turnId);

export function orderedThreadList<T extends { pinned?: boolean; lastThreadOrderAt?: number; createdAt?: number }>(tasks: readonly T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const pin = Number(b.task.pinned === true) - Number(a.task.pinned === true);
      if (pin) return pin;
      const recency = (b.task.lastThreadOrderAt ?? b.task.createdAt ?? 0) - (a.task.lastThreadOrderAt ?? a.task.createdAt ?? 0);
      if (recency) return recency;
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}

/** 0 is the "until new activity" sentinel. The event stream never drops an expired snooze, so check the clock too. */
export const isSnoozed = (task: Pick<WireTask, "snoozedUntil">, now = Date.now()): boolean =>
  task.snoozedUntil !== undefined && (task.snoozedUntil === 0 || task.snoozedUntil > now);

type OpenThreadCandidate = Pick<WireTask, "routineRunId" | "archivedAt" | "closedBy" | "openedBy" | "snoozedUntil" | "pinned" | "lastThreadOrderAt" | "createdAt">;

/** The top row of the bot's thread list, so deleting the open thread never pulls a hidden one into view. */
export function nextOpenThread<T extends OpenThreadCandidate>(tasks: readonly T[], now = Date.now()): T | undefined {
  const own = tasks.filter((task) => !task.routineRunId);
  const open = own.filter((task) => task.archivedAt === undefined);
  const listed = open.filter((task) => task.pinned === true || !(task.closedBy || task.openedBy || isSnoozed(task, now)));
  return [listed, open, own].map((candidates) => orderedThreadList(candidates)[0]).find((task) => task !== undefined);
}

export interface OptionCardData {
  /** calls: one per outbound call the card covers, in subtitle order. */
  outboundRequest?: { tool: string; app: string | null; calls?: Array<{ app: string | null; label: string }> };
  /** `revision`: the entry as it applied without a person, so Undo can tell it changed since. */
  teamMemoryRequest?: { section: string; entryId: string; kind: string; revision?: string };
  title: string;
  subtitle: string;
  options: string[];
  /** Distinguishes a provider question from an approval after its live run ends. */
  requestType?: "permission" | "question";
  answered?: string;
  /** What was actually answered, when the answer is words rather than a
   * verdict. */
  answeredText?: string;
  dismissed?: boolean;
  /** Who settled the card, when a person or service answered it. */
  answeredBy?: CardAnswerer;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission cards: the tool being requested. */
  tool?: string;
  /** why this card is waiting: guard, mode, sandbox or delivery error. */
  held?: string;
  /** Terminal: this proposal went stale while open (revision mismatch or
   * a superseding request). Nothing can answer it; a fresh proposal is
   * needed, and clients must not offer its options. */
  expired?: boolean;
  /** Catalog key for held when it is one of the fixed notes. */
  heldCode?: string;
  /** the narrow grant "always allow" remembers for a harness-native card. */
  allowKey?: string;
  /** the provider can remember an allow for the rest of its session. */
  allowSession?: boolean;
  /** Exact native command offered for an owner/admin to remember. */
  commandAllowlist?: CommandAllowlistCandidate;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** The bot's change applied without a person (a change to the bot itself,
   * or Full access): clients show a one-line receipt with Undo instead of
   * the approval box. */
  autoApplied?: boolean;
  /** A person undid that change. */
  undone?: boolean;
  /** A durable chat-created routine proposal. */
  routineRequest?: RoutineRequestCardData;
  /** A webhook trigger a bot made or changed from chat. */
  webhookRequest?: WebhookRequestCardData;
  /** An app-event automation a bot made or changed from chat. */
  appTriggerRequest?: AppTriggerRequestCardData;
  /** A durable profile-change proposal (propose_profile). */
  profileRequest?: ProfileRequestCardData;
  /** A durable default-model proposal (propose_model). */
  modelRequest?: ModelRequestCardData;
  teamSetupRequest?: TeamSetupRequest;
  /** A durable learned-skill proposal. */
  skillRequest?: SkillRequestCardData;
  /** A provider's structured question set. */
  questionRequest?: QuestionRequestCardData;
  /** The options are the whole answer: clients offer no free-text reply. */
  fixedOptions?: boolean;
  quotaSwitch?: QuotaSwitchCardData;
}

/** Kept on the card so the offer survives a restart. `engines` follow the card's options; `messageId` is the
 * message to resend, `rootId` the failed request's job-runtime root. */
export interface QuotaSwitchCardData {
  engines: Array<{ instanceId: string; name: string }>;
  messageId?: string;
  rootId?: string;
}

export interface ConnectorCardData {
  /** Composio toolkit slug. It is validated server-side before every action. */
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  /** Account alias supplied by the agent when adding a second account. */
  alias?: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
  /** Stop ended the turn this card paused: it offers no action, and a
   * connection made afterwards is kept but continues nothing. */
  stopped?: boolean;
}

export interface SecretRequestCardData {
  /** Fixed allowlisted credential id; never an arbitrary config path. */
  target: CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  phoneOperationId?: string;
  provided?: boolean;
  dismissed?: boolean;
  /** A newer request for the same credential replaced this card; it no
   * longer offers entry and cannot be provided or dismissed. */
  superseded?: boolean;
  resumed?: boolean;
  error?: string;
  /** Stop ended the turn this card paused: it offers no entry, and a key
   * saved afterwards is kept but continues nothing. */
  stopped?: boolean;
}

/** A bot asked the person to sign in to a website themselves: they type the
 * password into the page, or save a login the server fills for the bot. The
 * bot never sees the password either way. */
export interface SignInRequestCardData {
  /** The page to open, an http(s) address. */
  url: string;
  /** Its host, the card's headline. */
  site: string;
  /** The bot's own words: why it needs the sign-in. */
  reason?: string;
  /** Where the login has to happen: the place the asking turn worked in. */
  place: Surface;
  done?: boolean;
  cancelled?: boolean;
  /** A newer request for the same site in this conversation replaced this
   * card; it no longer offers Done or Cancel. */
  superseded?: boolean;
  /** Answered by saving a login: the site it was saved for (and a sign-in
   * host on another site the person confirmed), which the bot then fills
   * with fill_login. */
  savedLogin?: string;
  resumed?: boolean;
  error?: string;
  /** Stop ended the turn this card paused: it offers no Done or Cancel,
   * and an answer given afterwards is kept but continues nothing. */
  stopped?: boolean;
}

/** The open sign-in request a bot's computer plea stands for, so whichever
 * panel shows the plea can settle that card. */
export interface ComputerHelpRef {
  /** The asking bot: a team computer's plea reaches every member's panel. */
  botId: string;
  threadId: string;
  messageId: string;
  site: string;
  place: Surface;
}

/** Who answers a room message nobody was @mentioned in. `auto` asks the
 * decision model and falls back to `fallbackBotId` (else the first member)
 * whenever it is off or unsure. Readers must treat any kind they do not know
 * as the default lead. */
export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" }
  | { kind: "auto"; fallbackBotId?: string };

/** One independent conversation inside a user-created channel. */
export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  /** The person pinned this channel thread above the update-ordered list. */
  pinned?: boolean;
  /** This conversation's own turn ceiling, in whole minutes. Absent uses
   * the global group turn limit. Direct chats do not use this ceiling. */
  turnTimeoutMinutes?: number;
  /** Epoch ms of the newest message, or createdAt when the thread has none. */
  updatedAt?: number;
  lastThreadOrderAt?: number;
  /** The first message already drove a title attempt for this thread, so a
   * later one does not rename a room the person may have retitled. */
  titleFromFirstMessage?: true;
  /** Whether a turn is actively running in this thread. */
  working?: boolean;
  /** The member bot currently speaking or generating in this thread, if any. */
  busyBotId?: string | null;
}

/** A room as a client may see it: the record plus the computed working flag. */
export interface WireGroup {
  /** Computed from the usage ledger, not stored in groups.json. */
  usage?: GroupThreadUsage | null;
  /** transient: each member's context in the active thread, from its last
   * turn there, and whether its next turn there was asked to start
   * compacted. */
  memberContext?: Record<string, { tokens: number; window: number; compactRequested?: true }> | null;
  id: string;
  /** The active task's thread. Direct-message channels stay single-threaded. */
  threadId: string;
  /** User-created channels have independent tasks, newest first. */
  tasks?: GroupTask[];
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  /** The room's shared instructions. */
  bulletin: string;
  /** Short one-line description shown under the room name; distinct from
   * the bulletin (long-form instructions) and any member bot's title.
   * null = explicitly cleared, so a client's shallow merge drops a stale value. */
  description?: string | null;
  unread: boolean;
  /** The newest message on screen the last time the person read this
   * conversation. The New divider goes after it. */
  lastReadMessageId?: string;
  createdAt: number;
  /** true for auto-created bot-bot channels. */
  dm?: boolean;
  /** transient: the member currently running a turn. */
  busyBotId?: string | null;
  /** transient: when the busy member's turn started; never persisted. */
  turnStartedAt?: number;
  /** the room's shared desk; absent = each member's own default. */
  cwd?: string;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under. */
  section?: string;
  /** New user-created rooms start with setup pending. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** The narrowest audience this room has ever had: a bot leaving never
   * widens who may see the transcript. Sent to admins only. */
  audienceFloor?: BotVisibility;
  /** True while any member (or hand-off) is mid-turn. Computed at
   * projection time, never persisted. */
  working: boolean;
  /** A direct-message channel's turn ceiling. Null on the wire means the
   * global group limit. Channel conversations store theirs on each task. */
  turnTimeoutMinutes?: number | null;
  /** Members the person stopped in this room ("stop @Bot"), by bot id. A
   * held member gets no turn until it is @mentioned again or resumed. */
  holds?: Record<string, RoomHold>;
  /** Room messages addressed to a member while it was held, by bot id;
   * its next turn is shown them, then they are cleared. */
  heldMessages?: Record<string, RoomHeldMessage[]>;
  /** transient: who waits in each of the room's threads, and on whom; absent or empty when nobody waits. */
  queue?: RoomQueueEntry[];
}

export interface RoomQueueEntry {
  botId: string;
  threadId: string;
  state: "running" | "queued";
  /** 1-based place in that thread's line; `of` counts the whole line. */
  position: number;
  of: number;
  /** Who a queued member waits on: the member running now, else the one speaking (or the one ahead). */
  waitingForBotId?: string;
  assignmentId?: string;
}

/** One member's hold in a room: when the person stopped it, and whether the
 * room has already said so (the held line is written once per hold). */
export interface RoomHold {
  at: number;
  noted?: boolean;
}

/** A room message that reached a member while it was held. */
export interface RoomHeldMessage {
  threadId: string;
  messageId: string;
}

/** Why a steer-queue entry waits: a shared thread slot, or the bot's room
 * turn (which runs one at a time per bot). */
export type SteerQueueReason = "capacity" | "group-turn";

/** Pending steer-queue chips, as `queuedSteerSnapshot` emits them and the
 * `bot.queued` frame carries them: threadId → queued items. */
export type BotQueuedMessages = Record<string, Array<{ queueId: string; text: string; reason?: SteerQueueReason }>>;

/** Skills library browse surface: one row per library entry, with the bots
 * currently assigned to it. Version is null for locally imported skills. */
export interface SkillsLibrarySkillWire {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  tags: string[];
  version: string | null;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  assignedBots: Array<{ id: string; name: string }>;
}

/** PUT body for a bot's assignment list: the full list, applied
 * idempotently. */
export interface BotAssignedSkillsWire {
  skills: string[];
}

export type ServerFrame =
  | { kind: "sections"; sections: string[] }
  | { kind: "bot.queued"; queues: BotQueuedMessages }
  | { kind: "message"; threadId: string; message: WireMessage }
  | { kind: "message.patch"; threadId: string; message: WireMessage }
  | { kind: "thread"; threadId: string; activeLeafId: string }
  | { kind: "bot"; bot: WireBot }
  | { kind: "group"; group: WireGroup }
  | { kind: "notify"; notification: NotificationLogEntry }
  | { kind: "notifications.read"; threadId: string; ids: string[] }
  | { kind: "group.deleted"; groupId: string }
  | { kind: "routine"; routine: Routine }
  | { kind: "routine.deleted"; routineId: string }
  | { kind: "routine.run"; run: RoutineRun }
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "app-trigger"; botId: string; trigger: AppTrigger }
  | { kind: "app-trigger.attempt"; botId: string; attempt: AppEventAttempt }
  | { kind: "app-trigger.deleted"; triggerId: string }
  | { kind: "app-trigger.service"; service: AppTriggerService }
  | { kind: "runtime"; event: RuntimeEvent }
  /** `surface` names what the frame shows: the bot's desktop (`computer`) or its built-in browser. */
  | { kind: "screen"; botId: string; threadId: string; png: string; mime?: string; surface?: "browser" | "computer" }
  /** A bot's computer is being set up or woken for a turn; the chat shows
   * one progress line until its first screen frame. `place` names a cloud
   * computer (absent: a Local VM). */
  | { kind: "computer"; botId: string; state: "provisioning" | "waking"; place?: "cloud" }
  | { kind: "computer-control"; botId: string; held: boolean; helpReason: string | null; help?: ComputerHelpRef | null }
  /** A bot's data sheet changed. Whole sheet each time. */
  | DataBroadcast
  | { kind: "bot.deleted"; botId: string }
  /** The whole fleet in its new order (PUT /api/bots/order); a member is sent only the bots they see. */
  | { kind: "bots.order"; botIds: string[] }
  | { kind: "live.call"; botId: string; threadId: string; call: LiveCallState | null }
  /** The config status object spread flat into the frame. */
  | ({ kind: "config" } & Record<string, unknown>);

/** The client-visible wire model: the exact shapes the server serializes
 * for tasks, bots, messages, and rooms. One home so the server records, the
 * desktop client, and (later) the mobile trees cannot drift apart.
 *
 * Phase A rule: a field here is a promise that the server emits it, byte
 * for byte, in every response and SSE frame that carries the shape. Server
 * records extend these interfaces and keep their private extras in
 * server/store.ts; the wire projection is typed so a new server field
 * fails compilation until it is either declared here or explicitly listed
 * as server-private. */
import type { ApprovalMode } from "./approval-mode.ts";
import type { BotAvatarCrop } from "./bot-avatar.ts";
import type { MascotBodyId } from "./mascot-bodies.ts";
import type { CredentialTargetId } from "./credential-request.ts";
import type { TeamSetupRequest } from "./team-setup.ts";
import type { RoutineRequestCardData } from "./routine-request.ts";
import type { ProfileRequestCardData } from "./profile-request.ts";
import type { SkillRequestCardData } from "./skill-request.ts";
import type { QuestionRequestCardData } from "./ask-question.ts";
import type { RoutineRunCardData } from "./routine-run.ts";
import type { GroupGoalRunCardData } from "./group-goal-run.ts";
import type { RuntimeEvent } from "./runtime-events.ts";
import type { Notification } from "./notification.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { WebhookAttempt, WebhookTrigger } from "./webhooks.ts";

/** Reasoning-effort levels, ascending. A union of everything any engine
 * accepts; each driver declares the subset its CLI will take. Lives here
 * because it is part of ModelSelection, which rides the wire. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrow untrusted API/config input before it becomes a model selection. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** "Which model" is a data value carried on the request, never a service
 * binding. instanceId is the routing key. */
export interface ModelSelection {
  instanceId: string;
  model: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
  /** Explicit model-specific variant. Omitted leaves the native session alone. */
  variant?: string;
}

/** Which cloud computer backs computer: "cloud"; absent means Box. */
export type CloudBackend = "box" | "vps";

/** A place a bot can act. cloud covers both cloud backends — from the
 * person's seat they are the same "cloud computer" panel. */
export type Surface = "cloud" | "vm" | "local" | "browser";

export type MausColor =
  | "green" | "blue" | "red" | "orange" | "purple" | "cyan" | "pink"
  | "yellow" | "teal" | "coral";

/** The face a bot rests on, as one of the engine's state names. Kept as a
 * plain string rather than a union: bots saved under the app's earlier
 * ten-face vocabulary still carry those names. */
export type MausExpression = string;

/** What the bot is doing right now, as the harness sees it. */
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";

/** The bot that opened a thread on itself or a teammate. */
export interface TaskOpenedBy {
  botId: string;
  name: string;
  delegationId?: string;
  /** What kind of conversation the opener made this: "pair" is the one
   * durable conversation between two bots; "work" closes itself once its
   * result has been reported. */
  kind?: "pair" | "work";
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
  /** cached share of input (context the model re-read); absent on records
   * from builds before it was tracked */
  cachedInput?: number;
  /** null until any turn reported a cost — most engines never do */
  costUsd: number | null;
  turns: number;
  /** the most recent settled turn on its own */
  lastTurn?: { input: number; output: number; cachedInput?: number; costUsd: number | null };
  /** what filled the model's window on the last model call, and the window's size when known */
  context?: { tokens: number; window?: number };
}

/** One task = one conversation with its own context, thread and provider
 * session. Wire form: no resumeCursors or lastInstanceId — the harness's
 * own bookkeeping that no client has ever used. */
export interface WireTask {
  threadId: string;
  title: string;
  createdAt: number;
  /** Organizational grouping only; never a directory or provider context. */
  projectId?: string;
  /** Detached routine execution, reachable through its visible results card. */
  routineRunId?: string;
  /** Set when a bot, not a person, opened this thread. */
  openedBy?: TaskOpenedBy;
  /** Set by close_thread; absent while the thread is open. */
  closedBy?: TaskClosedBy;
  /** When the person archived this thread. Absent = unarchived. */
  archivedAt?: number;
  /** Defaults are copied when a task is created. */
  modelSelection?: ModelSelection;
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  unread?: boolean;
  /** true after an edit/branch-switch rewound the visible conversation. */
  rewound?: boolean;
  pinnedMessageId?: string;
  /** Runtime-only state, reset on load and never persisted. */
  activity?: BotActivity;
  busy?: boolean;
  /** Epoch ms when this task's current busy stretch began — the chat anchors
   * its elapsed readout here, so the count survives thread switches. Stamped
   * by setTaskActivity on an idle→busy transition; runtime-only like busy. */
  turnStartedAt?: number;
  /** Where this conversation works when pinned; absent = follow the bot. */
  surface?: Surface;
  /** what this task has spent, banked once per turn */
  usage?: TaskUsage;
  /** the folder this task's turns run in, pinned on its first turn. */
  cwd?: string | null;
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

/** Listing provenance and connector intent retained for package details
 * and future re-export. It never means the apps are authorized. */
export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
}

/** A bot as a client may see it. Wire form: no provider session
 * bookkeeping (resumeCursors), no elevation journal (approvalGrant), no
 * settlement receipts (lastProfileRequestId, lastTeamSetupReceipt); the
 * projected tasks are WireTask[] and avatarUrl is always present
 * (null when the bot has none). */
export interface WireBot {
  id: string;
  /** The task selected in the UI; running turns keep their own thread id. */
  threadId: string;
  /** every task this bot has, newest first, projected like wireTask */
  tasks?: WireTask[];
  /** Projects group this bot's threads; older bots have no projects. */
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
  mascotBody?: MascotBodyId | null;
  /** App-owned attachment served as this bot's custom profile image;
   * always present on the wire, null when the bot has none. */
  avatarUrl: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  /** True when any task has unread output. */
  unread: boolean;
  /** Default for new tasks; navigating tasks never changes this value. */
  modelSelection: ModelSelection;
  /** where the bot works ("Works on"). Unset = auto. */
  computer?: Surface | "off";
  /** Which cloud computer backs computer: "cloud"; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Auto mode may prepare/start this bot's managed VPS container. */
  autoStartVps?: boolean;
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
  /** This bot's own voice id, so a room of bots doesn't sound like one person. */
  voice?: string;
  /** Queue direct-chat messages behind outstanding delegated work. */
  parkDirectMessages?: boolean;
  /** true after an edit/branch-switch rewound the visible conversation. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** The coordinator for this bot's sidebar section. */
  chiefOfStaff?: boolean;
  /** Owner-selected additional teams this Chief may coordinate. */
  managedSections?: string[];
  /** Pause for human approval before this bot talks to a peer. */
  approvePeerComms?: boolean;
  /** Bot ids this bot is allowed to contact. */
  peers?: string[];
  /** Whether this bot may use the workspace's connected apps. */
  composio?: boolean;
  /** Whether this bot gets the app's built-in browser. */
  browser?: boolean;
  /** Which of the app-wide MCP servers this bot mounts, by name. */
  mcpServers?: string[];
  /** Id of a named browser profile; absent = the bot's own private session. */
  browserProfile?: string;
  /** Public, package-authored playbooks installed for this bot. */
  playbooks?: InstalledPlaybook[];
  /** Listing provenance for package details and future re-export. */
  installedPackage?: InstalledPackageMetadata;
  /** Aggregate of task and room activity; transient, reset on load. */
  busy?: boolean;
  /** What the bot is doing right now; transient like busy. */
  activity?: BotActivity;
  createdAt: number;
}

/** One transcript line. Serialized as stored — the durable delivery
 * identity (roomRequest) rides the wire unchanged. */
export interface WireMessage {
  roomRequest?: { id: string; phase: "request" | "result" };
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "goal.run";
  text?: string;
  /** Durable provider output stored by the harness; renderers receive only
   * the allowlisted /api/attachments URL. */
  attachments?: Array<{ kind: "image"; path: string; mime: string }>;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** One idempotently updated status card for a routine run. */
  routineRun?: RoutineRunCardData;
  /** Terminal receipt for a bounded multi-bot channel goal. */
  goalRun?: GroupGoalRunCardData;
  /** activity messages: tool name + outcome. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean; terminal?: boolean; summary?: string; input?: string; output?: string };
  /** user messages sent INTO a running turn (capabilities.queueing). */
  steered?: boolean;
  /** A user-role message that arrived through the server's HTTP API. */
  via?: "api";
  /** Provider turn that produced this message. */
  turnId?: string;
  /** The last assistant text item from a settled provider turn. */
  turnTerminal?: boolean;
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
  /** Set on the user-role line another bot delivered into this bot's own
   * conversation (ask_bot, start_thread). */
  peerAsk?: { botId: string; name: string; unattended?: boolean };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X", linking to the bot-bot channel. */
  comm?: { groupId: string; threadId?: string; withBotId: string; withName: string; withColor: string };
  /** thread chips: "Opened thread #Title on @X". */
  threadRef?: { botId: string; threadId: string; title: string };
  /** user messages waiting in the steer-queue while the bot is mid-turn. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. */
  queueId?: string;
}

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  /** What was actually answered, when the answer is words rather than a
   * verdict. */
  answeredText?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission cards: the tool being requested. */
  tool?: string;
  /** why this card is waiting: guard, mode, sandbox or delivery error. */
  held?: string;
  /** Catalog key for held when it is one of the fixed notes. */
  heldCode?: string;
  /** the narrow grant "always allow" remembers for a harness-native card. */
  allowKey?: string;
  /** the provider can remember an allow for the rest of its session. */
  allowSession?: boolean;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** A durable chat-created routine proposal. */
  routineRequest?: RoutineRequestCardData;
  /** A durable profile-change proposal (propose_profile). */
  profileRequest?: ProfileRequestCardData;
  teamSetupRequest?: TeamSetupRequest;
  /** A durable learned-skill proposal. */
  skillRequest?: SkillRequestCardData;
  /** A provider's structured question set. */
  questionRequest?: QuestionRequestCardData;
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
  resumed?: boolean;
  error?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** One independent conversation inside a user-created channel. */
export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

/** A room as a client may see it: the record plus the computed working
 * flag (publicGroupState). */
export interface WireGroup {
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
  unread: boolean;
  createdAt: number;
  /** true for auto-created bot-bot channels. */
  dm?: boolean;
  /** transient: the member currently running a turn. */
  busyBotId?: string | null;
  /** transient: when the busy member's turn started, for the elapsed
   * readout — the group-side twin of a task's turnStartedAt, stamped on
   * every transition into a busy speaker (never persisted) */
  turnStartedAt?: number;
  /** the room's shared desk; absent = each member's own default. */
  cwd?: string;
  /** Compatibility mirror of the active task's pinned folder. */
  pinnedCwd?: string | null;
  /** Compatibility mirror of the active task's pinned message. */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under. */
  section?: string;
  /** New user-created rooms start with setup pending. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** True while any member (or hand-off) is mid-turn. Computed at
   * projection time, never persisted. */
  working: boolean;
}

// ── live wire frames ───────────────────────────────────────────────────
// Derived from the client's frame switch (src/state/store.tsx handleFrame)
// cross-checked against every server broadcast site: one member per kind
// the app consumes, payload typed by the shape that actually goes over the
// wire. Transport-owned frames (hello, ping) stay in src/lib/live-events.

/** Pending steer-queue chips, as `queuedSteerSnapshot` emits them and the
 * `bot.queued` frame carries them: threadId → queued items. */
export type BotQueuedMessages = Record<string, Array<{ queueId: string; text: string; reason?: "capacity" }>>;

export type ServerFrame =
  | { kind: "sections"; sections: string[] }
  | { kind: "bot.queued"; queues: BotQueuedMessages }
  | { kind: "message"; threadId: string; message: WireMessage }
  | { kind: "message.patch"; threadId: string; message: WireMessage }
  | { kind: "thread"; threadId: string; activeLeafId: string }
  | { kind: "bot"; bot: WireBot }
  | { kind: "group"; group: WireGroup }
  | { kind: "notify"; notification: Notification }
  | { kind: "group.deleted"; groupId: string }
  | { kind: "routine"; routine: Routine }
  | { kind: "routine.deleted"; routineId: string }
  | { kind: "routine.run"; run: RoutineRun }
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "runtime"; event: RuntimeEvent }
  | { kind: "screen"; botId: string; threadId: string; png: string; mime?: string }
  | { kind: "computer"; botId: string; state: "provisioning" | "waking" }
  | { kind: "computer-control"; botId: string; held: boolean; helpReason: string | null }
  | { kind: "bot.deleted"; botId: string }
  /** The config status object spread flat into the frame; its full typing
   * is the deferred client-model extraction (see j1-phase-bc-progress). */
  | ({ kind: "config" } & Record<string, unknown>);

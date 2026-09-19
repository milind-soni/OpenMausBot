// The store's domain model: bots, threads, messages, tasks, groups, and the
// config/engine surfaces they carry. Pure types and helpers only — no React,
// no provider, no action union. reducer.ts and store.tsx both build on it.

import type { CloudBackend, EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";
import type { MausColor } from "@/lib/mascot";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import type { ApprovalMode } from "../../shared/approval-mode";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { QuestionRequestCardData } from "../../shared/ask-question";
import type { ProfileRequestCardData } from "../../shared/profile-request";
import type { RoutineRequestCardData } from "../../shared/routine-request";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { SkillRequestCardData } from "../../shared/skill-request";
import type { OnboardingStatus } from "@/lib/onboarding";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  /** what each option means, keyed by its label — a question that came with
   * explanations (AskUserQuestion) shows them under the buttons. Kept beside
   * `options` rather than inside it so every existing reader of the plain
   * label list — the phone, call-mode narration, the sidebar preview — keeps
   * working untouched. */
  optionHints?: Record<string, string>;
  /** the question takes more than one option; `answered` is then the chosen
   * labels joined with ", ", which is the format the asking tool expects */
  multiSelect?: boolean;
  answered?: string;
  /** The words an answered question card was answered with — `answered`
   * only holds the behavior once the server settles a live ask. */
  answeredText?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** catalog key for `held` when it is a fixed note, so it reads in the
   * viewer's language; absent for free-text errors and older cards */
  heldCode?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  allowSession?: boolean;
  approvalScope?: "local-computer";
  /** Persisted proposal used by the server when the user confirms it. */
  routineRequest?: RoutineRequestCardData;
  /** Staged learned-skill change; applied only after the user confirms this card. */
  skillRequest?: SkillRequestCardData;
  /** Persisted profile proposal used by the server when the user confirms it. */
  profileRequest?: ProfileRequestCardData;
  teamSetupRequest?: import("../../shared/team-setup").TeamSetupRequest;
  /** The model's own questions and options (Claude's AskUserQuestion), so
   * the card offers choices instead of an unanswerable Allow/Deny. */
  questionRequest?: QuestionRequestCardData;
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  alias?: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  target: import("../../shared/credential-request").CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "goal.run";
  text?: string;
  /** Provider-generated files attached to this assistant response. */
  attachments?: Array<{ kind: "image"; path: string; mime: string }>;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  /** Lifecycle mirror for a routine whose real work lives in a fresh task. */
  routineRun?: RoutineRunCardData;
  /** Durable lifecycle receipt for a goal-driven channel run. */
  goalRun?: GroupGoalRunCardData;
  /** How a channel user message should be handled. Absent means ordinary chat. */
  channelMode?: "chat" | "goal";
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying.
   * `summary` is the call's input on one redacted line (the shell command). */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean; summary?: string; input?: string; output?: string };
  /** user messages sent into a running turn — the model saw it mid-turn */
  steered?: boolean;
  /** a user message that arrived through the server's API, not typed here */
  via?: "api";
  /** Provider turn that produced this message. */
  turnId?: string;
  /** Last assistant text item from a settled provider turn. */
  turnTerminal?: boolean;
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Flat reply reference for an inline quote; unrelated to branch ancestry. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: MausColor };
  /** a user-role line another bot delivered into this conversation
   * (ask_bot, delegate_bot, start_thread): the words are that bot's, not
   * the person's. Rendered as the peer speaking — see lib/peer-message. */
  peerAsk?: { botId: string; name: string; unattended?: boolean };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; threadId?: string; withBotId: string; withName: string; withColor: MausColor };
  /** thread chips: "Opened thread #Title on Bot" linking to that thread */
  threadRef?: { botId: string; threadId: string; title: string };
  /** sent while the bot was mid-turn; auto-sends when the turn settles.
   * Rendered only while the bot is busy, so a flag stranded by a server
   * restart never shows a promise nothing will keep. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. Pending chips
   * match on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** A room: several bots + you in one shared thread. */
export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  /** when the busy member's turn started — the group-side twin of a task's
   * turnStartedAt; stamped by the server when the speaker claims the turn */
  turnStartedAt?: number | null;
  /** True for the whole orchestrated run, including hand-offs between members. */
  working?: boolean;
  /** the room's shared desk — where member turns run their shell tools,
   * overriding each member's own folder; absent = each member's own */
  cwd?: string;
  /** folder the room's turns actually run in, pinned on the first turn;
   * null = each member's own default; absent = not pinned yet */
  pinnedCwd?: string | null;
  /** the one message pinned to the top of this room's transcript */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under (shared with bots) */
  section?: string;
  /** New user-created rooms remain in setup until Save or Skip. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** Separate conversations in this channel. DMs deliberately stay on one
   * thread and omit this collection. */
  tasks?: GroupTask[];
  messages: Message[];
}

/** One of a channel's independent conversations. The channel's threadId
 * points at the active one; folder and pin state belong to the task. */
export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  variant?: string;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  /** Internal routine execution; reachable through its run receipt, not history menus. */
  routineRunId?: string;
  projectId?: string;
  title: string;
  createdAt: number;
  /** what this task has spent, banked once per settled turn */
  usage?: TaskUsage;
  /** folder this task's turns run in, pinned on its first turn; null =
   * legacy home-folder session; absent = not pinned yet */
  cwd?: string | null;
  modelSelection?: ModelSelection;
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  activity?: Bot["activity"];
  busy?: boolean;
  /** Epoch ms when this task's current turn became busy; the chat's elapsed
   * readout anchors here so it survives thread switches. Absent while idle. */
  turnStartedAt?: number;
  unread?: boolean;
  pinnedMessageId?: string;
  /** where this conversation works, when pinned: by the person from the
   * composer, or by its first Auto turn to the place it reached. Wins over
   * the bot's Works on (except Off); absent = follows the bot. */
  surface?: "cloud" | "vm" | "local" | "browser";
  /** set when a bot (not the person) started this thread — its own or a
   * teammate's; the sidebar shows a quiet "opened by <name>" under the title */
  openedBy?: ThreadOpener;
  /** set when a bot closed this thread with close_thread; the sidebar folds
   * it out of the default list (still under "show all", never deleted) and
   * the server clears it when a new turn starts there */
  closedBy?: ThreadCloser;
  /** when the person archived this thread: out of the default list, still
   * under show-all and search, and back the moment it needs them again;
   * absent = never archived. Syncs like every other task field. */
  archivedAt?: number;
}

/** The bot that opened a thread on itself or a teammate. */
export interface ThreadOpener {
  botId: string;
  name: string;
  delegationId?: string;
  at: number;
}

/** The bot that closed a thread it opened (or one of its own). */
export interface ThreadCloser {
  botId: string;
  name: string;
  at: number;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** cached share of `input` (context the model re-read); absent on records
   * from builds before it was tracked */
  cachedInput?: number;
  /** null until any turn reported a cost — most engines never do; records
   * from builds before cost existed lack the field entirely */
  costUsd: number | null;
  turns: number;
  /** the most recent settled turn on its own */
  lastTurn?: { input: number; output: number; cachedInput?: number; costUsd: number | null };
  /** what filled the model's window on the last model call, and the window's size when known */
  context?: { tokens: number; window?: number };
}

export interface Bot {
  id: string;
  threadId: string;
  /** When the bot was created (wire bots always carry it); used for fallback task timestamps. */
  createdAt?: number;
  /** every context this bot has, newest first */
  tasks?: Task[];
  projects?: BotProject[];
  name: string;
  title: string;
  description: string;
  /** Standing instructions (SOUL.md). Canonical on the server; the file is a mirror. */
  soul?: string;
  /** The SOUL.md mirror on disk differs from the record; the Soul editor offers apply/discard. */
  soulDrift?: boolean;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  /** Which body the bot wears. Unknown/absent values fall back to the cursor. */
  mascotBody?: MascotBodyId | null;
  /** App-owned image attachment used for this bot's profile. */
  avatarUrl?: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  busy?: boolean;
  /** what the bot is doing, as the harness sees it; busy is derived from it */
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  /** The selected thread's turn-start anchor (epoch ms) while busy, else null;
   * fed to the Thinking timer so elapsed time survives thread switches. */
  turnStartedAt?: number | null;
  modelSelection: ModelSelection;
  /** Where this bot works: a computer, only the built-in browser tab, or
   * nowhere; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Allow Auto to prepare/start the managed VPS container. Off by default. */
  autoStartVps?: boolean;
  /** where new tasks run their shell tools; absent = the private bot workspace */
  cwd?: string;
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** Explicit approval level; absent records use the legacy autoApprove bit. */
  approvalMode?: ApprovalMode;
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Sidebar section this bot renders under; absent = unsectioned. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** This sidebar section's primary coordinator. */
  chiefOfStaff?: boolean;
  /** Additional teams the owner explicitly lets this Chief work with. */
  managedSections?: string[];
  /** When this bot wants to talk to another bot (ask_bot/delegate_bot),
   * pause and ask the user first. Off by default. */
  approvePeerComms?: boolean;
  /** Explicit peer allow-list (bot ids); absent = every bot in its section,
   * `[]` = none. Read-only on the web today; here so the settings dialog can
   * refetch the overview when the server changes it. */
  peers?: string[];
  /** Whether this bot may use the workspace's connected apps. Unset means
   * allowed for existing bots; imported bots start with this disabled. */
  composio?: boolean;
  /** Whether this bot gets the app's built-in browser (Browser tab). On unless switched off. */
  browser?: boolean;
  /** Which app-wide MCP servers (Plugins → MCP servers) this bot mounts, by
   * name. Absent = every enabled server; [] = none (null clears over PATCH). */
  mcpServers?: string[] | null;
  /** Named browser profile id (config.browserProfiles); absent/null = the
   * bot's own session (null is how a clear travels over PATCH). */
  browserProfile?: string | null;
  messages: Message[];
  /** Renderer-only: a deleted selection moved to a thread whose full
   * transcript has not arrived yet. Never carry the deleted chat into it. */
  awaitingThreadSnapshot?: boolean;
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

export interface BotProject {
  id: string;
  name: string;
  emoji?: string;
}

export type ProjectUpdatePatch = { name?: string; emoji?: string | null };

/** A conversation uses its own execution settings; the sidebar keeps the
 * original bot's aggregate presence and profile defaults. */
export function currentTaskBot(bot: Bot, threadId = bot.threadId): Bot {
  const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
  if (!task) return bot;
  return {
    ...bot,
    threadId,
    modelSelection: task.modelSelection ?? bot.modelSelection,
    approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? bot.approvalMode : undefined),
    autoApprove: task.autoApprove ?? bot.autoApprove,
    alwaysAllow: task.alwaysAllow ?? bot.alwaysAllow,
    activity: task.activity ?? bot.activity,
    busy: task.busy ?? (task.activity ? task.activity === "working" || task.activity === "waiting-on-you" : bot.busy),
    unread: task.unread ?? bot.unread,
    pinnedMessageId: task.pinnedMessageId,
    turnStartedAt: task.turnStartedAt ?? null,
  };
}

export type TaskUpdatePatch = Partial<Pick<Task, "modelSelection" | "approvalMode" | "autoApprove" | "pinnedMessageId">> & {
  confirmFullAccess?: boolean;
  acknowledgeLocalAuto?: boolean;
  updateBotDefault?: boolean;
  resetApprovalToAsk?: boolean;
  projectId?: string | null;
  archivedAt?: number | null;
  /** null = follow the bot's Works on again */
  surface?: Task["surface"] | null;
};

export function taskPatchFields(patch: TaskUpdatePatch): Partial<Task> {
  const { confirmFullAccess: _fullConsent, acknowledgeLocalAuto: _localAck, updateBotDefault: _modelDefault, resetApprovalToAsk, projectId, archivedAt, surface, ...fields } = patch;
  return { ...fields, ...(resetApprovalToAsk ? { approvalMode: "ask", autoApprove: false, alwaysAllow: [] } : {}),
    ...(projectId === undefined ? {} : { projectId: projectId ?? undefined }),
    ...(archivedAt === undefined ? {} : { archivedAt: archivedAt ?? undefined }),
    ...(surface === undefined ? {} : { surface: surface ?? undefined }) };
}

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** All versions of a user message (itself + the forks that replaced it),
 * oldest first. Length 1 = never edited. */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  anthropic?: { configured: boolean };
  openaiCompat?: { configured: boolean; url?: string };
  /** what this server is entitled to; Settings shows only what works here */
  edition?: { edition: "oss" | "enterprise"; features: string[] };
  /** a fleet agent exists on this server (Settings → Workspaces) */
  fleet?: { available: boolean };
  budgets?: { monthlyUsd?: number; warnAtPercent?: number };
  billing?: { currency?: string; prices?: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }> };
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  box: { configured: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  threads?: { maxConcurrentPerBot: number };
  localVm: { mode: "shared" | "per-bot"; maxInstances: number };
  opencodeGo?: { configured: boolean };
  /** Voice. `configured` = the engine has what it needs (an ElevenLabs or
   * Fish Audio key, or a Chatterbox server address); `ready` = that AND a voice, which is
   * what it takes to actually speak. The key itself is never echoed back;
   * `baseUrl`/`model` are Chatterbox settings, not credentials. */
  tts?: {
    configured: boolean;
    ready: boolean;
    voice: string;
    provider?: "elevenlabs" | "fish" | "system" | "chatterbox";
    baseUrl?: string;
    model?: string;
  };
  /** Shared write-only credential for on-demand GPT Image avatars. */
  imageGen?: {
    configured: boolean;
    provider?: "openai" | "xai" | "custom";
    model?: string;
    customUrl?: string;
    customModel?: string;
    openaiConfigured?: boolean;
    xaiConfigured?: boolean;
    customKeyConfigured?: boolean;
  };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
  /** UI language override; "" (or absent) follows the system language. */
  language?: string;
  /** Opt-in flags. Absent means off. */
  features?: { skillAuthoring: boolean; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean };
  /** First-run progress: whether the welcome tour was finished and which
   * one-time hints were dismissed. Server-owned so it follows the workspace. */
  onboarding?: OnboardingStatus;
  /** Which browser this server can give bots: the desktop app's surface, the
   * agent-browser engine, or nothing yet (with the reason). */
  browserEngine?: BrowserEngineSummary;
  /** Named browser sessions any bot can be pointed at. */
  browserProfiles?: BrowserProfile[];
}

export interface BrowserEngineSummary {
  kind: "engine" | "unavailable";
  reason?: string;
  installable?: boolean;
  version?: string;
  installing?: boolean;
  installError?: string;
}

export interface BrowserProfile {
  id: string;
  name: string;
  /** Read-only durable Electron routing inherited from legacy profiles.
   * Config PATCH payloads must omit it. */
  partitionId?: string;
}

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "composio" | "box" | "vps" | "rooms" | "threads" | "localVm" | "opencodeGo" | "tts" | "imageGen" | "profile" | "language" | "features" | "onboarding" | "browserEngine" | "browserProfiles" | "edition" | "budgets" | "billing"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    threads: frame.threads,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    imageGen: frame.imageGen,
    profile: frame.profile,
    language: frame.language,
    features: frame.features,
    onboarding: frame.onboarding,
    browserEngine: frame.browserEngine,
    browserProfiles: frame.browserProfiles,
    edition: frame.edition,
    budgets: frame.budgets,
    billing: frame.billing,
  };
}

/** How an engine gets installed — declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  managed?: { label: string; downloadBytes: number };
  /** the server can install or update this engine itself, no terminal */
  server?: { package: string };
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  /** Optional presentation override belonging to this instance, independent
   * of the driver that runs it. */
  icon?: import("../../shared/provider-icon").ProviderIcon;
  /** Company instances are owned by the desktop parent, never editable here. */
  readOnly?: boolean;
  managed?: { organizationId: string; organizationName: string };
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    account?: { email?: string; organization?: string; method?: "login" | "api-key" };
    version?: string | null;
    /** A newer provider version unlocks capabilities, but this installed
     * version and its current models remain usable. */
    update?: {
      title: string;
      message: string;
      command: string;
    };
    /** a reported cost on a subscription is notional; the UI says so */
    billing?: "metered" | "subscription";
    /** a standing condition worth a look, with nothing to run */
    warning?: {
      title: string;
      message: string;
    };
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; provider?: string; variants?: ModelVariantOption[] }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    modelVariants?: boolean;
    /** the engine keeps a live session and takes a message mid-turn */
    queueing?: boolean;
    localComputerMcp?: boolean;
    /** This engine can answer a bounded review prompt without changing the
     * bot's active conversation. */
    approvalReview?: boolean;
  };
  /** `custom` agents sit below the rail divider — no subscription catalog. */
  access?: "subscription" | "custom";
  /** `signOut`: the browser may remove the stored sign-in to switch accounts. */
  authentication?: { method: "device-code" | "paste-code" | "browser"; signOut?: boolean };
  install?: EngineInstall;
  /** Configured CLI path override — set ONLY when the user overrode it;
   * absent means the driver default is in effect. */
  cli?: string;
  /** Driver's default binary name (e.g. "claude"). */
  cliDefault?: string;
  /** Absolute paths of every default binary found on PATH, PATH order. */
  cliCandidates?: string[];
  /** Server-owned Claude profile; a saved directory does not prove sign-in. */
  claudeAccount?: { configDir: string; signInCommand: string; signInShell: "powershell" | "sh"; isDefault: boolean };
}

export type AppSettingsSection =
  | "general"
  | "desktopWorkspaces"
  | "organization"
  | "appearance"
  | "experimental"
  | "connections"
  | "engines"
  | "companion"
  | "remote"
  | "computer"
  | "usage"
  | "people"
  | "backups"
  | "workspaces";

export type BotSettingsSection =
  | "overview"
  | "identity"
  | "soul"
  | "skills"
  | "memory"
  | "routines"
  | "access"
  | "model"
  | "permissions"
  | "voice"
  | "history"
  | "usage";

export interface ModelVariantSession {
  instanceId: string;
  model: string;
  turnId: string;
  startedAt: string;
  acceptingUpdates: boolean;
  variants?: { options: ModelVariantOption[]; currentValue?: string };
}


export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

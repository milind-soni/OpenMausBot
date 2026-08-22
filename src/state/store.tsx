// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CloudBackend, EffortLevel } from "../../server/contracts.ts";
import type { MausColor, MausMotion } from "@/lib/mascot";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import { currentCall } from "@/lib/call";
import { showNotification, type NotificationTarget } from "@/lib/notify";
import { speaker } from "@/lib/tts";
import { createTeamActivationQueue } from "@/lib/team-activation";
import { firstVisibleSelection } from "@/lib/team-scope";
import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";

export type { MausColor } from "@/lib/mascot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  approvalScope?: "local-computer";
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector";
  text?: string;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  /** user messages sent into a running turn — the model saw it mid-turn */
  steered?: boolean;
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: MausColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: MausColor };
  /** sent while the bot was mid-turn; auto-sends when the turn settles.
   * Rendered only while the bot is busy, so a flag stranded by a server
   * restart never shows a promise nothing will keep. */
  queued?: boolean;
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
  /** the room's shared desk — where member turns run their shell tools,
   * overriding each member's own folder; absent = each member's own */
  cwd?: string;
  /** folder the room's turns actually run in, pinned on the first turn;
   * null = each member's own default; absent = not pinned yet */
  pinnedCwd?: string | null;
  /** the one message pinned to the top of this room's transcript */
  pinnedMessageId?: string;
  /** Sidebar team this room belongs to; absent = unassigned. */
  teamId?: string | null;
  messages: Message[];
}

export interface Team {
  id: string;
  name: string;
  createdAt: number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
  /** what this task has spent, banked once per settled turn */
  usage?: TaskUsage;
  /** folder this task's turns run in, pinned on its first turn; null =
   * legacy home-folder session; absent = not pinned yet */
  cwd?: string | null;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** null until any turn reported a cost — most engines never do; records
   * from builds before cost existed lack the field entirely */
  costUsd: number | null;
  turns: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** every context this bot has, newest first */
  tasks?: Task[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  /** App-owned image attachment used for this bot's profile. */
  avatarUrl?: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  busy?: boolean;
  /** what the bot is doing, as the harness sees it; busy is derived from it */
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  modelSelection: ModelSelection;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** where new tasks run their shell tools; absent = the private bot workspace */
  cwd?: string;
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
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
  /** Sidebar team this bot belongs to; absent = unassigned. */
  teamId?: string | null;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** The workspace's one primary coordinator. */
  chiefOfStaff?: boolean;
  /** When this bot wants to talk to another bot (ask_bot/delegate_bot),
   * pause and ask the user first. Off by default. */
  approvePeerComms?: boolean;
  /** Whether this bot may use the workspace's connected apps. Unset means
   * allowed for existing bots; imported bots start with this disabled. */
  composio?: boolean;
  messages: Message[];
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
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
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  box: { configured: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  localVm: { mode: "shared" | "per-bot"; maxInstances: number };
  opencodeGo?: { configured: boolean };
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: { configured: boolean; ready: boolean; voice: string };
  /** Shared write-only credential for on-demand GPT Image avatars. */
  imageGen?: { configured: boolean };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
}

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "composio" | "box" | "vps" | "rooms" | "localVm" | "opencodeGo" | "tts" | "imageGen" | "profile"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    imageGen: frame.imageGen,
    profile: frame.profile,
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
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
    /** a reported cost on a subscription is notional; the UI says so */
    billing?: "metered" | "subscription";
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    /** the engine keeps a live session and takes a message mid-turn */
    queueing?: boolean;
    localComputerMcp?: boolean;
  };
  /** `custom` agents sit below the rail divider — no subscription catalog. */
  access?: "subscription" | "custom";
  install?: EngineInstall;
  /** Configured CLI path override — set ONLY when the user overrode it;
   * absent means the driver default is in effect. */
  cli?: string;
  /** Driver's default binary name (e.g. "claude"). */
  cliDefault?: string;
  /** Absolute paths of every default binary found on PATH, PATH order. */
  cliCandidates?: string[];
}

export type AppSettingsSection =
  | "general"
  | "connections"
  | "engines"
  | "companion"
  | "computer"
  | "usage";

export interface AppState {
  bots: Bot[];
  groups: Group[];
  teams: Team[];
  /** null = All bots. */
  activeTeamId: string | null;
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "routines";
  routines: Routine[];
  routineRuns: RoutineRun[];
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  /** the per-thread event inspector (runtime stream + native protocol tee) */
  inspectorOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  /** who is driving each bot's computer: held = the person has the wheel
   * (the bot's hands are refused server-side); helpReason = the bot's open
   * plea for the person to take over */
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  /** a search hit to scroll to once its thread is on screen; nonce lets the
   * same message be focused twice in a row */
  focusMessage: { threadId: string; messageId: string; nonce: number; consumed: boolean } | null;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

export type Action =
  | {
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      teams?: Team[];
      activeTeamId?: string | null;
      computerControl: Record<string, { held: boolean; helpReason: string | null }>;
    }
  | { type: "teamsHydrated"; teams: Team[]; activeTeamId: string | null }
  | { type: "teamsListed"; teams: Team[] }
  | { type: "createTeam"; name: string }
  | { type: "renameTeam"; teamId: string; name: string }
  | { type: "deleteTeam"; teamId: string }
  | { type: "setActiveTeam"; teamId: string | null }
  | { type: "showRoutines" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string; teamId?: string }
  | { type: "sendGroup"; groupId: string; text: string }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder" | "pinnedMessageId">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "toggleReaction"; threadId: string; messageId: string; emoji: string }
  | { type: "interruptGroup"; groupId: string }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string }
  | { type: "editMessage"; botId: string; messageId: string; text: string }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** remember this exact grant (the server's allowKey) for the bot */
      alwaysAllow?: { botId: string; key: string };
    }
  | { type: "newTask"; botId: string }
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "focusMessage"; threadId: string; messageId: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: NotificationTarget,
  state: Pick<AppState, "bots" | "groups">,
) {
  // A room's approval/question notification carries the asker bot with the
  // GROUP's thread id; asking the bot to switch to that thread would 404.
  // Open the room itself. A thread that is neither a room nor one of the
  // bot's own lands on a plain bot select instead of an error banner.
  const group = state.groups.find((candidate) => candidate.threadId === target.threadId);
  if (group) {
    dispatch({ type: "select", id: group.id });
    return;
  }
  dispatch({ type: "select", id: target.botId });
  const bot = state.bots.find((candidate) => candidate.id === target.botId);
  if (!bot) return;
  const known =
    bot.threadId === target.threadId ||
    (bot.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (known) dispatch({ type: "switchTask", botId: target.botId, threadId: target.threadId });
}

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const teams = action.teams ?? state.teams;
      const activeTeamId = action.activeTeamId !== undefined ? action.activeTeamId : state.activeTeamId;
      const selectedId = firstVisibleSelection(action.bots, action.groups, activeTeamId, state.selectedId);
      return {
        ...state,
        bots: action.bots,
        groups: action.groups,
        teams,
        activeTeamId,
        computerControl: action.computerControl,
        selectedId,
      };
    }
    case "teamsHydrated": {
      const selectedId = firstVisibleSelection(state.bots, state.groups, action.activeTeamId, state.selectedId);
      return { ...state, teams: action.teams, activeTeamId: action.activeTeamId, selectedId };
    }
    case "teamsListed":
      return { ...state, teams: action.teams };
    case "setActiveTeam": {
      const selectedId = firstVisibleSelection(state.bots, state.groups, action.teamId, state.selectedId);
      return { ...state, activeTeamId: action.teamId, selectedId, activeView: "chat" };
    }
    case "createTeam":
    case "renameTeam":
    case "deleteTeam":
      return state;
    case "showRoutines":
      return {
        ...state,
        activeView: "routines",
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: action.runs };
    case "routinePatched": {
      const exists = state.routines.some((routine) => routine.id === action.routine.id);
      return {
        ...state,
        routines: exists
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return { ...state, routineRuns: runs.sort((a, b) => b.scheduledFor - a.scheduledFor) };
    }
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
    case "groupPatched": {
      const exists = state.groups.some((g) => g.id === action.group.id);
      const groups = exists
        ? state.groups.map((g) => (g.id === action.group.id ? { ...g, ...action.group, messages: action.group.messages ?? g.messages } : g))
        : [{ ...(action.group as Group), messages: action.group.messages ?? [] }, ...state.groups];
      return { ...state, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        withMascotMotion({ ...state, activeView: "chat", selectedId: action.id }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
    }
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, { answered: action.answer }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "decideRequest":
      return state; // the server's request.resolved patch settles the card
    case "botAdded":
      return withMascotMotion({
        ...state,
        // An HTTP create/import response and its SSE broadcast can race. Fold
        // both paths without ever showing the same bot twice.
        bots: [action.bot, ...state.bots.filter((bot) => bot.id !== action.bot.id)],
        activeView: "chat",
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      // Bot frames are complete except for their transcript. An unknown one
      // was created by another client (the phone, another app window, or a
      // team import), so add it now; the following message frames will fill
      // its greeting without waiting for a full-page hydration.
      if (!before) {
        return {
          ...state,
          bots: [{ ...action.bot, messages: action.bot.messages ?? [] }, ...state.bots],
        };
      }
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const animated = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      const next = action.bot.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.bot.id ? b : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const switchedThread =
        typeof action.bot.threadId === "string" && action.bot.threadId !== before.threadId;
      const patched = updateBot(next, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        // Ordinary bot patches omit messages and must preserve the current
        // transcript. A task switch is different: its full bot event carries
        // the new transcript, which must replace the previous task before the
        // webhook's streamed messages begin arriving.
        messages:
          switchedThread && Array.isArray(action.bot.messages)
            ? action.bot.messages
            : b.messages,
      }));
      if ((before.teamId ?? null) === (action.bot.teamId ?? null)) return patched;
      return {
        ...patched,
        selectedId: firstVisibleSelection(
          patched.bots,
          patched.groups,
          patched.activeTeamId,
          patched.selectedId,
        ),
      };
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        // room thread — plain linear append, no branching/mascot machinery
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        if (group.messages.some((m) => m.id === action.message.id)) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id ? { ...g, messages: [...g.messages, action.message] } : g,
          ),
        };
      }
      // every server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) => {
        if (b.messages.some((m) => m.id === action.message.id)) {
          return { ...b, activeLeafId: action.message.id };
        }
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: action.message.id };
      });
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "computerControl":
      return {
        ...state,
        computerControl: {
          ...state.computerControl,
          [action.botId]: { held: action.held, helpReason: action.helpReason },
        },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        appSettingsSection: action.section ?? state.appSettingsSection,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId ? b : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const { acknowledgeLocalAuto: _ack, ...botPatch } = action.patch;
      const patched = updateBot(next, action.botId, (b) => ({ ...b, ...botPatch }));
      if (!Object.prototype.hasOwnProperty.call(action.patch, "teamId")) return patched;
      return {
        ...patched,
        selectedId: firstVisibleSelection(
          patched.bots,
          patched.groups,
          patched.activeTeamId,
          patched.selectedId,
        ),
      };
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(state, action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    // optimistic room edits; the server's group frame confirms them later
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
      };
    case "toggleReaction": {
      const toggle = (m: Message): Message => {
        if (m.id !== action.messageId) return m;
        const reactions = m.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === action.emoji && r.by === "user");
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji: action.emoji, by: "user" }];
        return { ...m, reactions: next.length ? next : undefined };
      };
      return {
        ...state,
        bots: state.bots.map((b) =>
          b.threadId === action.threadId ? { ...b, messages: b.messages.map(toggle) } : b,
        ),
        groups: state.groups.map((g) =>
          g.threadId === action.threadId ? { ...g, messages: g.messages.map(toggle) } : g,
        ),
      };
    }
    // handled entirely by the async wrapper
    case "send":
    case "editMessage":
      return withMascotMotion(state, action.botId, "working");
    case "newTask":
    case "switchTask":
    case "renameTask":
    case "deleteTask":
      return state;
    case "taskSwitched":
      return updateBot(state, action.bot.id, (bot) => ({ ...bot, ...action.bot, messages: action.bot.messages ?? [] }));
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "createGroup":
    case "sendGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "markRoutineRunSeen":
      return state;
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

export const initialState: AppState = {
  bots: [],
  groups: [],
  teams: [],
  activeTeamId: null,
  instances: [],
  config: null,
  selectedId: "",
  activeView: "chat",
  routines: [],
  routineRuns: [],
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  inspectorOpen: false,
  appSettingsOpen: false,
  appSettingsSection: "general",
  screens: {},
  provisioning: {},
  computerControl: {},
  focusMessage: null,
  connected: false,
  error: null,
  mascotMotion: null,
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Per-frame stream state lives in its OWN context: token frames update only
 * the components that read this hook (the chat's streaming tail), while every
 * useStore consumer — sidebar, mascots, pickers, the settled transcript —
 * keeps its render tree untouched during a stream. */
interface StreamState {
  /** in-flight assistant text per threadId */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
}
const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };
const StreamContext = createContext<StreamState>(EMPTY_STREAM);

export function useStreaming() {
  return useContext(StreamContext);
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Commit any debounced profile edits before an operation reads the bot. */
  flushBotPatches: (botId: string) => Promise<void>;
  /** Re-fetch engine availability — after an install, without a restart. */
  refreshInstances: () => Promise<void>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const deltaBuffer = useRef(new Map<string, { text: string; reasoning: string }>());
  const deltaFlush = useRef<number | null>(null);
  const clearStream = (threadId: string) => {
    // Drop the thread's un-flushed deltas too: the settled message that
    // triggered this clear already contains them. Without this, the pending
    // rAF re-creates a "ghost" stream bubble holding the tail fragment —
    // it renders below any card/chip that settled next (so a permission
    // card looks glued to the top), keeps the caret blinking while the bot
    // is actually waiting, and the next block's deltas append onto the
    // duplicated tail instead of starting a fresh bubble.
    deltaBuffer.current.delete(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      const { [threadId]: _r, ...reasoning } = prev.reasoning;
      return { streaming, reasoning };
    });
  };
  const flushDeltas = () => {
    if (deltaFlush.current !== null) {
      cancelAnimationFrame(deltaFlush.current);
      deltaFlush.current = null;
    }
    const buf = deltaBuffer.current;
    if (buf.size === 0) return;
    const entries = [...buf];
    buf.clear();
    setStream((prev) => {
      const streaming = { ...prev.streaming };
      const reasoning = { ...prev.reasoning };
      for (const [threadId, d] of entries) {
        if (d.text) streaming[threadId] = (streaming[threadId] ?? "") + d.text;
        if (d.reasoning) reasoning[threadId] = (reasoning[threadId] ?? "") + d.reasoning;
      }
      return { streaming, reasoning };
    });
  };

  const botPatchQueue = useMemo(
    () =>
      createBotPatchQueue({
        send: async (botId, patch, signal) => {
          const result: { bot: BotAnnouncement } = await api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
            signal,
          });
          return result.bot;
        },
        reconcile: async (botId, signal) => {
          const result: { bots: BotAnnouncement[] } = await api("/api/bots", { signal });
          return result.bots.find((candidate) => candidate.id === botId) ?? null;
        },
        onAuthoritative: (bot, optimisticOverlay) => {
          rawDispatch({ type: "botPatched", bot: { ...bot, ...optimisticOverlay } });
        },
        onError: (error) => {
          rawDispatch({ type: "error", message: error.message });
          setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
        },
      }),
    [],
  );

  useEffect(() => {
    // StrictMode's dev probe runs this cleanup once against the same memoized
    // queue; revive undoes it so profile saves survive development mounts.
    botPatchQueue.revive();
    return () => botPatchQueue.dispose();
  }, [botPatchQueue]);

  const teamActivationQueue = useMemo(
    () =>
      createTeamActivationQueue<{ teams: Team[]; activeTeamId: string | null }>({
        request: (id) =>
          api("/api/teams/active", {
            method: "POST",
            body: JSON.stringify({ id }),
          }),
        apply: ({ teams, activeTeamId }) => rawDispatch({ type: "teamsHydrated", teams, activeTeamId }),
        rollback: (rollbackTeamId) =>
          rawDispatch({
            type: "teamsHydrated",
            teams: stateRef.current.teams,
            activeTeamId: rollbackTeamId,
          }),
        onError: (error) => {
          rawDispatch({ type: "error", message: error.message });
          setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
        },
      }),
    [],
  );

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };
    const claimActiveTeam = (teams: Team[], activeTeamId: string | null) => {
      rawDispatch({ type: "teamsHydrated", teams, activeTeamId });
      void teamActivationQueue.enqueue(activeTeamId, stateRef.current.activeTeamId);
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      const previousActiveTeamId = stateRef.current.activeTeamId;
      const botBeforeUpdate =
        action.type === "updateBot"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      if (action.type === "deleteBot") botPatchQueue.cancel(action.botId);
      rawDispatch(action);
      switch (action.type) {
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          api(`/api/routines/${action.routineId}/run`, { method: "POST" }).catch(showError);
          break;
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "markRoutineRunSeen":
          api(`/api/routine-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "editMessage":
          api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = () =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
              }),
            }).catch(showError);
          if (action.alwaysAllow) {
            const bot = stateRef.current.bots.find((b) => b.id === action.alwaysAllow!.botId);
            const next = [...new Set([...(bot?.alwaysAllow ?? []), action.alwaysAllow.key])];
            // save the grant BEFORE releasing the bot: it may ask again
            // within milliseconds, and a grant that hasn't landed yet
            // would make "always allow" ask a second time. A failed save
            // still lets this one through — losing a preference must not
            // strand the turn — but it says so.
            void api(`/api/bots/${action.alwaysAllow.botId}`, {
              method: "PATCH",
              body: JSON.stringify({ alwaysAllow: next }),
            })
              .catch(showError)
              .finally(respond);
            break;
          }
          void respond();
          break;
        }
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", {
            method: "POST",
            body: JSON.stringify(
              stateRef.current.activeTeamId ? { teamId: stateRef.current.activeTeamId } : {},
            ),
          })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const duplicateProfile = {
            name: `${source.name} copy`,
            title: source.title,
            description: source.description,
            notifications: source.notifications,
            modelSelection: source.modelSelection,
            computer: source.computer,
            cloudBackend: source.cloudBackend,
            avatarUrl: source.avatarUrl,
            avatarCrop: source.avatarCrop,
            ...(source.teamId ? { teamId: source.teamId } : {}),
          };
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                // JSON.stringify omits undefined optional fields while preserving
                // an explicit null avatar clear, so duplication mirrors the source.
                body: JSON.stringify(duplicateProfile),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          const group = stateRef.current.groups.find((g) => g.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({
              memberIds: action.memberIds,
              name: action.name,
              ...(action.teamId ? { teamId: action.teamId } : {}),
            }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup":
          api(`/api/groups/${action.groupId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "toggleReaction":
          api(`/api/threads/${action.threadId}/messages/${action.messageId}/reactions`, {
            method: "POST",
            body: JSON.stringify({ emoji: action.emoji, by: "user" }),
          }).catch(showError);
          break;
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        // tasks: the server answers with the bot AND the live transcript,
        // because switching changes which conversation is on screen
        case "newTask":
          api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: "{}" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "switchTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "POST" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "createTeam":
          api("/api/teams", { method: "POST", body: JSON.stringify({ name: action.name }) })
            .then(({ teams, activeTeamId }: { teams: Team[]; activeTeamId: string | null }) =>
              claimActiveTeam(teams, activeTeamId),
            )
            .catch(showError);
          break;
        case "renameTeam":
          api(`/api/teams/${action.teamId}`, {
            method: "PATCH",
            body: JSON.stringify({ name: action.name }),
          })
            .then(({ teams }: { teams: Team[] }) => rawDispatch({ type: "teamsListed", teams }))
            .catch(showError);
          break;
        case "deleteTeam":
          api(`/api/teams/${action.teamId}`, { method: "DELETE" })
            .then(({ teams, activeTeamId }: { teams: Team[]; activeTeamId: string | null }) =>
              claimActiveTeam(teams, activeTeamId),
            )
            .catch(showError);
          break;
        case "setActiveTeam":
          void teamActivationQueue.enqueue(action.teamId, previousActiveTeamId);
          break;
        case "updateBot": {
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, action.patch, botBeforeUpdate);
          }
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [botPatchQueue, teamActivationQueue]);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = () =>
      Promise.all([
        api("/api/bots")
          .then(({ bots, groups, teams, activeTeamId, computerControl }) =>
            alive && rawDispatch({
              type: "hydrate",
              bots,
              groups: groups ?? [],
              teams: teams ?? [],
              activeTeamId: activeTeamId ?? null,
              computerControl: computerControl ?? {},
            }))
          .catch(() => {}),
        api("/api/instances")
          .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
          .catch(() => {}),
        api("/api/config")
          .then((config) => alive && rawDispatch({ type: "configStatus", config }))
          .catch(() => {}),
        api("/api/routines")
          .then(({ routines, runs }) => alive && rawDispatch({ type: "routinesHydrated", routines, runs }))
          .catch(() => {}),
        api("/api/webhooks")
          .then(({ webhooks, attempts, ingress }) => alive && rawDispatch({ type: "webhooksHydrated", webhooks, attempts: attempts ?? [], ingress }))
          .catch(() => {}),
      ]);

    // A snapshot and the live fold have to meet at a defined boundary. Start
    // hydration only after the stream says hello, queue frames that arrive
    // while the REST snapshot is in flight, then apply them on top. Otherwise
    // a late hydrate can overwrite a newer event, or an event can land between
    // an eager request and the stream opening and disappear entirely.
    let hydrated = false;
    let hydrating = false;
    let rehydrateRequested = false;
    const pendingFrames: any[] = [];
    let handleFrame: (frame: any) => void;
    const hydrate = () => {
      if (hydrating) {
        // A second non-resumable hello means this snapshot may have started
        // before another connection gap. Run one more after it settles.
        rehydrateRequested = true;
        return;
      }
      hydrating = true;
      hydrated = false;
      void loadAll().finally(() => {
        if (!alive) return;
        hydrating = false;
        if (rehydrateRequested) {
          rehydrateRequested = false;
          hydrate();
          return;
        }
        hydrated = true;
        for (const frame of pendingFrames.splice(0)) handleFrame(frame);
      });
    };
    // If SSE is unavailable, the app should still show its saved state. A
    // later first hello hydrates again because it cannot prove there was no
    // gap before that connection opened.
    const hydrationFallback = setTimeout(hydrate, 1_000);

    const es = new EventSource("/api/events");
    // The hydrate decision belongs to the hello frame, not to onopen: the
    // server replays what we missed when it can, and re-downloading every
    // transcript on a reconnect it already covered is pure waste.
    es.onopen = () => rawDispatch({ type: "connected", value: true });
    es.onerror = () => rawDispatch({ type: "connected", value: false });
    handleFrame = (frame) => {
      switch (frame.kind) {
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          // a settled assistant bubble replaces the in-flight stream
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            clearStream(frame.threadId);
            // Auto-speak lives HERE rather than in the chat view so a bot
            // you switched away from still reads its answer out — which is
            // the whole point of listening while you do something else. A
            // Auto-speak is disabled during any call. Call mode owns both the
            // singleton speaker and microphone ordering for its whole lifetime.
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId);
            if (owner?.speakReplies && currentCall() === null && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          // a rewind also invalidates any half-streamed text from the old branch
          clearStream(frame.threadId);
          break;
        case "bot": {
          const bot = frame.bot as BotAnnouncement;
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({
            type: "botPatched",
            bot: { ...bot, ...botPatchQueue.overlayFor(bot.id) },
          });
          break;
        }
        case "group": {
          const group = frame.group as Partial<Group> & { id: string };
          // reading the selected room clears its badge immediately
          if (group.unread && group.id === stateRef.current.selectedId) {
            group.unread = false;
            fetch(`/api/groups/${group.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", group });
          break;
        }
        // the harness decided this was worth interrupting for; the toggle
        // in each bot's settings is what gates it, server-side
        case "notify":
          // the wrapped dispatch, not rawDispatch: `select` clears the badge
          // in local state either way, but only the wrapper PATCHes
          // unread:false back. Opening a bot from its own notification and
          // watching the badge return on the next hydration is exactly the
          // bug that makes notifications feel broken.
          showNotification(frame.notification, (target) => openNotificationTarget(dispatch, target, stateRef.current));
          break;
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "teams":
          rawDispatch({
            type: "teamsHydrated",
            teams: Array.isArray(frame.teams) ? frame.teams : [],
            activeTeamId: teamActivationQueue.isBusy()
              ? stateRef.current.activeTeamId
              : typeof frame.activeTeamId === "string"
                ? frame.activeTeamId
                : null,
          });
          break;
        case "routine":
          rawDispatch({ type: "routinePatched", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        case "routine.run":
          rawDispatch({ type: "routineRunPatched", run: frame.run });
          break;
        case "webhook":
          rawDispatch({ type: "webhookPatched", webhook: frame.webhook });
          break;
        case "webhook.attempt":
          rawDispatch({ type: "webhookAttempted", attempt: frame.attempt });
          break;
        case "webhook.deleted":
          rawDispatch({ type: "webhookDeleted", webhookId: frame.webhookId });
          break;
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta") {
            // Batch token deltas per animation frame (t3code-style): a fast
            // stream dispatches once per frame instead of once per token, so
            // the app tree re-renders at most ~60x/s while streaming.
            const buf = deltaBuffer.current;
            const entry = buf.get(event.threadId) ?? { text: "", reasoning: "" };
            if (event.streamKind === "assistant_text") entry.text += event.delta;
            else if (event.streamKind === "reasoning_text") entry.reasoning += event.delta;
            buf.set(event.threadId, entry);
            if (deltaFlush.current === null) {
              deltaFlush.current = requestAnimationFrame(() => {
                deltaFlush.current = null;
                flushDeltas();
              });
            }
          } else if (event.type === "turn.completed") {
            // flush any buffered tail before clearing so no tokens are lost
            flushDeltas();
            clearStream(event.threadId);
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "computer-control":
          rawDispatch({
            type: "computerControl",
            botId: frame.botId,
            held: frame.held === true,
            helpReason: typeof frame.helpReason === "string" ? frame.helpReason : null,
          });
          break;
        case "bot.deleted":
          botPatchQueue.cancel(frame.botId);
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: configStatusFromFrame(frame),
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      // `hello` is the snapshot boundary. A false `resumed` means the server
      // could not fill the gap, so queue subsequent frames behind a hydrate.
      if (frame.kind === "hello") {
        clearTimeout(hydrationFallback);
        if (!frame.resumed) hydrate();
        return;
      }
      if (hydrated) handleFrame(frame);
      else pendingFrames.push(frame);
    };
    return () => {
      alive = false;
      clearTimeout(hydrationFallback);
      es.close();
    };
  }, []);

  // Re-probe the engines on demand. A CLI installed while the app is running
  // is invisible until something asks again — the setup screens expose this
  // as "Check again" so the user isn't told to restart when a refresh will do.
  const refreshInstances = useCallback(async () => {
    try {
      const { instances } = await api("/api/instances");
      rawDispatch({ type: "instances", instances });
    } catch {
      /* offline or server down — the existing list stays */
    }
  }, []);

  // Installing a CLI or signing one in happens in a terminal, outside this
  // window — so the moment the user comes back is exactly when our engine
  // snapshot is most likely stale. Re-probe on focus, throttled so that
  // ordinary alt-tabbing doesn't spawn a `--version` call per switch.
  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      void refreshInstances();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInstances]);

  const flushBotPatches = useCallback(
    (botId: string) => botPatchQueue.flush(botId),
    [botPatchQueue],
  );
  const value = useMemo(
    () => ({ state, dispatch, flushBotPatches, refreshInstances }),
    [state, dispatch, flushBotPatches, refreshInstances],
  );
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

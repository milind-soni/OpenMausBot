import type { Schedule, ScheduleSnapshot, ScheduleTarget } from "../../server/schedule-types";
import type { EngineUsage, UsagePreferences } from "../../server/usage-types";
// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MausColor, MausMotion } from "@/lib/mascot";
import { clearRoomActivity, foldRoomActivity, type RoomActivityState } from "@/lib/roomActivity";
import { pendingPermissions, PermissionAutoApproveClock, type PermissionCountdown } from "@/lib/permissionAutoApprove";
import type { TaskProject, TaskRecord } from "@/lib/taskBoard";

export type { MausColor } from "@/lib/mascot";

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  textContent?: string;
  path?: string;
}

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  requestType?: "permission" | "question";
  autoApproved?: boolean;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  attachments?: Attachment[];
  card?: OptionCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  scheduled?: { scheduleId: string; deliveryId: string };
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
}

/** A room: several bots + you in one shared thread. */
export type RoomHandoffs = "inherit" | "on" | "off";

export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  bulletin: string;
  /** bot→bot @mention handoffs: follow the app setting, or override it */
  handoffs: RoomHandoffs;
  /** member who answers a message with no @mention */
  defaultResponderId?: string | null;
  /** chained handoffs one user message may trigger (1–3, default 1) */
  maxHops?: number;
  /** per-room inactivity window in minutes (null = app default, 20) */
  turnIdleMinutes?: number | null;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  /** ordered room members waiting to run after the active member */
  queuedBotIds?: string[];
  /** the room's shared task-board project, for the room's Tasks panel */
  projectId?: string | null;
  messages: Message[];
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  label?: string;
}

export interface Bot {
  id: string;
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  unread: boolean;
  busy?: boolean;
  modelSelection: ModelSelection;
  backupModelSelection?: ModelSelection | null;
  onUsageLimit?: "backup" | "wait" | "stop";
  usingBackup?: boolean;
  /** Where this bot's computer runs; unset uses this computer in the desktop app. */
  computer?: "local" | "off";
  pinned?: boolean;
  hidden?: boolean;
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
  usageDisplay?: UsagePreferences;
  xai?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  trello?: { configured: boolean; keyConfigured: boolean };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
  /** Global setting for automatic bot-to-bot handoffs across multi-agent rooms */
  autoHandoffs?: boolean;
  autoApprovePermissions?: boolean;
  autoApproveDelaySeconds?: number;
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
  };
  models: {
    default: string;
    options: Array<{ id: string; label: string }>;
    status?: "ready" | "stale" | "unverified" | "error";
    source?: string;
    refreshedAt?: string;
    error?: string;
  };
  /** null when the driver has no configurable permission mode. */
  autoApprove: boolean | null;
}

export interface AppState {
  schedules: ScheduleSnapshot;
  schedulesOpen: boolean;
  scheduleSheet: { target?: ScheduleTarget; schedule?: Schedule; prompt?: string } | null;
  usage: EngineUsage[];
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  settingsOpen: boolean;
  settingsFocus?: "backup";
  appsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsTab?: string;
  projectsOpen: boolean;
  taskBoardOpen: boolean;
  previewOpen: boolean;
  tasks: TaskRecord[];
  taskProjects: TaskProject[];
  tasksLoaded: boolean;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

export type Action =
  | { type: "schedules"; snapshot: ScheduleSnapshot }
  | { type: "toggleSchedules"; open?: boolean }
  | { type: "openSchedule"; target?: ScheduleTarget; schedule?: Schedule; prompt?: string }
  | { type: "closeSchedule" }
  | { type: "usage"; engines: EngineUsage[] }
  | { type: "hydrate"; bots: Bot[]; groups: Group[] }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string }
  | { type: "sendGroup"; groupId: string; text: string; attachments?: Attachment[] }
  | { type: "patchGroup"; groupId: string; patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "handoffs" | "defaultResponderId" | "maxHops" | "turnIdleMinutes" | "projectId">> }
  | { type: "deleteGroup"; groupId: string }
  | { type: "clearChat"; threadId: string }
  | { type: "threadCleared"; threadId: string }
  | { type: "toggleReaction"; threadId: string; messageId: string; emoji: string }
  | { type: "interruptGroup"; groupId: string }
  | { type: "stopGroupActivity"; groupId: string; botId: string }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string; attachments?: Attachment[] }
  | { type: "editMessage"; botId: string; messageId: string; text: string; attachments?: Attachment[] }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; threadId?: string; messageId: string; answer: string; autoApproved?: boolean }
  | { type: "dismissCard"; botId: string; threadId?: string; messageId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean; focusBackup?: boolean }
  | { type: "toggleApps"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean; tab?: string }
  | { type: "toggleProjects"; open?: boolean }
  | { type: "toggleTaskBoard"; open?: boolean }
  | { type: "togglePreview"; open?: boolean }
  | { type: "hydrateTasks"; tasks: TaskRecord[]; projects: TaskProject[] }
  | { type: "taskUpserted"; task: TaskRecord }
  | { type: "taskDeleted"; taskId: string }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          "name" | "title" | "description" | "notifications" | "onUsageLimit" | "backupModelSelection" | "computer" | "color" | "mascotExpression" | "pinned" | "hidden"
        >
      >;
    };

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

function patchCard(state: AppState, botId: string, threadId: string | undefined, messageId: string, patch: Partial<OptionCardData>): AppState {
  if (threadId) {
    return {
      ...state,
      groups: state.groups.map((group) => group.threadId === threadId ? {
        ...group,
        messages: group.messages.map((message) =>
          message.id === messageId && message.card ? { ...message, card: { ...message.card, ...patch } } : message,
        ),
      } : group),
    };
  }
  return updateBot(state, botId, (bot) => ({
    ...bot,
    messages: bot.messages.map((message) =>
      message.id === messageId && message.card ? { ...message, card: { ...message.card, ...patch } } : message,
    ),
  }));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      const selectedId =
        state.selectedId && known(state.selectedId) ? state.selectedId : (action.bots[0]?.id ?? "");
      return { ...state, bots: action.bots, groups: action.groups, selectedId };
    }
    case "hydrateTasks":
      return { ...state, tasks: action.tasks, taskProjects: action.projects, tasksLoaded: true };
    case "taskUpserted": {
      const exists = state.tasks.some((task) => task.id === action.task.id);
      return {
        ...state,
        tasks: exists
          ? state.tasks.map((task) => task.id === action.task.id ? action.task : task)
          : [...state.tasks, action.task],
      };
    }
    case "taskDeleted":
      return { ...state, tasks: state.tasks.filter((task) => task.id !== action.taskId) };
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
    case "threadCleared":
      return {
        ...state,
        bots: state.bots.map((bot) =>
          bot.threadId === action.threadId
            ? { ...bot, messages: [], activeLeafId: null, unread: false }
            : bot,
        ),
        groups: state.groups.map((group) =>
          group.threadId === action.threadId ? { ...group, messages: [], unread: false } : group,
        ),
      };
    case "instances":
      return { ...state, instances: action.instances };
    case "usage":
      return { ...state, usage: action.engines };
    case "schedules": return { ...state, schedules: action.snapshot };
    case "openSchedule": return { ...state, scheduleSheet: { target: action.target, schedule: action.schedule, prompt: action.prompt } };
    case "closeSchedule": return { ...state, scheduleSheet: null };
    case "toggleSchedules": return { ...state, previewOpen: false, schedulesOpen: action.open ?? !state.schedulesOpen, appsOpen: false, projectsOpen: false, taskBoardOpen: false, appSettingsOpen: false, settingsOpen: false, computerOpen: false };
    case "configStatus":
      return { ...state, config: action.config };
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          selectedId: action.id,
          schedulesOpen: false,
          appsOpen: false,
          projectsOpen: false,
          taskBoardOpen: false,
          previewOpen: false,
          appSettingsOpen: false,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        withMascotMotion({ ...state, selectedId: action.id, schedulesOpen: false, previewOpen: false, appsOpen: false, projectsOpen: false, taskBoardOpen: false, appSettingsOpen: false }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
    }
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.threadId, action.messageId, { answered: action.answer }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.threadId, action.messageId, { dismissed: true });
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots],
        selectedId: action.bot.id,
        appsOpen: false,
        projectsOpen: false,
        taskBoardOpen: false,
        previewOpen: false,
        appSettingsOpen: false,
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
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const next = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      return updateBot(next, action.bot.id, (b) => ({ ...b, ...action.bot, messages: b.messages }));
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
        settingsFocus: action.focusBackup ? "backup" : undefined,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        appsOpen: open ? false : state.appsOpen,
        projectsOpen: open ? false : state.projectsOpen,
        taskBoardOpen: open ? false : state.taskBoardOpen,
        schedulesOpen: open ? false : state.schedulesOpen,
        previewOpen: open ? false : state.previewOpen,
      };
    }
    case "toggleApps":
    case "togglePlugins": {
      const open = action.open ?? !state.appsOpen;
      return {
        ...state,
        appsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        projectsOpen: open ? false : state.projectsOpen,
        taskBoardOpen: open ? false : state.taskBoardOpen,
        schedulesOpen: open ? false : state.schedulesOpen,
        previewOpen: open ? false : state.previewOpen,
      };
    }
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        appsOpen: open ? false : state.appsOpen,
        projectsOpen: open ? false : state.projectsOpen,
        taskBoardOpen: open ? false : state.taskBoardOpen,
        schedulesOpen: open ? false : state.schedulesOpen,
        previewOpen: open ? false : state.previewOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        appSettingsTab: action.tab ?? (open ? state.appSettingsTab : undefined),
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appsOpen: open ? false : state.appsOpen,
        projectsOpen: open ? false : state.projectsOpen,
        taskBoardOpen: open ? false : state.taskBoardOpen,
        schedulesOpen: open ? false : state.schedulesOpen,
        previewOpen: open ? false : state.previewOpen,
      };
    }
    case "toggleProjects": {
      const open = action.open ?? !state.projectsOpen;
      return {
        ...state,
        projectsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        appsOpen: open ? false : state.appsOpen,
        taskBoardOpen: open ? false : state.taskBoardOpen,
        schedulesOpen: open ? false : state.schedulesOpen,
        previewOpen: open ? false : state.previewOpen,
      };
    }
    case "toggleTaskBoard": {
      const open = action.open ?? !state.taskBoardOpen;
      return {
        ...state,
        taskBoardOpen: open,
        schedulesOpen: open ? false : state.schedulesOpen,
        projectsOpen: open ? false : state.projectsOpen,
        previewOpen: open ? false : state.previewOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        appsOpen: open ? false : state.appsOpen,
      };
    }
    case "togglePreview": {
      const open = action.open ?? !state.previewOpen;
      return {
        ...state,
        previewOpen: open,
        schedulesOpen: open ? false : state.schedulesOpen,
        projectsOpen: open ? false : state.projectsOpen,
        taskBoardOpen: open ? false : state.taskBoardOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        appsOpen: open ? false : state.appsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const next = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      return updateBot(next, action.botId, (b) => ({ ...b, ...action.patch }));
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
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "createGroup":
    case "sendGroup":
    case "deleteGroup":
    case "clearChat":
    case "interruptGroup":
    case "stopGroupActivity":
      return state;
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

export const initialState: AppState = {
  schedules: { schedules: [], paused: false, deliveries: [] },
  schedulesOpen: false,
  scheduleSheet: null,
  usage: [],
  bots: [],
  groups: [],
  instances: [],
  config: null,
  selectedId: "",
  settingsOpen: false,
  appsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  projectsOpen: false,
  taskBoardOpen: false,
  previewOpen: false,
  tasks: [],
  taskProjects: [],
  tasksLoaded: false,
  connected: false,
  error: null,
  mascotMotion: null,
};

// ── API client ─────────────────────────────────────────────────────────
export class ApiError extends Error {
  status: number;
  body: any;

  constructor(status: number, body: any, fallback: string) {
    super(body.error ?? fallback);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body, `${res.status} ${res.statusText}`);
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

const RoomActivityContext = createContext<RoomActivityState>({});

const PermissionAutoApproveContext = createContext<{
  countdown: PermissionCountdown;
  cancel: (key: string) => void;
}>({ countdown: {}, cancel: () => {} });

export function usePermissionAutoApprove() {
  return useContext(PermissionAutoApproveContext);
}

export function useRoomActivity(threadId: string) {
  return useContext(RoomActivityContext)[threadId] ?? {};
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [roomActivity, setRoomActivity] = useState<RoomActivityState>({});
  const [permissionCountdown, setPermissionCountdown] = useState<PermissionCountdown>({});
  const permissionClock = useRef<PermissionAutoApproveClock | null>(null);
  const deltaBuffer = useRef(new Map<string, { text: string; reasoning: string }>());
  const deltaFlush = useRef<number | null>(null);
  const clearStream = (threadId: string) => {
    // Drop any not-yet-flushed token deltas for this thread too — otherwise
    // the pending rAF flush re-adds a stale/truncated tail of the just-
    // committed message back into `streaming` right after this clears it,
    // rendering a duplicate bubble underneath the real one.
    deltaBuffer.current.delete(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      const { [threadId]: _r, ...reasoning } = prev.reasoning;
      return { streaming, reasoning };
    });
  };
  const clearThreadTransientState = (threadId: string) => {
    clearStream(threadId);
    setRoomActivity((current) => clearRoomActivity(current, threadId));
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

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());

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

    const wrapped: React.Dispatch<Action> = (action) => {
      if (action.type === "clearChat") {
        api(`/api/threads/${action.threadId}/messages`, { method: "DELETE" })
          .then(() => {
            rawDispatch({ type: "threadCleared", threadId: action.threadId });
            clearThreadTransientState(action.threadId);
          })
          .catch(showError);
        return;
      }
      if (action.type === "answerCard" && action.autoApproved) {
        const owner = action.threadId
          ? stateRef.current.groups.find((group) => group.threadId === action.threadId)
          : stateRef.current.bots.find((bot) => bot.id === action.botId);
        const card = owner?.messages.find((message) => message.id === action.messageId)?.card;
        if (stateRef.current.config?.autoApprovePermissions === false || card?.requestType !== "permission" || !card.requestId || card.answered || card.dismissed) return;
        api(`/api/bots/${action.botId}/respond`, {
          method: "POST",
          body: JSON.stringify({ requestId: card.requestId, behavior: "allow", threadId: action.threadId, autoApproved: true }),
        }).catch((error) => {
          permissionClock.current?.cancel(`${action.threadId ?? action.botId}:${action.messageId}`);
          showError(error);
        });
        return;
      }
      if (action.type === "answerCard" || action.type === "dismissCard") {
        const owner = action.threadId
          ? stateRef.current.groups.find((group) => group.threadId === action.threadId)
          : stateRef.current.bots.find((bot) => bot.id === action.botId);
        if (owner) permissionClock.current?.cancel(`${action.threadId ?? action.botId}:${action.messageId}`);
      }
      rawDispatch(action);
      switch (action.type) {
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, attachments: action.attachments }),
          }).catch(showError);
          break;
        case "editMessage":
          api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, attachments: action.attachments }),
          }).catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId }),
          }).catch(showError);
          break;
        case "answerCard": {
          const owner = action.threadId
            ? stateRef.current.groups.find((group) => group.threadId === action.threadId)
            : stateRef.current.bots.find((bot) => bot.id === action.botId);
          const card = owner?.messages.find((message) => message.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
                threadId: action.threadId,
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
          const owner = action.threadId
            ? stateRef.current.groups.find((group) => group.threadId === action.threadId)
            : stateRef.current.bots.find((bot) => bot.id === action.botId);
          const card = owner?.messages.find((message) => message.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user.", threadId: action.threadId }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  modelSelection: source.modelSelection,
                  ...(source.computer ? { computer: source.computer } : {}),
                }),
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
            body: JSON.stringify({ memberIds: action.memberIds, name: action.name }),
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
            body: JSON.stringify({ text: action.text, attachments: action.attachments }),
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
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "stopGroupActivity":
          api(`/api/groups/${action.groupId}/activities/${action.botId}/stop`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  if (!permissionClock.current) {
    permissionClock.current = new PermissionAutoApproveClock(
      (card) => dispatch({ type: "answerCard", botId: card.botId, threadId: card.threadId, messageId: card.messageId, answer: "Allow", autoApproved: true }),
      setPermissionCountdown,
    );
  }

  useEffect(() => {
    permissionClock.current?.configure(state.config !== null && (state.config.autoApprovePermissions ?? true), state.config?.autoApproveDelaySeconds ?? 10);
    permissionClock.current?.sync(pendingPermissions(state));
  }, [state.bots, state.groups, state.config]);

  useEffect(() => {
    const activity = () => permissionClock.current?.activity();
    for (const event of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "touchmove"]) {
      window.addEventListener(event, activity, true);
    }
    const interval = window.setInterval(() => permissionClock.current?.tick(), 250);
    return () => {
      window.clearInterval(interval);
      for (const event of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "touchmove"]) {
        window.removeEventListener(event, activity, true);
      }
    };
  }, []);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      api("/api/bots")
        .then(({ bots, groups }) => alive && rawDispatch({ type: "hydrate", bots, groups: groups ?? [] }))
        .catch(() => {});
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
      api("/api/schedules").then(snapshot => alive && rawDispatch({ type: "schedules", snapshot })).catch(() => {});
      api("/api/usage").then(({ engines }) => alive && rawDispatch({ type: "usage", engines })).catch(() => {});
      api("/api/tasks")
        .then(({ tasks, projects }) => alive && rawDispatch({ type: "hydrateTasks", tasks, projects }))
        .catch(() => {});
    };
    loadAll();
    const modelRefresh = window.setInterval(() => {
      api("/api/instances?refresh=1")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
    }, 60_000);

    const es = new EventSource("/api/events");
    es.onopen = () => {
      rawDispatch({ type: "connected", value: true });
      loadAll(); // resync anything missed while disconnected
    };
    es.onerror = () => rawDispatch({ type: "connected", value: false });
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      switch (frame.kind) {
        case "message":
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          // a settled assistant bubble replaces the in-flight stream
          if (frame.message?.role === "bot" && frame.message?.kind === "text") clearStream(frame.threadId);
          break;
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          // a rewind also invalidates any half-streamed text from the old branch
          clearStream(frame.threadId);
          break;
        case "thread.cleared":
          rawDispatch({ type: "threadCleared", threadId: frame.threadId });
          clearThreadTransientState(frame.threadId);
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "botPatched", bot });
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
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "task.created":
        case "task.updated":
          rawDispatch({ type: "taskUpserted", task: frame.task });
          break;
        case "task.deleted":
          rawDispatch({ type: "taskDeleted", taskId: frame.taskId });
          break;
        case "preview.reload":
          window.dispatchEvent(new CustomEvent("gbs:preview-reload", { detail: frame }));
          break;
        case "runtime": {
          const event = frame.event;
          setRoomActivity((current) => foldRoomActivity(current, { botId: frame.botId, event }));
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
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a permission toggle (or other instance edit) hot-reloaded the fleet
        case "instances":
          rawDispatch({ type: "instances", instances: frame.instances });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "schedules": rawDispatch({ type: "schedules", snapshot: { schedules: frame.schedules, paused: frame.paused, deliveries: frame.deliveries } }); break;
        case "schedule.started": {
          const target = frame.target;
          const bot = stateRef.current.bots.find(b => b.id === target?.botId);
          const group = stateRef.current.groups.find(g => g.id === target?.groupId);
          const notify = bot?.notifications || group?.memberIds.some(id => stateRef.current.bots.find(b => b.id === id)?.notifications);
          if (!window.gbs && notify && "Notification" in window && Notification.permission === "granted") new Notification("Scheduled task started", { body: `${bot?.name ?? group?.name ?? "Your bot"} started its scheduled task.` });
          break;
        }
        case "usage":
          rawDispatch({ type: "usage", engines: frame.engines });
          break;
        case "config":
          rawDispatch({
            type: "configStatus",
            config: { usageDisplay: frame.usageDisplay, xai: frame.xai, composio: frame.composio, trello: frame.trello, profile: frame.profile,
              autoHandoffs: frame.autoHandoffs, autoApprovePermissions: frame.autoApprovePermissions, autoApproveDelaySeconds: frame.autoApproveDelaySeconds },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    return () => {
      alive = false;
      window.clearInterval(modelRefresh);
      es.close();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>
        <RoomActivityContext.Provider value={roomActivity}>
          <PermissionAutoApproveContext.Provider value={{ countdown: permissionCountdown, cancel: (key) => permissionClock.current?.cancel(key) }}>
            {children}
          </PermissionAutoApproveContext.Provider>
        </RoomActivityContext.Provider>
      </StreamContext.Provider>
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

export { toWireTask } from "./task-wire.ts";
import { chmodSync, existsSync, readFileSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic, writeFileAtomicIfChanged } from "./atomic.ts";
import { commitRegistryChange, keptRevocation, saveRegistryFor } from "./registry-save.ts";
import { parseToolScope, toolScopeWidens } from "../shared/tool-scope.ts";
import { reorderStable } from "../shared/bot-order.ts";
import { ensureSections, readSections, changeEmptySection } from "./section-context.ts";
import type { TeamComputers } from "./team-computers.ts";
import { removeBotFolder, soulFile, soulHash, writeSoulMirror } from "./bot-folder.ts";
import type { BotProfilePatch } from "./bot-profile.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, loadBrowserProfileIdAliases } from "./config.ts";
import * as mdb from "./message-db.ts";
import { forgetBotMemoryJournal, journalFile } from "./memory-journal.ts";
import { runCommand, type Command } from "./commands.ts";
import { workspaceDir } from "./workspace.ts";
import type { Destination } from "./surface.ts";
import { newId, type ModelSelection } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { redactBotAuthored } from "./message-redaction.ts";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN, botAvatarProfile, clampAvatarFocus, clampAvatarZoom } from "../shared/bot-avatar.ts";
import { approvalModeFor, isApprovalMode, modelSwitchNeedsAsk, threadApproval, type ApprovalMode } from "../shared/approval-mode.ts";
import { lastChangeRequestUrl } from "../shared/thread-link.ts";
import { REMOVED_COMPUTER_DRIVER, type ComputerEngineMove } from "./computer-engine-removal.ts";
import type { TeamSetupRequest, TeamSetupResult } from "../shared/team-setup.ts";
import type { GroupGoalRunCardData } from "../shared/group-goal-run.ts";
import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.ts";
import type { HandedState } from "./delta-context.ts";
import type { AgentPart, PartPair, RoomPart } from "./package-parts.ts";
import type {
  BotActivity, GroupDefaultResponder, GroupTask as GroupTaskRecord, MausColor,
  TaskClosedBy, TaskOpenedBy, TaskUsage, WireBot, WireGroup,
  WireMessage, WireTask, BotProject as BotProjectRecord,
} from "../shared/wire.ts";
import { movesThreadToTop, nextOpenThread } from "../shared/wire.ts";
import { parseConnectorTools } from "./connector-tools.ts";
import { sameModelSelection } from "../shared/thread-model.ts";
import { initialGreetingMessage } from "./initial-greeting.ts"; import { createDefaultBot, defaultBotRefusal } from "./default-bot.ts";
import { ThreadCache, type ThreadState } from "./thread-cache.ts";
export type {
  BotActivity, ConnectorCardData, GroupDefaultResponder, OptionCardData,
  SecretRequestCardData, Surface, TaskClosedBy, TaskOpenedBy, TaskUsage,
} from "../shared/wire.ts";
export type { GroupTask as GroupTaskRecord, BotProject as BotProjectRecord } from "../shared/wire.ts";
export type { InstalledPlaybook, InstalledPackageMetadata, MausColor, MausExpression } from "../shared/wire.ts";


 export type Message = WireMessage;

 export interface GroupPackageStamp {
  installId: string;
  key: string;
  memberKeys: string[];
  parts: Record<RoomPart, PartPair>;
}

 export type GroupRecord = Omit<WireGroup, "working" | "usage"> & { installedPackage?: GroupPackageStamp };
 export type GroupWirePrivateKeys = "installedPackage";
export type GroupWireProjection = Omit<GroupRecord, GroupWirePrivateKeys> & Pick<WireGroup, "usage"> & { working: boolean };
export type GroupWireProjectionIsExact = AssertExact<WireGroup, GroupWireProjection> & AssertSameKeys<WireGroup, GroupWireProjection>;
export const groupWireProjectionIsExact: GroupWireProjectionIsExact = true;

   const projectEmojiPattern = new RegExp("^(?!\\p{Emoji_Component}$)(?:\\p{RGI_Emoji}|[\\p{Emoji}--\\p{Emoji_Component}])$", "v");
export function isProjectEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && projectEmojiPattern.exec(value)?.[0] === value;
}

 export interface TaskRecord extends Omit<WireTask, TaskWireDerivedKeys> {
  resumeCursors: Record<string, unknown>;
  lastInstanceId?: string;
  handedMessages?: Record<string, HandedState>;
  appliedCompactionId?: string;
  contextFloor?: number;
  lastContextModel?: string;
  surfaceSource?: "user" | "auto";
  askedAt?: number;
}

 export type TaskWirePrivateKeys = "resumeCursors" | "lastInstanceId" | "handedMessages" | "appliedCompactionId" | "contextFloor" | "lastContextModel" | "surfaceSource" | "askedAt";
 export type TaskWireDerivedKeys = "surfaceAuto" | "followsBotModel";
export type TaskWireProjection = Pick<TaskRecord, Exclude<keyof TaskRecord, TaskWirePrivateKeys>> & Pick<WireTask, TaskWireDerivedKeys>;
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertSameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
 export type TaskWireProjectionIsExact = AssertExact<WireTask, TaskWireProjection> & AssertSameKeys<WireTask, TaskWireProjection>;
export const taskWireProjectionIsExact: TaskWireProjectionIsExact = true;


 const ASK_NOW = { approvalMode: "ask" as const, autoApprove: false, alwaysAllow: [] as string[] };

const TASK_PATCH_FIELDS = [
  "title", "projectId", "modelSelection", "approvalMode", "autoApprove", "alwaysAllow",
  "unread", "lastReadMessageId", "rewound", "archivedAt", "pinned", "pinnedMessageId", "resumeCursors", "lastInstanceId", "cwd",
  "routineRunId", "surface", "surfaceSource", "snoozedUntil", "link", "linkAuto", "appliedCompactionId", "contextFloor", "lastContextModel",
] as const satisfies readonly (keyof TaskRecord)[];
export type TaskPatch = Partial<Pick<TaskRecord, typeof TASK_PATCH_FIELDS[number]>>;

export type GroupTaskPatch = Partial<Pick<GroupTaskRecord, "title" | "pinned">> & { turnTimeoutMinutes?: number | null };

function mirrorActiveGroupTask(group: GroupRecord, task: GroupTaskRecord): void {
  Object.assign(group, { threadId: task.threadId, pinnedCwd: task.pinnedCwd, pinnedMessageId: task.pinnedMessageId });
}

function persistedPin<T extends { pinned?: boolean }>(task: T): T {
  if (task.pinned === true) return task;
  if (!("pinned" in task)) return task;
  const { pinned: _pinned, ...rest } = task;
  return rest as T;
}

export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
  | { type: "sections" }
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  /** The fleet was reordered as a whole; the broadcast carries every id in its new place. */
  | { type: "bots.order" }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };

 export const UNTITLED_TASK = "New task";
export const UNTITLED_THREAD = "New thread";

 const TASK_TITLE_MAX = 80;
export function threadTitleFrom(title?: string): string {
  return title?.trim().slice(0, TASK_TITLE_MAX) || UNTITLED_THREAD;
}

 export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

 export function titleFromLlm(raw: string): string | null {
  const line = raw
    .trim()
    .split("\n")[0]!
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/^["'\u201C\u201D\u2018\u2019\u0060]+/, "")
    .replace(/["'\u201C\u201D\u2018\u2019\u0060]+$/, "")
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/[#*]+$/, "")
    .replace(/[.\u3002]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length >= 1 && line.length <= 48 ? line : null;
}

 export interface BotRecord extends Omit<WireBot, "avatarUrl" | "tasks"> {
  tasks?: TaskRecord[];
  avatarUrl?: string;
  resumeCursors: Record<string, unknown>;
  approvalGrant?: {
    requestId: string;
    mode: "full" | "custom";
    phase: "prepared" | "confirmed" | "activated" | "committed";
    threadId?: string;
    threadOnly?: true;
    refreshPermissions?: true;
    allThreads?: true;
  };
  lastProfileRequestId?: string;
  lastTeamSetupReceipt?: { requestId: string; result: TeamSetupResult };
  packageBase?: Partial<Record<AgentPart, PartPair>>;
  assignedSkills?: string[];
}

 export type BotWirePrivateKeys = "resumeCursors" | "tasks" | "avatarUrl" | "approvalGrant" | "lastProfileRequestId" | "lastTeamSetupReceipt" | "packageBase" | "assignedSkills";
export type BotWireProjection = Pick<BotRecord, Exclude<keyof BotRecord, BotWirePrivateKeys>>;
export type BotWireProjectionIsExact = AssertExact<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection> & AssertSameKeys<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection>;
export const botWireProjectionIsExact: BotWireProjectionIsExact = true;

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
 const THREAD_MODEL_COPIES_CLEARED = join(DATA_DIR, "thread-model-copies-cleared");
 const ASKED_AT_FILLED = join(DATA_DIR, "asked-at-filled");

 function tightenRegistryFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    /* absent, or not ours to change */
  }
}
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: MausColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

 export const sectionKey = (section?: string | null): string => section?.trim() || "";

 export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest.slice(name.length);
      return !isMentionNameContinuation(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

 export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown; fallbackBotId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (candidate.kind === "auto") {
      return typeof candidate.fallbackBotId === "string" && memberIds.includes(candidate.fallbackBotId)
        ? { kind: "auto", fallbackBotId: candidate.fallbackBotId }
        : { kind: "auto" };
    }
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

 export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
): T[] {
  const available = members.filter((member) => !member.hidden);
  const everyone = "everyone";
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const candidate = text.slice(at + 1, at + 1 + everyone.length);
    if (
      isMentionBoundary(text, at) &&
      candidate.toLocaleLowerCase() === everyone &&
      !isMentionNameContinuation(text.slice(at + 1 + everyone.length))
    ) {
      return available;
    }
  }
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  if (defaultResponder.kind === "auto") {
    const fallback = available.find((member) => member.id === defaultResponder.fallbackBotId) ?? available[0];
    return fallback ? [fallback] : [];
  }
  return [];
}

 export function pruneRoomHolds(group: Pick<GroupRecord, "memberIds" | "holds" | "heldMessages">): void {
  for (const key of ["holds", "heldMessages"] as const) {
    const map = group[key];
    if (!map) continue;
    const kept = Object.fromEntries(Object.entries(map).filter(([botId]) => group.memberIds.includes(botId)));
    if (Object.keys(kept).length !== Object.keys(map).length) (group as Record<typeof key, unknown>)[key] = kept;
  }
}

 function taskCountsAsBotUnread(task: { unread?: boolean; routineRunId?: string }): boolean {
  return Boolean(task.unread) && !task.routineRunId;
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads = new ThreadCache(() => this.busyThreadIds());
  private defaultSelection: () => ModelSelection;
  private completeNewBotSelection: (selection: ModelSelection) => ModelSelection;
  private driverKindOf: (instanceId: string) => string | undefined;
  private initialLanguage: string | (() => string);
  private listeners = new Set<(change: StoreChange) => void>();
  private registeringInitialSections = true;
  private legacyActivities = new Map<string, BotActivity>();

  constructor(
    defaultSelection: () => ModelSelection,
    completeNewBotSelection: (selection: ModelSelection) => ModelSelection = (selection) => selection,
    driverKindOf: (instanceId: string) => string | undefined = () => undefined,
    initialLanguage: string | (() => string) = Intl.DateTimeFormat().resolvedOptions().locale,
  ) {
    this.defaultSelection = defaultSelection;
    this.completeNewBotSelection = completeNewBotSelection;
    this.driverKindOf = driverKindOf;
    this.initialLanguage = initialLanguage;
    mkdirSync(DATA_DIR, { recursive: true });
    for (const file of [BOTS_FILE, GROUPS_FILE]) tightenRegistryFile(file);
    let botsLoaded = false;
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
      botsLoaded = Array.isArray(this.bots);
    } catch {
      this.bots = [];
    }
    try {
      this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
    } catch {
      this.groups = [];
    }
    this.rememberSections([...this.bots, ...this.groups].map((record) => record.section));
    let botsMigrated = false;
    const browserProfileAliases = loadBrowserProfileIdAliases();
    const chiefSectionsSeen = new Set<string>();
    let groupsMigrated = false;
    for (const b of this.bots) {
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      b.busy = false;
      b.activity = "idle";
      if (typeof b.soul !== "string") {
        b.soul = "";
        botsMigrated = true;
      }
      if (b.soulHash !== soulHash(b.soul)) {
        b.soulHash = soulHash(b.soul);
        botsMigrated = true;
      }
      if (!existsSync(soulFile(b.id))) {
        try { writeSoulMirror(b.id, b.soul); } catch (e) {
          console.warn(`[bot-folder] could not create SOUL.md for ${b.id}: ${(e as Error).message}`);
        }
      }
      if (b.browserProfile) {
        const browserProfile = browserProfileAliases.get(b.browserProfile);
        if (browserProfile && browserProfile !== b.browserProfile) {
          b.browserProfile = browserProfile;
          botsMigrated = true;
        }
      }
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      if (b.managedSections !== undefined && (!b.chiefOfStaff || !Array.isArray(b.managedSections) ||
          b.managedSections.length > 100 || b.managedSections.some(section => typeof section !== "string" || section.length > 60))) {
        delete b.managedSections;
        botsMigrated = true;
      }
      if (b.approvalMode !== undefined && !isApprovalMode(b.approvalMode)) {
        delete b.approvalMode;
        botsMigrated = true;
      }
      if (b.approvalGrant !== undefined) {
        const threadOnly = b.approvalGrant.threadOnly === true;
        if (threadOnly) {
          const target = b.tasks?.find(task => task.threadId === b.approvalGrant?.threadId);
          if (target) { target.approvalMode = "ask"; target.autoApprove = false; }
        }
        if (!threadOnly) {
        b.approvalMode = "ask";
        b.autoApprove = false;
        for (const task of b.tasks ?? []) {
          if (task.approvalMode === "full" || task.approvalMode === "custom") {
            task.approvalMode = "ask";
            task.autoApprove = false;
          }
        }
        }
        delete b.approvalGrant;
        botsMigrated = true;
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
      if (b.avatarZoom !== undefined) {
        const zoom = clampAvatarZoom(b.avatarZoom);
        if (zoom === AVATAR_ZOOM_MIN) {
          delete b.avatarZoom;
          botsMigrated = true;
        } else if (b.avatarZoom !== zoom) {
          b.avatarZoom = zoom;
          botsMigrated = true;
        }
      }
      for (const key of ["avatarFocusX", "avatarFocusY"] as const) {
        if (b[key] === undefined) continue;
        const focus = clampAvatarFocus(b[key]);
        if (focus === AVATAR_FOCUS_CENTER) {
          delete b[key];
          botsMigrated = true;
        } else if (b[key] !== focus) {
          b[key] = focus;
          botsMigrated = true;
        }
      }
    }
    for (const b of this.bots) {
      if (!b.chiefOfStaff) continue;
      const key = sectionKey(b.section);
      if (!chiefSectionsSeen.has(key)) {
        chiefSectionsSeen.add(key);
        if (b.hidden) {
          b.hidden = false;
          botsMigrated = true;
        }
        continue;
      }
      b.chiefOfStaff = false;
      delete b.managedSections;
      botsMigrated = true;
    }
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    for (const b of this.bots) {
      const taskProviderGrants = (b.tasks ?? []).flatMap((task) =>
        (task.alwaysAllow ?? []).filter((key) => key.startsWith("provider-tool:")),
      );
      if (!taskProviderGrants.length) continue;
      const migrated = [...new Set([...(b.alwaysAllow ?? []), ...taskProviderGrants])].slice(0, 200);
      if (JSON.stringify(migrated) === JSON.stringify(b.alwaysAllow ?? [])) continue;
      b.alwaysAllow = migrated;
      botsMigrated = true;
    }
    const botIds = new Set(this.bots.map((b) => b.id));
    for (const g of this.groups) {
      g.busyBotId = null;
      delete g.turnStartedAt;
      if (botsLoaded && !g.dm && g.memberIds.some((id) => !botIds.has(id))) {
        g.memberIds = g.memberIds.filter((id) => botIds.has(id));
        groupsMigrated = true;
      }
      const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
      if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) groupsMigrated = true;
      g.defaultResponder = normalized;
      if (g.holds !== undefined || g.heldMessages !== undefined) {
        const before = JSON.stringify([g.holds, g.heldMessages]);
        pruneRoomHolds(g);
        if (JSON.stringify([g.holds, g.heldMessages]) !== before) groupsMigrated = true;
      }
      if (g.dm) {
        if (g.tasks !== undefined) {
          delete g.tasks;
          groupsMigrated = true;
        }
        continue;
      }
      if (!g.tasks?.length) {
        const initialTask: GroupTaskRecord = {
          threadId: g.threadId,
          title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
          createdAt: g.createdAt,
          updatedAt: g.createdAt,
        };
        if (g.pinnedCwd !== undefined) initialTask.pinnedCwd = g.pinnedCwd;
        if (g.pinnedMessageId) initialTask.pinnedMessageId = g.pinnedMessageId;
        g.tasks = [initialTask];
        groupsMigrated = true;
      }
      let active = g.tasks.find((task) => task.threadId === g.threadId);
      if (!active) {
        active = g.tasks[0]!;
        g.threadId = active.threadId;
        groupsMigrated = true;
      }
      g.pinnedCwd = active.pinnedCwd;
      g.pinnedMessageId = active.pinnedMessageId;
    }
    if (groupsMigrated) this.saveGroups();
    const clearModelCopies = !existsSync(THREAD_MODEL_COPIES_CLEARED) && (botsLoaded || !existsSync(BOTS_FILE));
    const fillAskedAts = !existsSync(ASKED_AT_FILLED) && (botsLoaded || !existsSync(BOTS_FILE));
    for (const b of this.bots) {
      if (b.projects?.some((project) => "modelSelection" in project)) {
        b.projects = b.projects.map(({ id, name, emoji }) => ({ id, name, ...(isProjectEmoji(emoji) ? { emoji } : {}) }));
        botsMigrated = true;
      }
      if (!b.tasks?.length) {
        b.tasks = [{
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          updatedAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        }];
        botsMigrated = true;
      }
      let active = b.tasks.find((task) => task.threadId === b.threadId);
      if (!active) {
        active = {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          updatedAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        };
        b.tasks.unshift(active);
        botsMigrated = true;
      }
      for (const task of b.tasks) {
        if (clearModelCopies && task.modelSelection !== undefined && sameModelSelection(task.modelSelection, b.modelSelection)) {
          delete task.modelSelection;
          botsMigrated = true;
        }
        if (!task.resumeCursors) {
          task.resumeCursors = task === active ? (b.resumeCursors ?? {}) : {};
          botsMigrated = true;
        }
        if (task.unread === undefined) {
          task.unread = task === active && b.unread;
          botsMigrated = true;
        }
        if (task.routineRunId && task.unread) {
          task.unread = false;
          botsMigrated = true;
        }
        if (task === active) {
          if (task.rewound === undefined && b.rewound !== undefined) {
            task.rewound = b.rewound;
            botsMigrated = true;
          }
          if (task.pinnedMessageId === undefined && b.pinnedMessageId !== undefined) {
            task.pinnedMessageId = b.pinnedMessageId;
            botsMigrated = true;
          }
        }
        if (task.approvalMode !== undefined && !isApprovalMode(task.approvalMode)) {
          delete task.approvalMode;
          botsMigrated = true;
        }
        if (task.busy !== undefined || task.activity !== undefined || task.turnStartedAt !== undefined) botsMigrated = true;
        task.busy = false;
        task.activity = "idle";
        task.turnStartedAt = undefined;
      }
      this.mirrorActiveTask(b, active);
      b.unread = b.tasks.some(taskCountsAsBotUnread);
    }
    if (botsMigrated) this.saveBots();
    if (clearModelCopies) writeFileAtomic(THREAD_MODEL_COPIES_CLEARED, "Threads follow their bot's model; the copies older builds made are cleared.\n", { mode: 0o600 });
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
    }
    this.repairThreadUpdatedAts();
    if (fillAskedAts) this.fillTaskAskedAts();
    this.repairDuplicatePairConversations();
    this.registeringInitialSections = false;
  }

  /** In memory only: message writes must not rewrite bots.json. */
  private noteThreadActivity(threadId: string, at: number, forOrder = false, orderAt = at): void {
    if (!Number.isFinite(at)) return;
    for (const task of [...this.bots, ...this.groups].map((owner) => owner.tasks?.find((candidate) => candidate.threadId === threadId))) {
      if (!task) continue;
      task.updatedAt = Math.max(task.updatedAt ?? 0, at);
      if (forOrder) task.lastThreadOrderAt = Math.max(task.lastThreadOrderAt ?? 0, orderAt);
    }
  }

  private repairThreadUpdatedAts(): void {
    const botTasks = this.bots.flatMap((bot) => bot.tasks ?? []);
    const groupTasks = this.groups.flatMap((group) => group.tasks ?? []);
    const latest = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId));
    const latestOrder = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId), true);
    let botsDirty = false;
    let groupsDirty = false;
    const repair = (task: { threadId: string; createdAt: number; updatedAt?: number; lastThreadOrderAt?: number }) => {
      const fromMessages = latest.get(task.threadId);
      const next = fromMessages !== undefined && (task.updatedAt === undefined || fromMessages > task.updatedAt)
        ? fromMessages
        : task.updatedAt ?? task.createdAt;
      const fromOrder = latestOrder.get(task.threadId);
      const orderAt = fromOrder === undefined ? task.lastThreadOrderAt : Math.max(task.lastThreadOrderAt ?? task.createdAt, fromOrder);
      const changed = task.updatedAt !== next || task.lastThreadOrderAt !== orderAt;
      task.updatedAt = next;
      task.lastThreadOrderAt = orderAt;
      return changed;
    };
    for (const task of botTasks) if (repair(task)) botsDirty = true;
    for (const task of groupTasks) if (repair(task)) groupsDirty = true;
    if (botsDirty) this.saveBots();
    if (groupsDirty) this.saveGroups();
  }

  private fillTaskAskedAts(): void {
    const tasks = this.bots.flatMap((bot) => bot.tasks ?? []).filter((task) => task.askedAt === undefined && !task.routineRunId);
    const asked = mdb.latestPersonLineAts(tasks.map((task) => task.threadId));
    for (const task of tasks) {
      const at = asked.get(task.threadId);
      if (at !== undefined) task.askedAt = at;
    }
    if (asked.size) this.saveBots();
    writeFileAtomic(ASKED_AT_FILLED, "Threads from before askedAt have it from the lines people wrote there.\n", { mode: 0o600 });
  }

  private openerIdentity(openedBy: TaskOpenedBy): string {
    if (this.bot(openedBy.botId)) return openedBy.botId;
    const named = this.bots.filter((bot) => bot.name === openedBy.name);
    return named.length === 1 ? named[0].id : openedBy.botId;
  }

  private repairDuplicatePairConversations(): void {
    let botsDirty = false;
    type SweepTask = { openedBy?: TaskOpenedBy; closedBy?: TaskClosedBy };
    const sweep = (tasks: SweepTask[] | undefined, repaired: () => void) => {
      const pairs = new Map<string, SweepTask[]>();
      for (const task of tasks ?? []) {
        const by = task.openedBy;
        if (by?.kind !== "pair" || task.closedBy) continue;
        const identity = this.openerIdentity(by);
        pairs.set(identity, [...(pairs.get(identity) ?? []), task]);
      }
      for (const rows of pairs.values()) {
        for (const duplicate of rows.slice(1)) {
          const by = duplicate.openedBy!;
          const identity = this.openerIdentity(by);
          const { kind: _kind, ...opened } = by;
          duplicate.openedBy = opened;
          duplicate.closedBy = {
            botId: identity,
            name: this.bot(identity)?.name ?? by.name,
            at: Date.now(),
          };
          repaired();
        }
      }
    };
    for (const bot of this.bots) sweep(bot.tasks, () => { botsDirty = true; });
    if (botsDirty) this.saveBots();
  }

  private commitBotChange(bot: BotRecord, action: string, change: () => void, onRollback?: () => void) {
    commitRegistryChange(bot, "bots.json", action, () => this.saveBots(), change, onRollback);
  }

  private commitGroupChange(group: GroupRecord, action: string, change: () => void) {
    commitRegistryChange(group, "groups.json", action, () => this.saveGroups(), change);
  }

  private saveBots(bots: BotRecord[] = this.bots, registerSections = true) {
    if (registerSections) this.rememberSections([...this.bots, ...bots].map((bot) => bot.section));
    writeFileAtomicIfChanged(BOTS_FILE, JSON.stringify(bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({
      ...bot,
      tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, ...task }) => persistedPin(task)),
    })), null, 2), { mode: 0o600 });
  }

  private saveGroups(groups: GroupRecord[] = this.groups, registerSections = true) {
    if (registerSections) this.rememberSections(groups.map((group) => group.section));
    writeFileAtomicIfChanged(GROUPS_FILE, JSON.stringify(groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => ({
      ...g,
      ...(g.tasks ? { tasks: g.tasks.map((task) => persistedPin(task)) } : {}),
    })), null, 2), { mode: 0o600 });
  }

  get sections(): string[] { return readSections(); }

  private rememberSections(names: (string | undefined)[]) {
    try {
      if (ensureSections(names)) this.emit({ type: "sections" });
    } catch (error) {
      if (!this.registeringInitialSections) throw error;
      console.warn(`[teams] Startup could not register team names; saved teams and shared instructions were left unchanged: ${(error as Error).message}`);
    }
  }

  renameSection(name: string, nextName: string, computers?: TeamComputers): string | undefined {
    if (!name || !this.sections.includes(name)) return "No such department";
    nextName = nextName.trim();
    if (!nextName || nextName.length > 60 || [...nextName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "Department name must be 1 to 60 characters without control characters";
    if (name === nextName) return undefined;
    if (this.sections.includes(nextName) || computers?.forSection(nextName)) return "A team with that name already exists";
    const members = this.bots.filter(bot => sectionKey(bot.section) === name);
    const rooms = this.groups.filter(group => sectionKey(group.section) === name);
    const affected = this.bots.filter(bot => members.includes(bot) || bot.managedSections?.some(section => sectionKey(section) === name));
    if (affected.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
      return "Stop this team's active work before renaming the team";
    }
    if (!members.length && !rooms.length && !computers?.forSection(name)) return this.changeEmptySection(name, nextName);
    const nextBots = this.bots.map(bot => ({ ...bot,
      ...(members.includes(bot) ? { section: nextName } : {}),
      ...(bot.managedSections ? { managedSections: [...new Set(bot.managedSections.map(section => sectionKey(section) === name ? nextName : section))] } : {}),
    }));
    const nextGroups = this.groups.map(group => rooms.includes(group) ? { ...group, section: nextName } : group);
    let computerChanged = false;
    try {
      this.saveBots(nextBots, false);
      this.saveGroups(nextGroups, false);
      computerChanged = computers?.renameSection(name, nextName) ?? false;
      changeEmptySection(name, nextName);
    } catch (error) {
      this.saveBots(this.bots, false);
      this.saveGroups(this.groups, false);
      if (computerChanged) computers!.renameSection(nextName, name);
      throw error;
    }
    for (let i = 0; i < nextBots.length; i++) Object.assign(this.bots[i], nextBots[i]);
    for (let i = 0; i < nextGroups.length; i++) Object.assign(this.groups[i], nextGroups[i]);
    for (const bot of affected) this.emit({ type: "bot", botId: bot.id });
    for (const room of rooms) this.emit({ type: "group", groupId: room.id });
    this.emit({ type: "sections" });
    return undefined;
  }

  changeEmptySection(name: string, nextName: string | null): string | undefined {
    if (!this.sections.includes(name)) return "No such department";
    if ([...this.bots, ...this.groups].some((record) => sectionKey(record.section) === name)) {
      return "Move all bots (including archived bots) and group chats out of this team first";
    }
    if (nextName !== null && nextName !== name && this.sections.includes(nextName)) {
      return "A team with that name already exists";
    }
    if (nextName === name) return undefined;
    const revoked = this.bots.filter((bot) => bot.managedSections?.some((section) => sectionKey(section) === name));
    if (revoked.length) {
      const grants = new Map(revoked.map((bot) => [bot.id, bot.managedSections!.filter((section) => sectionKey(section) !== name)]));
      this.saveBots(this.bots.map((bot) => grants.has(bot.id) ? { ...bot, managedSections: grants.get(bot.id)! } : bot));
      for (const bot of revoked) bot.managedSections = grants.get(bot.id)!;
      for (const bot of revoked) this.emit({ type: "bot", botId: bot.id });
    }
    changeEmptySection(name, nextName);
    this.emit({ type: "sections" });
    return undefined;
  }

  deleteSection(name: string): string | undefined {
    if (!name || !this.sections.includes(name)) return "No such department";
    const members = this.bots.filter(bot => sectionKey(bot.section) === name);
    const rooms = this.groups.filter(group => sectionKey(group.section) === name);
    if (members.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
      return "Stop this team's active work before deleting the team";
    }
    if (this.bots.filter(bot => bot.chiefOfStaff && (!sectionKey(bot.section) || sectionKey(bot.section) === name)).length > 1) {
      return "General already has a Chief of Staff. Move or change this team's Chief before deleting the team";
    }
    const nextBots = this.bots.map(bot => ({ ...bot,
      ...(sectionKey(bot.section) === name ? { section: undefined } : {}),
      ...(bot.managedSections ? { managedSections: bot.managedSections.filter(section => sectionKey(section) !== name) } : {}),
    }));
    const nextGroups = this.groups.map(group => sectionKey(group.section) === name ? { ...group, section: undefined } : group);
    try {
      this.saveBots(nextBots);
      this.saveGroups(nextGroups);
      changeEmptySection(name, null);
    } catch (error) {
      this.saveBots();
      this.saveGroups();
      throw error;
    }
    for (let i = 0; i < nextBots.length; i++) Object.assign(this.bots[i], nextBots[i]);
    for (let i = 0; i < nextGroups.length; i++) Object.assign(this.groups[i], nextGroups[i]);
    for (const bot of this.bots) this.emit({ type: "bot", botId: bot.id });
    for (const group of rooms) this.emit({ type: "group", groupId: group.id });
    this.emit({ type: "sections" });
    return undefined;
  }

  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange) {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groups.find(
      (group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId),
    );
  }

  createGroup(
    name: string,
    memberIds: string[],
    dm = false,
    section?: string,
    setup?: {
      bulletin?: string;
      defaultResponder?: GroupDefaultResponder;
      completed?: boolean; id?: string; threadId?: string;
    },
  ): GroupRecord {
    this.rememberSections([section]);
    const threadId = setup?.threadId ?? newId();
    const createdAt = Date.now();
    const group: GroupRecord = {
      id: setup?.id ?? newId(),
      threadId,
      name,
      memberIds,
      defaultResponder: dm
        ? { kind: "mentions" }
        : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
      bulletin: setup?.bulletin ?? "",
      unread: false,
      createdAt,
      dm: dm || undefined,
      busyBotId: null,
      section,
    };
    if (!dm) {
      group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt, updatedAt: createdAt }];
      group.setupCompletedAt = setup?.completed ? createdAt : null;
      group.setupSkippedAt = null;
    }
    saveRegistryFor("groups.json", dm ? "the new chat" : "the new room", () => this.saveGroups([group, ...this.groups]));
    this.groups.unshift(group);
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "description" | "unread" | "lastReadMessageId" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt" | "audienceFloor" | "installedPackage" | "turnTimeoutMinutes" | "holds" | "heldMessages">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    if (Object.prototype.hasOwnProperty.call(patch, "section")) {
      this.rememberSections([patch.section]);
    }
    const { busyBotId, ...stored } = patch;
    if (Object.prototype.hasOwnProperty.call(patch, "busyBotId")) {
      if (busyBotId && busyBotId !== group.busyBotId) group.turnStartedAt = Date.now();
      else if (!busyBotId) delete group.turnStartedAt;
      group.busyBotId = busyBotId ?? null;
    }
    this.commitGroupChange(group, group.dm ? "the chat's settings" : "the room's settings", () => {
      Object.assign(group, stored);
      if (Object.prototype.hasOwnProperty.call(stored, "turnTimeoutMinutes") && stored.turnTimeoutMinutes == null) {
        delete group.turnTimeoutMinutes;
      }
      if (!group.dm && Object.prototype.hasOwnProperty.call(stored, "pinnedMessageId")) {
        const active = this.activeGroupTask(group.id);
        if (active) active.pinnedMessageId = stored.pinnedMessageId;
      }
      group.defaultResponder = normalizeGroupDefaultResponder(group.defaultResponder, group.memberIds, Boolean(group.dm));
      if (Object.prototype.hasOwnProperty.call(stored, "memberIds")) pruneRoomHolds(group);
    });
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  private deleteThreadRecord(threadId: string, dbAlreadyDeleted = false) {
    this.threads.delete(threadId);
    if (!dbAlreadyDeleted) mdb.deleteThread(threadId);
    for (const file of [
      messagesFile(threadId),
      `${messagesFile(threadId)}.imported`,
      join(EVENTS_DIR, `${threadId}.ndjson`),
      join(NATIVE_DIR, `${threadId}.ndjson`),
    ]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.emit({ type: "thread.deleted", threadId });
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    const remaining = this.groups.filter((g) => g.id !== id);
    saveRegistryFor("groups.json", group.dm ? "the chat deletion" : "the room deletion", () => this.saveGroups(remaining));
    this.groups = remaining;
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    this.emit({ type: "group.deleted", groupId: id });
    return true;
  }

  reconcileInterruptedGroupGoals(
    resolve?: (
      runId: string,
      threadId: string,
    ) => {
      status: Exclude<GroupGoalRunCardData["status"], "working">;
      detail: string;
      finishedAt: number;
    } | null,
    fallbackDetail = "OpenMausBot restarted before this goal finished.",
    fallbackFinishedAt = Date.now(),
  ): number {
    const ownedThreadIds = new Set<string>();
    for (const group of this.groups) {
      ownedThreadIds.add(group.threadId);
      for (const task of group.tasks ?? []) ownedThreadIds.add(task.threadId);
    }
    let recovered = 0;
    for (const hit of mdb.workingGoalRunMessages()) {
      if (!ownedThreadIds.has(hit.threadId) || !hit.message.goalRun) continue;
      const resolution = resolve?.(hit.message.goalRun.runId, hit.threadId) ?? {
        status: "failed" as const,
        detail: fallbackDetail,
        finishedAt: fallbackFinishedAt,
      };
      const state = resolution.status === "needs-input"
        ? "needs your input"
        : resolution.status === "limit-reached"
          ? "reached its turn limit"
          : resolution.status;
      this.patchMessage(hit.threadId, hit.message.id, {
        text: `Goal ${state}: ${resolution.detail}`,
        goalRun: {
          ...hit.message.goalRun,
          status: resolution.status,
          detail: resolution.detail,
          finishedAt: resolution.finishedAt,
        },
      });
      recovered += 1;
    }
    return recovered;
  }

  groupTasks(groupId: string): GroupTaskRecord[] {
    const group = this.group(groupId);
    return group?.dm ? [] : (group?.tasks ?? []);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    return group?.tasks?.find((task) => task.threadId === group.threadId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    if (!group || group.dm) return undefined;
    return group.tasks?.find((task) => task.threadId === threadId);
  }

  createGroupTask(groupId: string, title?: string, activate = true): GroupTaskRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm) return null;
    const createdAt = Date.now();
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim().slice(0, 80) || UNTITLED_TASK,
      createdAt,
      updatedAt: createdAt,
    };
    this.commitGroupChange(group, "the new thread", () => {
      group.tasks = [task, ...(group.tasks ?? [])];
      if (activate) mirrorActiveGroupTask(group, task);
    });
    this.emit({ type: "group", groupId });
    return task;
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!group || group.dm || !task) return null;
    this.commitGroupChange(group, "the thread switch", () => mirrorActiveGroupTask(group, task));
    this.emit({ type: "group", groupId });
    return group;
  }

  patchGroupTask(groupId: string, threadId: string, patch: GroupTaskPatch): GroupTaskRecord | null {
    const group = this.group(groupId);
    const task = this.groupTaskByThread(groupId, threadId);
    if (!group || !task) return null;
    this.commitGroupChange(group, "the thread change", () => {
      if (patch.title !== undefined) task.title = patch.title.trim().slice(0, 80) || UNTITLED_TASK;
      if (patch.pinned) task.pinned = true;
      else if (patch.pinned === false) delete task.pinned;
      if (patch.turnTimeoutMinutes === null) delete task.turnTimeoutMinutes;
      else if (patch.turnTimeoutMinutes !== undefined) task.turnTimeoutMinutes = patch.turnTimeoutMinutes;
    });
    this.emit({ type: "group", groupId });
    return task;
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string): GroupTaskRecord | null {
    const group = this.group(groupId);
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!group || !task || task.titleFromFirstMessage || task.title !== UNTITLED_TASK) return null;
    this.commitGroupChange(group, "the thread's title", () => {
      task.title = titleFromMessage(text);
      task.titleFromFirstMessage = true;
    });
    this.emit({ type: "group", groupId });
    return task;
  }

  retitleGroupTask(groupId: string, threadId: string, machineTitle: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task || task.title !== machineTitle) return null;
    return this.patchGroupTask(groupId, threadId, { title: threadTitleFrom(title) });
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const result = this.deleteGroupTasks(groupId, [threadId]);
    return result?.deleted.length ? result.group : null;
  }

  /** Null when nothing may go: no such channel, a bot-to-bot channel, or a request that would leave it with no task. */
  deleteGroupTasks(groupId: string, threadIds: string[]): { group: GroupRecord; deleted: string[]; missing: string[] } | null {
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks) return null;
    const present = new Set(group.tasks.map((task) => task.threadId));
    const unique = [...new Set(threadIds)];
    const deleted = unique.filter((id) => present.has(id));
    const missing = unique.filter((id) => !present.has(id));
    if (deleted.length >= group.tasks.length) return null;
    if (!deleted.length) return { group, deleted, missing };
    const doomed = new Set(deleted);
    mdb.deleteThreads(deleted, () => this.commitGroupChange(group, "the thread deletion", () => {
      group.tasks = group.tasks!.filter((task) => !doomed.has(task.threadId));
      if (doomed.has(group.threadId)) mirrorActiveGroupTask(group, group.tasks[0]!);
    }));
    for (const id of deleted) this.deleteThreadRecord(id, true);
    this.emit({ type: "group", groupId });
    return { group, deleted, missing };
  }

  setReaction(threadId: string, messageId: string, by: string, reaction: Omit<NonNullable<Message["reactions"]>[number], "by"> | null): Message | null {
    const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!existing) return null;
    const next = [...(existing.reactions ?? []).filter((r) => r.by !== by), ...(reaction ? [{ ...reaction, by }] : [])];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  private thread(threadId: string): ThreadState {
    return this.threads.get(threadId) ?? this.threads.load(threadId, mdb.readThread(threadId, messagesFile(threadId)));
  }

  private busyThreadIds(): Set<string> {
    const busy = new Set<string>();
    for (const bot of this.bots) {
      if (bot.busy) busy.add(bot.threadId);
      for (const task of bot.tasks ?? []) if (task.busy) busy.add(task.threadId);
    }
    for (const group of this.groups) {
      if (group.busyBotId) for (const threadId of [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]) busy.add(threadId);
    }
    return busy;
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  messagesTail(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } {
    let state = this.threads.get(threadId);
    if (!state) {
      const tail = mdb.readThreadTail(threadId, messagesFile(threadId), limit);
      const legacyRows = tail.hasMore !== undefined && tail.messages.some((m) => m.parentId === undefined);
      if (tail.hasMore !== true || legacyRows) {
        state = this.threads.load(threadId, legacyRows ? mdb.readThread(threadId, messagesFile(threadId)) : tail);
      } else {
        return {
          messages: tail.messages,
          hasMore: tail.hasMore,
          activeLeafId: tail.activeLeafId ?? tail.messages.at(-1)?.id ?? null,
        };
      }
    }
    const { messages, activeLeafId } = state;
    const start = Math.max(0, messages.length - limit);
    return { messages: messages.slice(start), hasMore: start > 0, activeLeafId };
  }

  importTranscript(threadId: string, messages: Message[], activeLeafId: string | null, relinked?: ReadonlyArray<{ id: string; parentId: string | null }>): void {
    if (!relinked && this.messagesFor(threadId).length) throw new Error("Cannot import over an existing conversation");
    mdb.importThread(threadId, messages, activeLeafId, relinked);
    this.threads.delete(threadId);
    const newest = messages.reduce((max, message) => Math.max(max, message.at), Number.NEGATIVE_INFINITY);
    const newestOrder = messages.reduce((max, message) => movesThreadToTop(message) ? Math.max(max, message.turnCompletedAt ?? message.at) : max, Number.NEGATIVE_INFINITY);
    if (Number.isFinite(newest)) this.noteThreadActivity(threadId, newest, Number.isFinite(newestOrder), newestOrder);
  }

  activeLeaf(threadId: string): string | null {
    return this.thread(threadId).activeLeafId;
  }

  activePath(threadId: string): Message[] {
    const t = this.thread(threadId);
    const byId = new Map(t.messages.map((m) => [m.id, m]));
    const path: Message[] = [];
    let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  markTerminalAssistantMessage(threadId: string, turnId: string): Message | null {
    const path = this.activePath(threadId);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const message = path[i];
      if (message.role === "bot" && message.kind === "text" && message.turnId === turnId) {
        if (message.turnTerminal) return message;
        return this.patchMessage(threadId, message.id, { turnTerminal: true, turnCompletedAt: Date.now() });
      }
    }
    return null;
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }, command?: Command): Message {
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    const persist = () => { mdb.appendMessage(threadId, full); return full; };
    const committed = command ? runCommand(command, persist) : persist();
    if (committed.id !== full.id) return committed;
    t.messages.push(full);
    t.activeLeafId = full.id;
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.noteThreadActivity(threadId, full.at, movesThreadToTop(full), full.turnCompletedAt ?? full.at);
    this.emit({ type: "message", threadId, message: full });
    if (full.role === "user" && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  insertMessageAfter(threadId: string, anchorId: string | undefined, message: Omit<Message, "id" | "at">): Message {
    const t = this.thread(threadId);
    const anchorExists = anchorId !== undefined && t.messages.some((m) => m.id === anchorId);
    if (!anchorExists || t.activeLeafId === anchorId) return this.appendMessage(threadId, message);
    const full: Message = { id: newId(), at: Date.now(), ...redactBotAuthored(message), parentId: anchorId };
    const children = t.messages.filter((m) => m.parentId === anchorId);
    t.messages.push(full);
    mdb.insertMessage(threadId, full);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.noteThreadActivity(threadId, full.at, movesThreadToTop(full), full.turnCompletedAt ?? full.at);
    this.emit({ type: "message", threadId, message: full });
    for (const child of children) this.patchMessage(threadId, child.id, { parentId: full.id });
    return full;
  }

  dismissOnboardingCard(threadId: string): Message | null {
    const t = this.thread(threadId);
    const card = t.messages.find(
      (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
    );
    if (!card?.card) return null;
    return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  private pruneScreenFrames(t: { messages: Message[] }, keep = 4): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png) continue;
      seen += 1;
      if (seen > keep) {
        m.png = undefined;
        pruned.push(m);
      }
    }
    return pruned;
  }

  branchMessage(threadId: string, sourceId: string, text: string, sendId?: string, sender?: Message["sender"], dataContext?: Message["dataContext"]): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: "user",
      kind: "text",
      text,
      parentId: source.parentId ?? null,
      replyToId: source.replyToId,
      ...(source.reaction && source.text === text ? { reaction: source.reaction } : {}),
      ...(sendId ? { sendId } : {}),
      ...(sender ? { sender } : {}),
      ...(dataContext ? { dataContext } : {}),
    };
    t.messages.push(full);
    t.activeLeafId = full.id;
    mdb.appendMessage(threadId, full);
    this.noteThreadActivity(threadId, full.at, true);
    this.emit({ type: "message", threadId, message: full });
    this.emit({ type: "thread", threadId, activeLeafId: full.id });
    return full;
  }

  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    t.activeLeafId = cur;
    mdb.setActiveLeaf(threadId, cur);
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>, command?: Command): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const next = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    let applied = false;
    const persist = () => { mdb.updateMessage(threadId, next); applied = true; return next; };
    const committed = command ? runCommand(command, persist) : persist();
    if (!applied) return committed;
    if (!movesThreadToTop(t.messages[idx]) && movesThreadToTop(next)) this.noteThreadActivity(threadId, next.at, true, next.turnCompletedAt ?? next.at);
    t.messages[idx] = next;
    this.emit({ type: "message.patch", threadId, message: next });
    return next;
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
  }

  private newBotSelection(requested?: ModelSelection): ModelSelection {
    return this.completeNewBotSelection(requested ?? this.defaultSelection());
  }

  createBot(
    profile: Partial<
      Pick<
        BotRecord,
        "name" | "title" | "description" | "soul" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section" | "cwd" | "visibility" | "toolScope"
      >
    > = {},
    opts: {
      seedMessages?: boolean; id?: string; threadId?: string;
    } = {},
  ): BotRecord {
    const toolScope = parseToolScope(profile.toolScope);
    if (!toolScope.ok) throw new Error(toolScope.error);
    this.rememberSections([profile.section]);
    const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
    const section = sectionKey(profile.section);
    const bot: BotRecord = {
      id: opts.id ?? newId(),
      threadId: opts.threadId ?? newId(),
      name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      soul: profile.soul ?? "",
      soulHash: soulHash(profile.soul ?? ""),
      notifications: true,
      color: profile.color ?? COLORS[this.bots.length % COLORS.length],
      ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
      ...(profile.mascotBody ? { mascotBody: profile.mascotBody } : {}),
      // Restricted from its first frame: no one else is ever told it exists.
      ...(profile.visibility && profile.visibility !== "everyone" ? { visibility: structuredClone(profile.visibility) } : {}),
      ...(toolScope.scope ? { toolScope: toolScope.scope } : {}),
      unread: false,
      modelSelection: this.newBotSelection(profile.modelSelection),
      resumeCursors: {},
      createdAt: Date.now(),
    };
    if (section) bot.section = section;
    if (profile.cwd) bot.cwd = profile.cwd;
    bot.tasks = [{
      threadId: bot.threadId,
      title: UNTITLED_THREAD,
      createdAt: bot.createdAt,
      updatedAt: bot.createdAt,
      resumeCursors: {},
      unread: false,
      activity: "idle",
      busy: false,
    }];
    this.saveBots([bot, ...this.bots]);
    this.bots.unshift(bot);
    try {
      writeSoulMirror(bot.id, bot.soul ?? "");
    } catch (e) {
      console.warn(`[bot-folder] could not write SOUL.md mirror for ${bot.id}: ${(e as Error).message}`);
    }
    this.emit({ type: "bot", botId: bot.id });
    if (opts.seedMessages !== false) {
      this.appendMessage(bot.threadId, initialGreetingMessage(name, this.initialLanguage));
    }
    return bot;
  }

  applyTeamSetup(request: TeamSetupRequest): TeamSetupResult {
    const chief = this.bot(request.botId);
    if (!chief) throw new Error("The requesting Chief no longer exists");
    if (chief.lastTeamSetupReceipt?.requestId === request.requestId) return chief.lastTeamSetupReceipt.result;
    const managedSections = [...new Set([...(chief.managedSections ?? []), ...request.newTeams])];
    if (managedSections.length > 100 || managedSections.some((name) => name.trim() !== name || name.length > 60) ||
        request.newTeams.some((name) => !name) || (request.newTeams.length && !chief.chiefOfStaff)) throw new Error("Invalid reviewed Chief team scope");
    const nextBots = [...this.bots];
    const changed: BotRecord[] = [];
    for (const operation of request.operations) {
      const at = nextBots.findIndex((bot) => bot.id === operation.botId);
      let next: BotRecord;
      if (operation.action === "create") {
        if (at >= 0 || !operation.threadId || !operation.fields.name || !operation.fields.modelSelection) throw new Error("Invalid new bot in team setup");
        const createdAt = Date.now();
        const modelSelection = this.newBotSelection(operation.fields.modelSelection);
        next = { id: operation.botId, threadId: operation.threadId, name: operation.fields.name,
          title: "", description: "", soul: "", notifications: true, color: COLORS[nextBots.length % COLORS.length], unread: false,
          resumeCursors: {}, createdAt, ...operation.fields, modelSelection,
          autoApprove: false, composio: false, approvePeerComms: false,
          connectorTools: {},
          ...(chief.visibility && chief.visibility !== "everyone" ? { visibility: structuredClone(chief.visibility) } : {}),
          tasks: [{ threadId: operation.threadId, title: UNTITLED_THREAD, createdAt, updatedAt: createdAt, resumeCursors: {},
            unread: false, activity: "idle", busy: false }],
        };
        if (!next.cwd) delete next.cwd;
        nextBots.unshift(next);
      } else {
        if (at < 0) throw new Error("A setup target no longer exists");
        const previous = nextBots[at];
        next = { ...previous, ...operation.fields };
        if (operation.fields.modelSelection) next.tasks = this.withDefaultModel(previous, operation.fields.modelSelection);
        nextBots[at] = next;
      }
      if (operation.fields.chiefOfStaff === false) delete next.managedSections;
      next.section = sectionKey(next.section) || undefined;
      if (operation.fields.soul !== undefined) { next.soulHash = soulHash(operation.fields.soul); next.soulDrift = false; }
      changed.push(next);
    }
    const result: TeamSetupResult = { state: "applied", newTeams: request.newTeams, bots: changed.map((bot, index) => ({
      id: bot.id, name: bot.name, section: bot.section, modelSelection: structuredClone(bot.modelSelection), chiefOfStaff: Boolean(bot.chiefOfStaff),
      action: request.operations[index].action === "create" ? "created" : "updated",
    })) };
    const chiefAt = nextBots.findIndex((bot) => bot.id === chief.id);
    const nextChief = { ...nextBots[chiefAt], lastTeamSetupReceipt: { requestId: request.requestId, result } };
    if (request.newTeams.length && nextChief.chiefOfStaff) {
      nextChief.managedSections = managedSections;
    }
    nextBots[chiefAt] = nextChief;
    this.saveBots(nextBots);
    this.bots = nextBots;
    for (const bot of changed) {
      try { writeSoulMirror(bot.id, bot.soul ?? ""); } catch (error) {
        console.warn(`[bot-folder] could not refresh reviewed setup mirror for ${bot.id}: ${(error as Error).message}`);
      }
      this.emit({ type: "bot", botId: bot.id });
    }
    this.emit({ type: "bot", botId: chief.id });
    return result;
  }

  private switchNeedsAsk(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean {
    if (from.instanceId === to.instanceId) return false;
    const thread = this.projectBotForTask(botId, threadId);
    return Boolean(thread) && modelSwitchNeedsAsk(approvalModeFor(thread!), this.driverKindOf(from.instanceId), this.driverKindOf(to.instanceId));
  }

  private withDefaultModel(bot: BotRecord, next: ModelSelection): TaskRecord[] | undefined {
    return bot.tasks?.map((task) => ({
      ...task,
      approvalMode: approvalModeFor(this.projectBotForTask(bot.id, task.threadId)!),
      autoApprove: task.autoApprove ?? bot.autoApprove,
      alwaysAllow: structuredClone(task.alwaysAllow ?? bot.alwaysAllow ?? []),
      ...(task.modelSelection === undefined && this.switchNeedsAsk(bot.id, task.threadId, bot.modelSelection, next) ? structuredClone(ASK_NOW) : {}),
    }));
  }

  applyModelDefault(id: string, modelSelection: ModelSelection): BotRecord | null {
    const previous = this.bot(id);
    if (!previous) return null;
    const next: BotRecord = { ...previous, modelSelection: structuredClone(modelSelection), tasks: this.withDefaultModel(previous, modelSelection) };
    this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
    this.bots = this.bots.map((candidate) => candidate.id === id ? next : candidate);
    this.emit({ type: "bot", botId: id });
    return next;
  }

  deleteBot(id: string, setupRequest?: TeamSetupRequest): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    if (bot.defaultBot) throw Object.assign(new Error(defaultBotRefusal(bot.name)), { status: 409 });
    let nextBots = this.bots.filter((b) => b.id !== id);
    if (setupRequest) {
      const chief = this.bot(setupRequest.botId);
      if (!chief || chief.id === id || setupRequest.deletion?.botId !== id) throw new Error("The reviewed deletion no longer has a valid owner");
      const lastTeamSetupReceipt: NonNullable<BotRecord["lastTeamSetupReceipt"]> = { requestId: setupRequest.requestId, result: { state: "applied", newTeams: [], bots: [
        { id: bot.id, name: bot.name, action: "deleted" },
      ] } };
      nextBots = nextBots.map((candidate) => candidate.id === chief.id ? { ...candidate, lastTeamSetupReceipt } : candidate);
    }
    this.saveBots(nextBots);
    this.bots = nextBots;
    this.legacyActivities.delete(id);
    const rooms = this.groups.filter((g) => !g.dm && g.memberIds.includes(id));
    for (const g of rooms) {
      g.memberIds = g.memberIds.filter((member) => member !== id);
      if (g.busyBotId === id) { g.busyBotId = null; delete g.turnStartedAt; }
      g.defaultResponder = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, false);
    }
    if (rooms.length) {
      try { this.saveGroups(); } catch (error) { console.warn("store: room cleanup will retry on restart", error); }
    }
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
    } catch {}
    try {
      rmSync(journalFile(id), { force: true });
    } catch {}
    mdb.deleteBotMemoryFiles(id);
    forgetBotMemoryJournal(id);
    try {
      rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
    } catch {}
    removeBotFolder(id);
    this.emit({ type: "bot.deleted", botId: id });
    for (const g of rooms) this.emit({ type: "group", groupId: g.id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    if (patch.connectorTools !== undefined) {
      const parsed = parseConnectorTools(patch.connectorTools);
      if (!parsed.ok) throw new Error(parsed.error);
      patch = { ...patch, connectorTools: parsed.grants };
    }
    if (Object.hasOwn(patch, "toolScope")) {
      const parsed = parseToolScope(patch.toolScope);
      if (!parsed.ok) throw new Error(parsed.error);
      patch = { ...patch, toolScope: parsed.scope };
    }
    const wideningToolScope = Object.hasOwn(patch, "toolScope") && toolScopeWidens(bot.toolScope, patch.toolScope);
    const nextToolScope = patch.toolScope;
    if (wideningToolScope) {
      patch = { ...patch };
      delete patch.toolScope;
    }
    const toAsk = patch.modelSelection ? (bot.tasks ?? []).filter((task) => task.modelSelection === undefined &&
      this.switchNeedsAsk(id, task.threadId, bot.modelSelection, patch.modelSelection!)) : [];
    Object.assign(bot, patch);
    for (const task of toAsk) Object.assign(task, structuredClone(ASK_NOW));
    const task = this.activeTask(id);
    if (task) {
      for (const key of ["resumeCursors", "rewound", "pinnedMessageId", "unread"] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          Object.assign(task, { [key]: structuredClone(patch[key]) });
        }
      }
      bot.unread = bot.tasks!.some(taskCountsAsBotUnread);
    }
    if (wideningToolScope) {
      this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, toolScope: nextToolScope } : candidate));
      bot.toolScope = nextToolScope;
    } else this.saveBots();
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  clearVoiceSelections(): BotRecord[] {
    const changed = this.bots.filter((bot) => bot.voice !== undefined && bot.voice !== "");
    if (!changed.length) return [];
    const next = this.bots.map((bot) =>
      bot.voice === undefined || bot.voice === "" ? bot : { ...bot, voice: undefined });
    this.saveBots(next);
    for (const bot of changed) {
      delete bot.voice;
      this.emit({ type: "bot", botId: bot.id });
    }
    return changed;
  }

  patchBotProfile(id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch };
    if (patch.soul !== undefined) {
      next.soulHash = soulHash(patch.soul);
      next.soulDrift = false;
    }
    this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
    Object.assign(bot, next);
    if (patch.soul !== undefined) {
      try { writeSoulMirror(id, patch.soul); } catch (e) {
        console.warn(`[bot-folder] could not write SOUL.md mirror for ${id}: ${(e as Error).message}`);
      }
    }
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  setSoul(id: string, soul: string): BotRecord | null {
    return this.patchBotProfile(id, { soul });
  }

  setBotsSection(
    botIds: string[],
    section: string,
  ): { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
    const ids = [...new Set(botIds)];
    const targets = ids.map((id) => this.bot(id));
    if (targets.some((bot) => !bot || bot.hidden)) return { ok: false, reason: "unavailable" };

    const targetSection = sectionKey(section);
    const selected = targets as BotRecord[];
    const destinationChiefIds = new Set([
      ...selected.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id),
      ...this.bots
        .filter((bot) => bot.chiefOfStaff && sectionKey(bot.section) === targetSection)
        .map((bot) => bot.id),
    ]);
    if (destinationChiefIds.size > 1) return { ok: false, reason: "chief-conflict" };

    const patches = new Map<string, Partial<BotRecord>>();
    for (const bot of selected) {
      patches.set(bot.id, { section: targetSection || undefined });
    }

    const changedIds = new Set<string>();
    const nextBots = this.bots.map((bot) => {
      const patch = patches.get(bot.id);
      if (!patch) return bot;
      const next = { ...bot, ...patch };
      if (JSON.stringify(next) !== JSON.stringify(bot)) changedIds.add(bot.id);
      return next;
    });
    if (changedIds.size) {
      this.saveBots(nextBots);
      for (const bot of this.bots) {
        const patch = patches.get(bot.id);
        if (patch) Object.assign(bot, patch);
      }
      for (const botId of changedIds) this.emit({ type: "bot", botId });
    }
    this.rememberSections([targetSection]);
    return { ok: true, bots: ids.map((id) => this.bot(id)!) };
  }

  updateTeamMembers(section: string, addIds: string[], removeIds: string[]):
    { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" | "membership-changed" } {
    const key = sectionKey(section);
    if (!key || !this.sections.includes(key)) return { ok: false, reason: "unavailable" };
    const adds = new Set(addIds), removes = new Set(removeIds);
    const ids = new Set([...adds, ...removes]);
    for (const id of ids) {
      const bot = this.bot(id);
      if (!bot || bot.hidden) return { ok: false, reason: "unavailable" };
      if (adds.has(id) && removes.has(id)) return { ok: false, reason: "membership-changed" };
      if (removes.has(id) && sectionKey(bot.section) !== key) return { ok: false, reason: "membership-changed" };
    }
    const next = this.bots.map(bot => ids.has(bot.id)
      ? { ...bot, section: adds.has(bot.id) ? key : undefined } : bot);
    for (const destination of [key, ""]) {
      if (next.filter(bot => bot.chiefOfStaff && sectionKey(bot.section) === destination).length > 1) {
        return { ok: false, reason: "chief-conflict" };
      }
    }
    if (ids.size) {
      this.saveBots(next);
      for (let i = 0; i < next.length; i++) if (ids.has(next[i].id)) Object.assign(this.bots[i], next[i]);
      for (const botId of ids) this.emit({ type: "bot", botId });
    }
    return { ok: true, bots: this.bots.filter(bot => ids.has(bot.id)) };
  }

  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if ((this.legacyActivities.get(botId) ?? "idle") === activity) return bot;
    this.legacyActivities.set(botId, activity);
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  setTaskActivity(botId: string, threadId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const busy = ACTIVITY_BUSY.has(activity);
    if ((task.activity ?? "idle") === activity && Boolean(task.busy) === busy) return bot;
    const wasBusy = Boolean(task.busy);
    task.activity = activity;
    task.busy = busy;
    if (busy && !wasBusy) task.turnStartedAt = Date.now();
    else if (!busy) delete task.turnStartedAt;
    if (task.snoozedUntil === 0) {
      task.snoozedUntil = undefined;
      this.saveBots();
    }
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  private refreshBotActivity(bot: BotRecord) {
    const activities = [this.legacyActivities.get(bot.id), ...(bot.tasks ?? []).map((task) => task.activity)];
    bot.activity = (["waiting-on-you", "no-signal", "working", "dead"] as const)
      .find((activity) => activities.includes(activity)) ?? "idle";
    bot.busy = ACTIVITY_BUSY.has(bot.activity);
  }

  setChiefOfStaff(id: string | null, section?: string | null): BotRecord[] | null {
    const selected = id ? this.bot(id) : null;
    if (id && !selected) return null;
    const targetSection = sectionKey(selected?.section ?? section);
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      if (sectionKey(bot.section) !== targetSection) continue;
      const next = bot.id === id;
      if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden)) continue;
      if (next) {
        bot.chiefOfStaff = true;
        bot.hidden = false;
      } else {
        bot.chiefOfStaff = false;
        delete bot.managedSections;
      }
      changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed;
  }

  renameInstances(ids: ReadonlyMap<string, string>): number {
    const touches = (record?: Record<string, unknown>) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
    const rename = <T>(record: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {};
      for (const [key, value] of Object.entries(record)) {
        const target = ids.get(key);
        if (!target) next[key] = value;
        else if (!Object.prototype.hasOwnProperty.call(record, target)) next[target] = value;
      }
      return next;
    };
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      let dirty = false;
      const selected = ids.get(bot.modelSelection.instanceId);
      if (selected) { bot.modelSelection = { ...bot.modelSelection, instanceId: selected }; dirty = true; }
      if (touches(bot.resumeCursors)) { bot.resumeCursors = rename(bot.resumeCursors); dirty = true; }
      for (const task of bot.tasks ?? []) {
        const taskSelected = task.modelSelection && ids.get(task.modelSelection.instanceId);
        if (task.modelSelection && taskSelected) { task.modelSelection = { ...task.modelSelection, instanceId: taskSelected }; dirty = true; }
        if (touches(task.resumeCursors)) { task.resumeCursors = rename(task.resumeCursors); dirty = true; }
        if (task.handedMessages && touches(task.handedMessages)) { task.handedMessages = rename(task.handedMessages); dirty = true; }
        const last = task.lastInstanceId && ids.get(task.lastInstanceId);
        if (last) { task.lastInstanceId = last; dirty = true; }
      }
      if (dirty) changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed.length;
  }

  retireInstances(ids: ReadonlySet<string>, replacement: ModelSelection, options: {
    driverKind?: string;
    canWorkOnCloud: boolean;
    keepCloud: (bot: BotRecord) => boolean;
  }): ComputerEngineMove[] {
    const retired = (selection?: { instanceId: string }) => Boolean(selection && ids.has(selection.instanceId));
    const without = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !ids.has(key)));
    const touches = (record?: Record<string, unknown>) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
    const needsAsk = (target: Parameters<typeof approvalModeFor>[0]) =>
      modelSwitchNeedsAsk(approvalModeFor(target), REMOVED_COMPUTER_DRIVER, options.driverKind);
    const askNow = { approvalMode: "ask" as const, autoApprove: false, alwaysAllow: [] as string[] };
    const changes: Array<{ bot: BotRecord; patch: Partial<BotRecord>; tasks: Partial<TaskRecord>[] }> = [];
    const moves: ComputerEngineMove[] = [];
    for (const bot of this.bots) {
      const patch: Partial<BotRecord> = {};
      const tasks = (bot.tasks ?? []).map((): Partial<TaskRecord> => ({}));
      const botMoved = retired(bot.modelSelection);
      const keepsCloud = options.canWorkOnCloud && options.keepCloud(bot);
      let botAsk = false;
      if (botMoved) {
        if (bot.computer === undefined && keepsCloud) patch.computer = "cloud";
        if (needsAsk(bot)) { Object.assign(patch, structuredClone(askNow)); botAsk = true; }
        patch.modelSelection = structuredClone(replacement);
      }
      if (bot.fallback?.some(retired)) {
        const kept = bot.fallback.filter(candidate => !retired(candidate));
        patch.fallback = kept.length ? kept : undefined;
      }
      if (touches(bot.resumeCursors)) patch.resumeCursors = without(bot.resumeCursors);
      const computer = patch.computer ?? bot.computer;
      const cloudAfterMove = (pin: TaskRecord["surface"], pinSource: TaskRecord["surfaceSource"]): Pick<ComputerEngineMove, "cloud" | "noComputer"> => {
        const place = pin ?? bot.computer;
        const wasCloud = place === "cloud" || (place === undefined && options.keepCloud(bot));
        if (!wasCloud || options.canWorkOnCloud) return { cloud: wasCloud, noComputer: false };
        const personPin = pin !== undefined && pinSource !== "auto";
        const still = personPin ? pin : bot.computer;
        return { cloud: false, noComputer: still !== "cloud" ? "auto" : personPin ? "pin" : "works-on" };
      };
      (bot.tasks ?? []).forEach((task, index) => {
        const taskPatch = tasks[index]!;
        const before = this.projectBotForTask(bot.id, task.threadId)!;
        if (botAsk) {
          Object.assign(taskPatch, {
            approvalMode: before.approvalMode, autoApprove: before.autoApprove, alwaysAllow: structuredClone(before.alwaysAllow ?? []),
          });
        }
        const moved = task.modelSelection ? retired(task.modelSelection) : botMoved;
        if (moved) {
          if (!botMoved && computer === undefined && task.surface === undefined && keepsCloud) {
            taskPatch.surface = "cloud";
            taskPatch.surfaceSource = "auto";
          }
          if (!options.canWorkOnCloud && task.surface === "cloud" && task.surfaceSource === "auto") {
            taskPatch.surface = undefined;
            taskPatch.surfaceSource = undefined;
          }
          const ask = needsAsk(before);
          if (ask) Object.assign(taskPatch, structuredClone(askNow));
          if (task.modelSelection) taskPatch.modelSelection = structuredClone(replacement);
          const scope = botMoved && task.threadId === bot.threadId ? "bot" : "conversation";
          moves.push({ botId: bot.id, threadId: task.threadId, scope, ...cloudAfterMove(task.surface, task.surfaceSource),
            askNow: ask || (scope === "bot" && botAsk) });
        } else if (botMoved && task.threadId === bot.threadId) {
          moves.push({ botId: bot.id, threadId: task.threadId, scope: "bot-only", ...cloudAfterMove(undefined, undefined), askNow: botAsk });
        }
        if (touches(task.resumeCursors)) taskPatch.resumeCursors = without(task.resumeCursors);
        if (task.handedMessages && touches(task.handedMessages)) taskPatch.handedMessages = without(task.handedMessages);
      });
      if (Object.keys(patch).length || tasks.some(taskPatch => Object.keys(taskPatch).length)) changes.push({ bot, patch, tasks });
    }
    if (!changes.length) return moves;
    const next = new Map(changes.map(({ bot, patch, tasks }) => [bot, {
      ...bot, ...patch, tasks: bot.tasks?.map((task, index) => ({ ...task, ...tasks[index] })),
    }]));
    this.saveBots(this.bots.map(bot => next.get(bot) ?? bot));
    for (const { bot, patch, tasks } of changes) {
      bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
      Object.assign(bot, patch);
      this.emit({ type: "bot", botId: bot.id });
    }
    return moves;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (task) task.resumeCursors[instanceId] = cursor;
    if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    saveRegistryFor("bots.json", "the conversation's engine session", () => this.saveBots());
    this.emit({ type: "bot", botId });
  }

  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
    saveRegistryFor("bots.json", "which engine has this conversation", () => this.saveBots());
  }

  setHandedMessages(botId: string, threadId: string, instanceId: string, state: HandedState) {
    const task = this.taskByThread(botId, threadId);
    if (!task || JSON.stringify(task.handedMessages?.[instanceId]) === JSON.stringify(state)) return;
    const live = Object.entries(task.handedMessages ?? {})
      .filter(([id, record]) => id !== instanceId && record.session !== undefined && record.session === task.resumeCursors[id]);
    task.handedMessages = { ...Object.fromEntries(live), [instanceId]: state };
    saveRegistryFor("bots.json", "what this conversation handed its engine", () => this.saveBots());
  }

  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; context?: { tokens?: number; window?: number } },
  ): TaskUsage | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
    const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
    const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
    const prevInput = clean(prev.input);
    const turnInput = clean(turn.input);
    const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
      + Math.min(clean(turn.cachedInput), turnInput);
    const contextTokens = clean(turn.context?.tokens);
    const contextWindow = clean(turn.context?.window);
    task.usage = {
      input: prevInput + turnInput,
      output: prev.output + clean(turn.output),
      ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
      lastTurn: {
        input: turnInput, output: clean(turn.output),
        ...(typeof turn.cachedInput === "number" ? { cachedInput: Math.min(clean(turn.cachedInput), turnInput) } : {}),
        costUsd: cost,
      },
      ...(contextTokens > 0
        ? { context: { tokens: contextTokens, ...(contextWindow > 0 ? { window: contextWindow } : {}) } }
        : prev.context ? { context: prev.context } : {}),
    };
    saveRegistryFor("bots.json", "the thread's usage", () => this.saveBots());
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  unpinTaskCwd(threadId: string): boolean {
    const bot = this.botByThread(threadId);
    const task = bot ? this.taskByThread(bot.id, threadId) : undefined;
    if (!bot || !task || task.cwd === undefined) return false;
    this.commitBotChange(bot, "the thread's folder", () => { delete task.cwd; });
    this.emit({ type: "bot", botId: bot.id });
    return true;
  }

  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean; privateOnly?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.privateOnly && task.cwd === undefined) {
      const cwd = fallbackCwd ?? null;
      this.commitBotChange(bot, "the thread's folder", () => { task.cwd = cwd; });
      this.emit({ type: "bot", botId });
      return cwd;
    }
    if (opts.none) {
      if (task.cwd !== null) {
        this.commitBotChange(bot, "the thread's folder", () => { task.cwd = null; });
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd !== undefined) return task.cwd;
    const cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
    this.commitBotChange(bot, "the thread's folder", () => { task.cwd = cwd; });
    this.emit({ type: "bot", botId });
    return cwd;
  }

  pinGroupCwd(groupId: string, threadId?: string): string | null {
    const group = this.group(groupId);
    if (!group) return null;
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task) {
      if (!group.dm) return null;
      if (group.pinnedCwd !== undefined) return group.pinnedCwd;
      const cwd = group.cwd ?? null;
      this.commitGroupChange(group, "the chat's folder", () => { group.pinnedCwd = cwd; });
      this.emit({ type: "group", groupId: group.id });
      return cwd;
    }
    if (task.pinnedCwd !== undefined) return task.pinnedCwd;
    const cwd = group.cwd ?? null;
    this.commitGroupChange(group, "the thread's folder", () => {
      task.pinnedCwd = cwd;
      if (group.threadId === task.threadId) group.pinnedCwd = cwd;
    });
    this.emit({ type: "group", groupId: group.id });
    return cwd;
  }

  project(botId: string, projectId: string): BotProjectRecord | undefined {
    return this.bot(botId)?.projects?.find((project) => project.id === projectId);
  }

  createProject(botId: string, name: string, emoji?: string | null): BotProjectRecord | null {
    const bot = this.bot(botId);
    if (!bot || !name.trim() || (emoji != null && !isProjectEmoji(emoji))) return null;
    const project: BotProjectRecord = {
      id: newId(), name: name.trim().slice(0, 80),
      ...(emoji == null ? {} : { emoji }),
    };
    bot.projects = [...(bot.projects ?? []), project];
    this.saveBots();
    this.emit({ type: "bot", botId });
    return project;
  }

  patchProject(botId: string, projectId: string, patch: { name?: string; emoji?: string | null }): BotProjectRecord | null {
    const project = this.project(botId, projectId);
    if (!project || (patch.name !== undefined && !patch.name.trim()) || (patch.emoji != null && !isProjectEmoji(patch.emoji))) return null;
    if (patch.name !== undefined) project.name = patch.name.trim().slice(0, 80);
    if (patch.emoji === null) delete project.emoji;
    else if (patch.emoji !== undefined) project.emoji = patch.emoji;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return project;
  }

  reorderProjects(botId: string, projectIds: string[]): BotProjectRecord[] | null {
    const bot = this.bot(botId);
    const projects = bot?.projects ?? [];
    if (!bot || projectIds.length !== projects.length || new Set(projectIds).size !== projects.length) return null;
    const byId = new Map(projects.map((project) => [project.id, project]));
    if (projectIds.some((id) => !byId.has(id))) return null;
    bot.projects = projectIds.map((id) => byId.get(id)!);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot.projects;
  }

  /** A stable partial reorder of the fleet (shared/bot-order.ts): the listed bots take, in the order given, the positions
   * they already share; every other bot stays put. Empty, repeated or unknown ids change nothing and give null. */
  reorderBots(botIds: string[]): BotRecord[] | null {
    if (!botIds.length || new Set(botIds).size !== botIds.length) return null;
    const byId = new Map(this.bots.map((bot) => [bot.id, bot]));
    if (botIds.some((id) => !byId.has(id))) return null;
    const next = reorderStable(this.bots, botIds);
    // Mutate in place: schedulers and other consumers hold this array and its records.
    this.bots.splice(0, this.bots.length, ...next);
    this.saveBots();
    this.emit({ type: "bots.order" });
    return this.bots;
  }

  deleteProject(botId: string, projectId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !this.project(botId, projectId)) return null;
    bot.projects = bot.projects!.filter((project) => project.id !== projectId);
    for (const task of bot.tasks ?? []) {
      if (task.projectId === projectId) delete task.projectId;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
  }

  workThread(botId: string, fromBotId: string, fromThreadId: string, roomLane = false): TaskRecord | undefined {
    return this.tasks(botId).find((t) => t.openedBy?.kind === "work" && t.openedBy.botId === fromBotId &&
      t.openedBy.threadId === fromThreadId && Boolean(t.openedBy.roomLane) === roomLane && t.archivedAt === undefined);
  }

  projectBotForTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    return {
      ...bot,
      threadId: task.threadId,
      approvalGrant: bot.approvalGrant?.threadOnly && bot.approvalGrant.threadId !== threadId ? undefined : bot.approvalGrant,
      modelSelection: structuredClone(task.modelSelection ?? bot.modelSelection),
      resumeCursors: structuredClone(task.resumeCursors),
      ...threadApproval(task, bot),
      unread: Boolean(task.unread),
      rewound: task.rewound,
      pinnedMessageId: task.pinnedMessageId,
      activity: task.activity ?? "idle",
      busy: Boolean(task.busy),
    };
  }

  patchTask(botId: string, threadId: string, patch: TaskPatch): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    if (patch.projectId !== undefined && !this.project(botId, patch.projectId)) return null;
    const revocation = keptRevocation(threadApproval(task, bot), threadApproval({ ...task, ...patch }, bot), patch);
    this.commitBotChange(bot, "the thread change", () => {
      for (const key of TASK_PATCH_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          Object.assign(task, { [key]: structuredClone(patch[key]) });
        }
      }
      if (task.snoozedUntil === 0 && patch.unread === true) task.snoozedUntil = undefined;
      if (typeof patch.title === "string") task.title = patch.title.trim().slice(0, 80) || UNTITLED_THREAD;
      if (Object.prototype.hasOwnProperty.call(patch, "pinned") && task.pinned !== true) delete task.pinned;
      if (task.routineRunId) task.unread = false;
      if (bot.threadId === threadId) this.mirrorActiveTask(bot, task);
      bot.unread = bot.tasks!.some(taskCountsAsBotUnread);
    }, revocation && (() => Object.assign(task, revocation)));
    this.emit({ type: "bot", botId });
    return task;
  }

  suggestTaskLink(botId: string, threadId: string, text: string): TaskRecord | null {
    const url = lastChangeRequestUrl(text);
    const task = this.taskByThread(botId, threadId);
    if (!url || !task || task.linkAuto === false || (task.link && !task.linkAuto) || task.link === url) return null;
    return this.patchTask(botId, threadId, { link: url, linkAuto: true });
  }

  clearAutoSurfacePins(botId: string, destination: Destination): number {
    const bot = this.bot(botId);
    const stale = bot?.tasks?.filter((task) => task.surface !== undefined && task.surfaceSource === "auto" && task.surface !== destination) ?? [];
    if (!bot || !stale.length) return 0;
    this.commitBotChange(bot, "the threads' destinations", () => {
      for (const task of stale) {
        task.surface = undefined;
        task.surfaceSource = undefined;
      }
    });
    this.emit({ type: "bot", botId });
    return stale.length;
  }

  switchTaskModel(botId: string, threadId: string, selection: ModelSelection,
    updateBotDefault: boolean, resetApprovalToAsk: boolean, taskPatch: TaskPatch = {}): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const approval = resetApprovalToAsk ? structuredClone(ASK_NOW) : {};
    const own = sameModelSelection(selection, updateBotDefault ? selection : bot.modelSelection) ? undefined : structuredClone(selection);
    const nextTask = persistedPin({ ...task, ...taskPatch, modelSelection: own, ...approval,
      ...(typeof taskPatch.title === "string" ? { title: taskPatch.title.trim().slice(0, 80) || UNTITLED_THREAD } : {}) });
    const others = updateBotDefault ? this.withDefaultModel(bot, selection)! : bot.tasks!;
    const nextTasks = bot.tasks!.map((candidate, index) => candidate === task ? nextTask : others[index]!);
    const botPatch = updateBotDefault ? { modelSelection: structuredClone(selection), ...approval } : {};
    this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, ...botPatch, tasks: nextTasks } : candidate));
    bot.tasks!.forEach((candidate, index) => Object.assign(candidate, nextTasks[index]));
    Object.assign(bot, botPatch);
    this.emit({ type: "bot", botId });
    return task;
  }

  followBotModel(botId: string, threadIds: readonly string[],
    reset: (from: ModelSelection, to: ModelSelection) => Partial<TaskRecord> = () => ({})): string[] {
    const bot = this.bot(botId);
    if (!bot?.tasks) return [];
    const listed = new Set(threadIds);
    const patches = bot.tasks.map((task): Partial<TaskRecord> | null => !listed.has(task.threadId) || task.modelSelection === undefined ? null : {
      ...reset(task.modelSelection, bot.modelSelection),
      modelSelection: undefined,
      ...(this.switchNeedsAsk(botId, task.threadId, task.modelSelection, bot.modelSelection) ? structuredClone(ASK_NOW) : {}),
    });
    const moved = bot.tasks.filter((_, index) => patches[index]).map((task) => task.threadId);
    if (!moved.length) return [];
    const nextTasks = bot.tasks.map((task, index) => patches[index] ? { ...task, ...patches[index] } : task);
    this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, tasks: nextTasks } : candidate));
    bot.tasks.forEach((task, index) => { if (patches[index]) Object.assign(task, patches[index]); });
    const active = bot.tasks.find((task) => task.threadId === bot.threadId);
    if (active) this.mirrorActiveTask(bot, active);
    this.emit({ type: "bot", botId });
    return moved;
  }

  setAllThreadApprovalMode(botId: string, mode: Exclude<ApprovalMode, "custom">): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const patch = { approvalMode: mode, autoApprove: mode === "auto", ...(mode === "full" ? { alwaysAllow: [] } : {}) };
    const tasks = (bot.tasks ?? []).map(task => ({ ...task, ...patch }));
    const next = { ...bot, ...patch, approvalGrant: undefined, tasks };
    this.saveBots(this.bots.map(candidate => candidate === bot ? next : candidate));
    bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
    Object.assign(bot, patch, { approvalGrant: undefined });
    this.emit({ type: "bot", botId });
    return bot;
  }

  refreshTaskPermissions(botId: string, threadId: string): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const mode = approvalModeFor({ ...bot, approvalGrant: undefined });
    const alwaysAllow = structuredClone(bot.alwaysAllow ?? []);
    const autoApprove = mode === "auto";
    const sameAllow = JSON.stringify(task.alwaysAllow ?? []) === JSON.stringify(alwaysAllow);
    if (task.approvalMode === mode && task.autoApprove === autoApprove && sameAllow) return task;
    return this.patchTask(botId, threadId, { approvalMode: mode, autoApprove, alwaysAllow });
  }

  private mirrorActiveTask(bot: BotRecord, task: TaskRecord) {
    bot.threadId = task.threadId;
    bot.resumeCursors = structuredClone(task.resumeCursors);
    bot.rewound = task.rewound;
    bot.pinnedMessageId = task.pinnedMessageId;
  }

  createTask(botId: string, title?: string, activate = true, projectId?: string, openedBy?: TaskOpenedBy, approvalMode?: "ask" | "full",
    modelSelection?: ModelSelection, cwd?: string): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if (projectId !== undefined && !this.project(botId, projectId)) return null;
    const task = this.buildTask(bot, title, projectId, openedBy, approvalMode, modelSelection, cwd);
    this.commitBotChange(bot, "the new thread", () => {
      bot.tasks = [task, ...(bot.tasks ?? [])];
      if (activate) this.mirrorActiveTask(bot, task);
    });
    this.emit({ type: "bot", botId });
    return task;
  }

  private buildTask(bot: BotRecord, title?: string, projectId?: string, openedBy?: TaskOpenedBy, approvalMode?: "ask" | "full",
    modelSelection?: ModelSelection, cwd?: string): TaskRecord {
    const createdAt = Date.now();
    return {
      threadId: newId(),
      title: threadTitleFrom(title),
      createdAt,
      updatedAt: createdAt,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(projectId ? { projectId } : {}),
      ...(openedBy ? { openedBy: structuredClone(openedBy) } : {}),
      resumeCursors: {},
      ...(modelSelection && !sameModelSelection(modelSelection, bot.modelSelection) ? { modelSelection: structuredClone(modelSelection) } : {}),
      approvalMode: approvalMode ?? approvalModeFor(bot),
      autoApprove: approvalMode ? false : Boolean(bot.autoApprove),
      alwaysAllow: approvalMode ? [] : [...(bot.alwaysAllow ?? [])],
      unread: false,
      activity: "idle",
      busy: false,
    };
  }

  setTaskOpenedBy(botId: string, threadId: string, openedBy: TaskOpenedBy): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    this.commitBotChange(bot, "who opened the thread", () => { task.openedBy = structuredClone(openedBy); });
    this.emit({ type: "bot", botId });
    return task;
  }

  setTaskAskedAt(botId: string, threadId: string, at: number): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task || !Number.isFinite(at) || (task.askedAt ?? -1) >= at) return task ?? null;
    task.askedAt = at;
    saveRegistryFor("bots.json", "when you last wrote in this thread", () => this.saveBots());
    this.emit({ type: "bot", botId });
    return task;
  }

  setTaskClosedBy(botId: string, threadId: string, closedBy: TaskClosedBy | null): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    if (!closedBy && !task.closedBy) return task;
    this.commitBotChange(bot, "who closed the thread", () => {
      if (closedBy) task.closedBy = structuredClone(closedBy);
      else delete task.closedBy;
    });
    this.emit({ type: "bot", botId });
    return task;
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    this.commitBotChange(bot, "the thread switch", () => this.mirrorActiveTask(bot, task));
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    return this.patchTask(botId, threadId, { title });
  }

  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string): TaskRecord | null {
    const bot = this.bot(botId);
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!bot || !task || task.titleFromFirstMessage || (task.title !== UNTITLED_TASK && task.title !== UNTITLED_THREAD)) return null;
    this.commitBotChange(bot, "the thread's title", () => {
      task.title = titleFromMessage(text);
      task.titleFromFirstMessage = true;
    });
    this.emit({ type: "bot", botId });
    return task;
  }

  retitleTask(botId: string, threadId: string, machineTitle: string, title: string): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.title !== machineTitle) return null;
    return this.renameTask(botId, threadId, threadTitleFrom(title));
  }

  deleteTask(botId: string, threadId: string): BotRecord | null {
    const result = this.deleteTasks(botId, [threadId]);
    return result?.deleted.length ? result.bot : null;
  }

  /** Transcript rows and bots.json commit together, so either failing leaves every task, log file and subscriber untouched. */
  deleteTasks(botId: string, threadIds: string[]): { bot: BotRecord; deleted: string[]; missing: string[] } | null {
    const bot = this.bot(botId);
    if (!bot?.tasks) return null;
    const present = new Set(bot.tasks.map((t) => t.threadId));
    const unique = [...new Set(threadIds)];
    const deleted = unique.filter((id) => present.has(id));
    const missing = unique.filter((id) => !present.has(id));
    if (!deleted.length) return { bot, deleted, missing };
    const doomed = new Set(deleted);
    mdb.deleteThreads(deleted, () => this.commitBotChange(bot, "the thread deletion", () => {
      const kept = bot.tasks!.filter((t) => !doomed.has(t.threadId));
      const visible = nextOpenThread(kept) ?? this.buildTask(bot);
      bot.tasks = kept.includes(visible) ? kept : [visible, ...kept];
      if (doomed.has(bot.threadId) || this.taskByThread(botId, bot.threadId)?.routineRunId) this.mirrorActiveTask(bot, visible);
      bot.unread = bot.tasks.some(taskCountsAsBotUnread);
      this.refreshBotActivity(bot);
    }));
    for (const id of deleted) this.deleteThreadRecord(id, true);
    this.emit({ type: "bot", botId });
    return { bot, deleted, missing };
  }

  needsSeed() { return this.bots.length === 0; }

  /** A new place's first bot is its MausBot and its Chief; a Team Cloud's (`defaultBot: false`) is the team's Chief only. */
  seedIfEmpty({ defaultBot = true }: { defaultBot?: boolean } = {}) {
    if (!this.needsSeed()) return;
    if (defaultBot) createDefaultBot(this, { chief: (id) => this.setChiefOfStaff(id) }); else this.setChiefOfStaff(this.createBot().id);
  }
}

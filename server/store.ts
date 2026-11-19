// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { mkdirSync, unlinkSync } from "node:fs";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { join } from "node:path";

import { DATA_DIR, LEGACY_CLOUD_COMPUTER_DRIVER } from "./config.ts";
import { newId, type Attachment, type ModelSelection, type ThreadId } from "./contracts.ts";
import { DEFAULT_BOTS } from "./default-bots.ts";
import { pickBotName } from "./names.ts";

export type { Attachment } from "./contracts.ts";

export type MausColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral"
  | "mint";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type MausExpression = string;

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
  /** Explicit consent must wait for a click; never idle auto-approve. */
  approvalSource?: "studio";
  /** permission cards: the tool asking (what "Always allow" remembers) */
  tool?: string;
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
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  scheduled?: { scheduleId: string; deliveryId: string };
  steered?: "pending" | "native" | "restarted" | "queued" | "cancelled" | "failed";
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" in the caller's chat, linking to the
   * bot⇄bot channel where the exchange is mirrored. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
}

/** A room: a shared thread where several bots + the user talk. Bots reply
 * only when @mentioned (the Buzz rule). The bulletin is the room's shared
 * instructions — every member's turn gets it as part of its system prompt. */
export type RoomHandoffs = "inherit" | "on" | "off";
/** Handoffs in a row before a room pauses for the user. Mentions are always
 * answered below this; it only stops two bots looping on each other. */
export const ROOM_MAX_HOPS = 25;
export const ROOM_DEFAULT_HOPS = 10;
/** The 1–3 "handoff depth" setting this replaced; such values are dropped. */
const LEGACY_MAX_HOPS = 3;
export const ROOM_IDLE_MINUTES_MAX = 180;

export interface GroupRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  memberIds: string[];
  bulletin: string;
  /** Agent-authored @mentions may queue teammates: "inherit" follows the
   * app-wide setting, "on"/"off" override it for this room. */
  handoffs: RoomHandoffs;
  /** Member who answers a user message with no @mention (null = nobody). */
  defaultResponderId?: string | null;
  /** Safety cap on chained bot→bot handoffs from one user message (default ROOM_DEFAULT_HOPS). */
  maxHops?: number;
  /** Per-room inactivity window for a turn, in minutes (null = app default). */
  turnIdleMinutes?: number | null;
  unread: boolean;
  createdAt: number;
  /** true for auto-created bot⇄bot channels (ask_bot exchanges live here;
   * the user can open the channel and chip in) */
  dm?: boolean;
  /** transient: the member currently running a turn (never persisted) */
  busyBotId?: string | null;
  /** transient: ordered responders waiting behind the active member */
  queuedBotIds?: string[];
  /** the room's shared task-board project, for the room's Tasks panel */
  projectId?: string | null;
}

export interface BotRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  unread: boolean;
  modelSelection: ModelSelection;
  backupModelSelection?: ModelSelection;
  onUsageLimit?: "backup" | "wait" | "stop";
  usingBackup?: boolean;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** Unset uses this computer when the desktop bridge is available. */
  computer?: "local" | "off";
  /** Tools the user chose "Always allow" for; their permission asks are approved without a card. */
  alwaysAllowedTools?: string[];
  /** true after an edit/branch-switch rewound the visible conversation:
   * provider sessions still hold the abandoned branch, so the next turn
   * must start fresh (drop cursors) and replay the surviving path. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  busy?: boolean;
  createdAt: number;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
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
  "mint",
];

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, names match case-insensitively, longest name wins (so "@New Bot 2"
 * never half-matches "New Bot"), hidden bots skipped, results deduped.
 * Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && /[\w.@/\\]/.test(text[at - 1])) continue; // user@host, URLs and mid-word @ are not tags
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => rest.startsWith(p.name.toLowerCase()));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Teammates a bot's reply hands off to: its @mentions outside code. */
export function handoffMentions<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const textWithoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
  return mentionedBots(textWithoutCode, peers);
}

export function automaticHandoffBots<T extends { name: string; hidden?: boolean }>(
  enabled: boolean,
  text: string,
  peers: T[],
): T[] {
  return enabled ? handoffMentions(text, peers) : [];
}

const onboardingCard = (): OptionCardData => ({
  title: "What do you mostly want help with?",
  subtitle: "Pick whatever's closest; we can always expand from there.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});

/** Messages form a tree (forks appear when a message is edited); the
 * visible conversation is the path from the root to activeLeafId. */
interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads = new Map<string, ThreadState>();
  private defaultSelection: () => ModelSelection;

  constructor(defaultSelection: () => ModelSelection, removedComputerInstances: ReadonlySet<string> = new Set(["computer", LEGACY_CLOUD_COMPUTER_DRIVER])) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    this.bots = readJsonFile<BotRecord[]>(BOTS_FILE, []);
    this.groups = readJsonFile<GroupRecord[]>(GROUPS_FILE, []);
    // busy never survives a restart — no turn does either
    let migrated = false;
    for (const b of this.bots) {
      b.busy = false;
      if (!["backup", "wait", "stop"].includes(b.onUsageLimit ?? "")) { b.onUsageLimit = "stop"; migrated = true; }
      if ((b.computer as string | undefined) === "cloud") {
        delete b.computer;
        migrated = true;
      }
      if (removedComputerInstances.has(b.modelSelection.instanceId)) {
        b.modelSelection = this.defaultSelection();
        this.appendMessage(b.threadId, {
          role: "bot", kind: "text",
          text: `This Buddy used the cloud computer, which has been removed. It now uses ${b.modelSelection.label ?? b.modelSelection.model}.`,
        });
        migrated = true;
      }
    }
    if (migrated) this.saveBots();
    let groupsMigrated = false;
    for (const g of this.groups) {
      // legacy boolean: no UI ever set it, so `false` was only the creation
      // default and was never honoured — treat it as "follow the app setting"
      const legacy = g as GroupRecord & { autoHandoffs?: boolean };
      if (!["inherit", "on", "off"].includes(g.handoffs)) {
        g.handoffs = legacy.autoHandoffs === true ? "on" : "inherit";
        groupsMigrated = true;
      }
      if ("autoHandoffs" in legacy) { delete legacy.autoHandoffs; groupsMigrated = true; }
      // the old depth cut real back-and-forth short; fall back to the default cap
      if (g.maxHops !== undefined && g.maxHops <= LEGACY_MAX_HOPS) { delete g.maxHops; groupsMigrated = true; }
      if (g.defaultResponderId && !g.memberIds.includes(g.defaultResponderId)) g.defaultResponderId = null;
      g.busyBotId = null;
      g.queuedBotIds = [];
    }
    if (groupsMigrated) this.saveGroups();
  }

  private saveBots() {
    writeJsonAtomic(BOTS_FILE, this.bots);
  }

  private saveGroups() {
    writeJsonAtomic(
      GROUPS_FILE,
      this.groups.map(({ busyBotId, queuedBotIds, ...g }) => g),
    );
  }

  // ── groups ────────────────────────────────────────────────────────────
  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groups.find((g) => g.threadId === threadId);
  }

  createGroup(name: string, memberIds: string[], dm = false): GroupRecord {
    const group: GroupRecord = {
      id: newId(),
      threadId: newId(),
      name,
      memberIds,
      bulletin: "",
      handoffs: "inherit",
      unread: false,
      createdAt: Date.now(),
      dm: dm || undefined,
      busyBotId: null,
      queuedBotIds: [],
    };
    this.groups.unshift(group);
    this.saveGroups();
    return group;
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "bulletin" | "handoffs" | "defaultResponderId" | "maxHops" | "turnIdleMinutes" | "unread" | "busyBotId" | "queuedBotIds" | "projectId">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    Object.assign(group, patch);
    this.saveGroups();
    return group;
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.threads.delete(group.threadId);
    this.saveGroups();
    try {
      unlinkSync(messagesFile(group.threadId));
    } catch {}
    return true;
  }

  /** Toggle an emoji reaction on a message ("user" or a member botId). */
  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!existing) return null;
    const reactions = existing.reactions ?? [];
    const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
    const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  private thread(threadId: string): ThreadState {
    let t = this.threads.get(threadId);
    if (t) return t;
    let messages: Message[] = [];
    let activeLeafId: string | null = null;
    const raw = readJsonFile<any>(messagesFile(threadId), null);
    if (Array.isArray(raw)) messages = raw; // pre-branching flat file
    else if (raw) {
      messages = raw.messages ?? [];
      activeLeafId = raw.activeLeafId ?? null;
    }
    // legacy rows carry no parentId — chain them in array order
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
    t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  private saveThread(threadId: string) {
    const t = this.thread(threadId);
    writeJsonAtomic(messagesFile(threadId), { activeLeafId: t.activeLeafId, messages: t.messages });
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  activeLeaf(threadId: string): string | null {
    return this.thread(threadId).activeLeafId;
  }

  /** Keep a thread addressable while irreversibly replacing its transcript. */
  clearThread(threadId: string): void {
    this.threads.set(threadId, { messages: [], activeLeafId: null });
    this.saveThread(threadId);
    const bot = this.botByThread(threadId);
    if (bot) {
      bot.resumeCursors = {};
      bot.rewound = false;
      bot.unread = false;
      this.saveBots();
    }
    const group = this.groupByThread(threadId);
    if (group) {
      group.unread = false;
      this.saveGroups();
    }
  }

  /** The visible conversation: root → activeLeafId. */
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

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...message };
    t.messages.push(full);
    t.activeLeafId = full.id;
    this.saveThread(threadId);
    return full;
  }

  /** Fork the conversation: a new user message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf. */
  branchMessage(threadId: string, sourceId: string, text: string, attachments?: Attachment[]): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: "user",
      kind: "text",
      text,
      attachments: attachments !== undefined ? attachments : source.attachments,
      parentId: source.parentId ?? null,
    };
    t.messages.push(full);
    t.activeLeafId = full.id;
    this.saveThread(threadId);
    return full;
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
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
    this.saveThread(threadId);
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    t.messages[idx] = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    this.saveThread(threadId);
    return t.messages[idx];
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId) ?? null;
  }

  createBot(): BotRecord {
    const name = pickBotName(this.bots.map((b) => b.name));
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name,
      title: "",
      description: "",
      notifications: true,
      color: COLORS[this.bots.length % COLORS.length],
      unread: false,
      modelSelection: this.defaultSelection(),
      onUsageLimit: "wait",
      resumeCursors: {},
      createdAt: Date.now(),
    };
    this.bots.unshift(bot);
    this.saveBots();
    this.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: `Hey — I'm ${name}. Nice to meet you.`,
    });
    this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    this.threads.delete(bot.threadId);
    this.saveBots();
    try {
      unlinkSync(messagesFile(bot.threadId));
    } catch {}
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    this.saveBots();
    return bot;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown) {
    const bot = this.bot(botId);
    if (!bot) return;
    bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
  }

  /** First-run seed: the default team, so the app opens with a ready-made
   * roster. The lead bot also carries the onboarding card. */
  seedIfEmpty() {
    if (this.bots.length) return;
    const now = Date.now();
    DEFAULT_BOTS.forEach((preset, i) => {
      const bot: BotRecord = {
        id: newId(),
        threadId: newId(),
        name: preset.name,
        title: preset.title,
        description: preset.description,
        notifications: true,
        color: preset.color,
        unread: false,
        modelSelection: this.defaultSelection(),
      onUsageLimit: "wait",
        resumeCursors: {},
        pinned: preset.pinned,
        createdAt: now - i, // newest first, matching createBot's ordering
      };
      this.bots.push(bot);
      this.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `Hey — I'm ${preset.name}, your ${preset.title}. Nice to meet you.`,
      });
      if (i === 0) this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    });
    this.saveBots();
  }
}

// Who may see a bot on a shared workspace: absent/"everyone", "admins", or { people: [...] } plus admins. Access control,
// not an approval gate; the owner, a session-less local service and admin sessions see every bot (on a Team Cloud an
// admin still sees only their own private chats, never another person's: audience.ts). A member sees a room
// only when they can see every bot in it, and bots reach each other only with the same audience (sameAudience): a room
// transcript or a delegation would otherwise carry a restricted bot's words to people who cannot see it.
import { z } from "zod";

import type { BotVisibility } from "../shared/wire.ts";
import { audienceIncludes, type Audience } from "./audience.ts";

export type { BotVisibility };

/** A Team Cloud's audiences (audience.ts): each conversation's, and the viewing person's key. */
export interface ThreadAudiences {
  of(threadId: string): Audience | undefined;
  person: string | null;
}

/** `all`: every bot and room. On a Team Cloud an admin session is `all` with its address, and still sees only the
 * conversations its person may (audience.ts): its own private chats, never another person's. */
export type Viewer = { kind: "all"; email?: string } | { kind: "member"; email?: string };

export const SEES_EVERYTHING: Viewer = { kind: "all" };

export const MAX_VISIBILITY_PEOPLE = 500;
const ENTRY = /^(?:[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+|@[^\s@,;<>"]+\.[^\s@,;<>"]+)$/;

const peopleSchema = z.object({ people: z.array(z.string().max(320)).max(MAX_VISIBILITY_PEOPLE) }).strict();

/** null and "everyone" are stored as "everyone" so every client's copy changes; an empty people list means admins only, never everyone. */
export function parseVisibility(value: unknown):
  | { ok: true; visibility: BotVisibility }
  | { ok: false; error: string } {
  if (value === null || value === "everyone") return { ok: true, visibility: "everyone" };
  if (value === "admins") return { ok: true, visibility: "admins" };
  const parsed = peopleSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: `visibility must be "everyone", "admins", or { "people": [email addresses] } with at most ${MAX_VISIBILITY_PEOPLE} entries` };
  }
  const people: string[] = [];
  for (const raw of parsed.data.people) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (!ENTRY.test(entry)) return { ok: false, error: `"${raw.slice(0, 80)}" is not an email address or @domain` };
    if (!people.includes(entry)) people.push(entry);
  }
  return { ok: true, visibility: people.length ? { people } : "admins" };
}

/** Anything unrecognised fails closed to admins only: a hand-edited or damaged field must never widen access. */
export function storedVisibility(value: unknown): BotVisibility {
  if (value === undefined || value === null || value === "everyone") return "everyone";
  if (value === "admins") return "admins";
  const parsed = parseVisibility(value);
  return parsed.ok ? parsed.visibility : "admins";
}

export function isRestricted(value: unknown): boolean {
  return storedVisibility(value) !== "everyone";
}

function entryMatches(entry: string, email: string): boolean {
  return entry.startsWith("@") ? email.endsWith(entry) && email.length > entry.length : entry === email;
}

export function viewerSees(viewer: Viewer, visibility: unknown): boolean {
  if (viewer.kind === "all") return true;
  const stored = storedVisibility(visibility);
  if (stored === "everyone") return true;
  if (stored === "admins") return false;
  const email = viewer.email?.trim().toLowerCase();
  return Boolean(email && email.includes("@") && stored.people.some((entry) => entryMatches(entry, email)));
}

export function sameAudience(a: unknown, b: unknown): boolean {
  const left = storedVisibility(a);
  const right = storedVisibility(b);
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.people.length !== right.people.length) return false;
  const set = new Set(left.people);
  return right.people.every((entry) => set.has(entry));
}

export function audienceWithin(inner: unknown, outer: unknown): boolean {
  const small = storedVisibility(inner);
  const large = storedVisibility(outer);
  if (large === "everyone" || small === "admins") return true;
  if (small === "everyone" || large === "admins") return false;
  return small.people.every((entry) =>
    large.people.includes(entry) || (!entry.startsWith("@") && large.people.some((other) => other.startsWith("@") && entryMatches(other, entry))));
}

/** An intersection that names nobody is admins only. */
export function intersectAudience(a: unknown, b: unknown): BotVisibility {
  const left = storedVisibility(a);
  const right = storedVisibility(b);
  if (left === "everyone") return right;
  if (right === "everyone") return left;
  if (left === "admins" || right === "admins") return "admins";
  const kept = [
    ...left.people.filter((entry) => audienceWithin({ people: [entry] }, right)),
    ...right.people.filter((entry) => audienceWithin({ people: [entry] }, left)),
  ];
  const people = [...new Set(kept)];
  return people.length ? { people } : "admins";
}

export function narrowestAudience(values: readonly unknown[]): BotVisibility {
  return values.reduce<BotVisibility>((floor, value) => intersectAudience(floor, value), "everyone");
}

export function audienceEquals(a: unknown, b: unknown): boolean {
  return sameAudience(a, b);
}

/** Only when everyone who can see the bot can see every bot in the room; otherwise recall leaks a restricted bot's room words. */
export function roomFeeds(memberVisibilities: readonly unknown[], botVisibility: unknown): boolean {
  return memberVisibilities.every((visibility) => audienceWithin(botVisibility, visibility));
}

export interface VisibilityBot {
  id: string;
  threadId: string;
  visibility?: unknown;
  section?: string;
  avatarUrl?: string | null;
  tasks?: ReadonlyArray<{ threadId: string }>;
}

export interface VisibilityGroup {
  id: string;
  threadId: string;
  memberIds: readonly string[];
  section?: string;
  tasks?: ReadonlyArray<{ threadId: string }>;
  /** The narrowest audience the room has had: a bot leaving never widens it, only an admin's explicit reset. */
  audienceFloor?: unknown;
}

export type ThreadOwner = { bot: string; group?: undefined } | { group: string; bot?: undefined };

export class VisibleSet {
  readonly everything: boolean;
  private readonly bots = new Map<string, VisibilityBot>();
  private readonly groups = new Map<string, VisibilityGroup>();
  private readonly viewer: Viewer;
  private readonly ownerOf: (threadId: string) => ThreadOwner | undefined;
  private readonly audiences: ThreadAudiences | null;
  private threads: Map<string, ThreadOwner> | null = null;
  private readonly botMemo = new Map<string, boolean>();

  constructor(
    bots: readonly VisibilityBot[],
    groups: readonly VisibilityGroup[],
    viewer: Viewer,
    ownerOf?: (threadId: string) => ThreadOwner | undefined,
    audiences?: ThreadAudiences,
  ) {
    this.viewer = viewer;
    this.audiences = audiences ?? null;
    // On a Team Cloud nobody's view is everything, an admin's included: each conversation has its own audience.
    this.everything = this.audiences === null && (viewer.kind === "all" ||
      (!bots.some((bot) => isRestricted(bot.visibility)) && !groups.some((group) => isRestricted(group.audienceFloor))));
    this.ownerOf = ownerOf ?? ((threadId) => this.indexedOwner(threadId));
    if (this.everything) return;
    for (const bot of bots) this.bots.set(bot.id, bot);
    for (const group of groups) this.groups.set(group.id, group);
  }

  /** A non-admin session, even one that can see every bot: what only an admin reads still stays off its copy. */
  get member(): boolean {
    return this.viewer.kind === "member";
  }

  bot(id: string): boolean {
    if (this.everything || this.viewer.kind === "all") return true;
    let seen = this.botMemo.get(id);
    if (seen === undefined) {
      const bot = this.bots.get(id);
      seen = Boolean(bot && viewerSees(this.viewer, bot.visibility));
      this.botMemo.set(id, seen);
    }
    return seen;
  }

  group(id: string): boolean {
    if (this.everything || this.viewer.kind === "all") return true;
    const group = this.groups.get(id);
    if (!group) return false;
    const members = group.memberIds.filter((member) => this.bots.has(member));
    return members.length > 0 && members.every((member) => this.bot(member)) && viewerSees(this.viewer, group.audienceFloor);
  }

  /** Conversations have audiences of their own (a Team Cloud): a bot's tasks are then filtered one by one. */
  get filtersThreads(): boolean {
    return this.audiences !== null;
  }

  /** An unknown thread is not visible to a member; on a Team Cloud another person's conversation is visible to nobody,
   * an admin included. */
  thread(threadId: string): boolean {
    if (this.everything) return true;
    const owner = this.ownerOf(threadId);
    // An admin reads what no bot or room holds (a deleted conversation's records) unless it was someone else's.
    if (!owner) return this.viewer.kind === "all" && this.audienceShows(threadId);
    const seen = owner.bot !== undefined ? this.bot(owner.bot) : this.group(owner.group);
    return seen && this.audienceShows(threadId);
  }

  /** A conversation that is someone else's, there or deleted: what a request or a row naming it is refused for. */
  hides(threadId: string): boolean {
    if (this.everything) return false;
    return this.ownerOf(threadId) !== undefined ? !this.thread(threadId) : !this.audienceShows(threadId);
  }

  private audienceShows(threadId: string): boolean {
    const audience = this.audiences?.of(threadId);
    return audience === undefined || audienceIncludes(audience, { admin: this.viewer.kind === "all", person: this.audiences!.person, seesRoom: (groupId) => this.group(groupId) });
  }

  private indexedOwner(threadId: string): ThreadOwner | undefined {
    if (!this.threads) {
      const threads = new Map<string, ThreadOwner>();
      for (const bot of this.bots.values()) {
        threads.set(bot.threadId, { bot: bot.id });
        for (const task of bot.tasks ?? []) threads.set(task.threadId, { bot: bot.id });
      }
      for (const group of this.groups.values()) {
        if (!threads.has(group.threadId)) threads.set(group.threadId, { group: group.id });
        for (const task of group.tasks ?? []) if (!threads.has(task.threadId)) threads.set(task.threadId, { group: group.id });
      }
      this.threads = threads;
    }
    return this.threads.get(threadId);
  }

  sections(all: readonly string[]): string[] {
    if (this.everything || this.viewer.kind === "all") return [...all];
    const key = (value?: string) => value?.trim() || "";
    const shown = new Set<string>();
    for (const bot of this.bots.values()) if (this.bot(bot.id)) shown.add(key(bot.section));
    for (const group of this.groups.values()) if (this.group(group.id)) shown.add(key(group.section));
    return all.filter((section) => shown.has(key(section)));
  }

  /** Refused only when everything referencing it is hidden; an unreferenced one (a member's own upload) is served, its name is random. */
  attachment(name: string, threadsReferencing: (name: string) => readonly string[]): boolean {
    if (this.everything) return true;
    const url = `/api/attachments/${name}`;
    let referenced = false;
    for (const bot of this.bots.values()) {
      if (bot.avatarUrl !== url) continue;
      if (this.bot(bot.id)) return true;
      referenced = true;
    }
    for (const threadId of threadsReferencing(name)) {
      if (this.thread(threadId)) return true;
      referenced = true;
    }
    return !referenced;
  }
}

export type PathSubject =
  | { kind: "bot"; id: string }
  | { kind: "thread"; id: string }
  | { kind: "group"; id: string }
  | { kind: "routine"; id: string }
  | { kind: "routine-run"; id: string }
  | { kind: "attachment"; name: string };

export function pathSubject(path: string): PathSubject | null {
  let m = /^\/api\/bots\/([\w-]+)(?:\/|$)/.exec(path);
  if (m) return { kind: "bot", id: m[1]! };
  m = /^\/api\/threads\/([\w-]+)(?:\/|$)/.exec(path);
  if (m) return { kind: "thread", id: m[1]! };
  m = /^\/api\/groups\/([\w-]+)(?:\/|$)/.exec(path);
  if (m) return { kind: "group", id: m[1]! };
  m = /^\/api\/routines\/([\w-]+)(?:\/|$)/.exec(path);
  if (m && m[1] !== "wake") return { kind: "routine", id: m[1]! };
  m = /^\/api\/routine-runs\/([\w-]+)\//.exec(path);
  if (m && m[1] !== "seen-all") return { kind: "routine-run", id: m[1]! };
  m = /^\/api\/attachments\/([\w.-]+)$/.exec(path);
  if (m) return { kind: "attachment", name: m[1]! };
  return null;
}

/** The conversations a request names outside `/api/threads/<id>` (pathSubject): a bot's or a room's task in the path,
 * and `?threadId=`. */
export function requestThreadIds(path: string, query: URLSearchParams): string[] {
  const ids = query.getAll("threadId").filter(Boolean);
  const task = /^\/api\/(?:bots|groups)\/[\w-]+\/tasks\/([\w-]+)(?:\/|$)/.exec(path);
  return task ? [task[1]!, ...ids] : ids;
}

const THREAD_FIELD = /^(?:threadId|[A-Za-z]+ThreadId)$/;

/** The conversations a JSON body names: `threadId`, any `…ThreadId` and `threadIds`, at its top and one level down. */
export function bodyThreadIds(body: unknown, depth = 1): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const ids: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" && THREAD_FIELD.test(key)) ids.push(value);
    else if (key === "threadIds" && Array.isArray(value)) ids.push(...value.filter((id): id is string => typeof id === "string"));
    else if (depth > 0 && value && typeof value === "object") ids.push(...bodyThreadIds(value, depth - 1));
  }
  return ids;
}

/** The same "not found" an unknown id gets, so a member cannot tell a restricted bot from a missing one. */
export function notFoundFor(subject: PathSubject): string {
  switch (subject.kind) {
    case "bot": return "no such bot";
    case "thread": return "no such conversation";
    case "group": return "no such channel";
    case "routine": return "no such routine";
    case "routine-run": return "no such active run";
    case "attachment": return "no such attachment";
  }
}

// Per-member SSE: a bot that becomes hidden is withdrawn once (as bot.deleted), and nothing about a bot the member never saw is sent.

export interface StreamSeen {
  bots: Set<string>;
  groups: Set<string>;
}

export interface FrameContext {
  visible: VisibleSet;
  webhook: (webhookId: string) => { botId: string; groupId?: string } | undefined;
  freshBot: (botId: string) => Record<string, unknown> | undefined;
  freshGroup: (groupId: string) => Record<string, unknown> | undefined;
}

/** No audience list (who else may see a bot is an admin's business), no teammate ids the member cannot see, and no
 * server alias: a member learns the default VPS alias only as configured-or-not, and a bot's own alias the same way.
 * On a Team Cloud an admin gets the bot whole but, like a member, only the conversations they may read. */
export function memberBot<T extends object>(bot: T, visible: VisibleSet): T {
  if (visible.everything) return visible.member ? withoutServerAlias(bot) : bot;
  const shown = visible.filtersThreads ? shownConversations(bot, visible) : bot;
  if (!visible.member) return shown;
  const { visibility: _visibility, vpsAlias: _vpsAlias, ...rest } = shown as T & { visibility?: unknown; peers?: unknown; vpsAlias?: unknown };
  const peers = Array.isArray(rest.peers) ? (rest.peers as unknown[]).filter((id): id is string => typeof id === "string" && visible.bot(id)) : undefined;
  return { ...rest, ...(peers ? { peers } : {}) } as T;
}

/** What only the bot's selected conversation carries, dropped when that conversation is someone else's. */
const SELECTED_THREAD_FIELDS = ["messages", "hasMore", "activeLeafId", "pinnedMessageId", "rewound", "waitingForTeammates"] as const;

/** On a Team Cloud a person is sent only their own conversations with a bot and the team's (an admin too). The bot's
 * selected conversation is the server's one choice for everyone; when it is someone else's private chat they get the
 * main chat named instead, without that conversation's messages, and its unread mark counts only what they see. */
function shownConversations<T extends object>(bot: T, visible: VisibleSet): T {
  const record = bot as T & Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const tasks = record.tasks;
  if (Array.isArray(tasks)) {
    const kept = tasks.filter((task) => !task || typeof task !== "object" || typeof (task as { threadId?: unknown }).threadId !== "string" || visible.thread((task as { threadId: string }).threadId));
    if (kept.length !== tasks.length) {
      out = { ...record, tasks: kept };
      if (typeof record.unread === "boolean") out.unread = kept.some((task) => (task as { unread?: unknown } | null)?.unread === true);
    }
  }
  if (typeof record.threadId === "string" && !visible.thread(record.threadId)) {
    const next: Record<string, unknown> = { ...(out ?? record) };
    for (const field of SELECTED_THREAD_FIELDS) delete next[field];
    if (typeof record.mainThreadId === "string" && visible.thread(record.mainThreadId)) next.threadId = record.mainThreadId;
    else delete next.threadId;
    out = next;
  }
  return (out ?? record) as T;
}

/** The SSH alias of the server a bot's VPS computer lives on: an admin's, like the default alias in config. */
export function withoutServerAlias<T extends object>(bot: T): T {
  if (!("vpsAlias" in bot)) return bot;
  const { vpsAlias: _vpsAlias, ...rest } = bot as T & { vpsAlias?: unknown };
  return rest as T;
}

/** A broadcast as every member receives it before any audience narrowing; the same object when nothing changes. */
export function memberFramePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bot = payload.kind === "bot" ? payload.bot : undefined;
  return bot && typeof bot === "object" && "vpsAlias" in bot ? { ...payload, bot: withoutServerAlias(bot) } : payload;
}

/** A room as a member receives it: without its audience floor. */
export function memberGroup<T extends object>(group: T): T {
  if (!("audienceFloor" in group)) return group;
  const { audienceFloor: _floor, ...rest } = group as T & { audienceFloor?: unknown };
  return rest as T;
}

export function memberBody(body: unknown, visible: VisibleSet): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const narrow = (value: unknown, depth: number): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [key, child] of Object.entries(record)) {
      // A member who can see every bot and room, and an admin, are sent the rooms as they are; bots still narrow.
      if ((visible.everything || !visible.member) && (key === "group" || key === "groups")) continue;
      let next = child;
      if (key === "bot" && child && typeof child === "object" && !Array.isArray(child)) next = memberBot(child, visible);
      else if (key === "bots" && Array.isArray(child)) {
        const shown = child.map((bot) => (bot && typeof bot === "object" ? memberBot(bot as object, visible) : bot));
        if (shown.some((bot, index) => bot !== child[index])) next = shown;
      } else if (key === "group" && child && typeof child === "object" && !Array.isArray(child)) next = memberGroup(child);
      else if (key === "groups" && Array.isArray(child)) {
        next = child.map((group) => (group && typeof group === "object" ? memberGroup(group as object) : group));
      } else if (depth > 0 && key !== "messages" && child && typeof child === "object" && !Array.isArray(child)) next = narrow(child, depth - 1);
      if (next !== child) (out ??= { ...record })[key] = next;
    }
    return out ?? record;
  };
  return narrow(body, 1);
}

/** undefined: send nothing; the original object when unchanged, so the caller reuses the shared frame. */
export function frameForMember(payload: Record<string, unknown>, ctx: FrameContext, seen: StreamSeen): Record<string, unknown> | undefined {
  const { visible } = ctx;
  const kind = String(payload.kind ?? "");
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const field = (key: string) => (payload[key] && typeof payload[key] === "object" ? payload[key] as Record<string, unknown> : {});
  switch (kind) {
    case "sections": {
      const sections = Array.isArray(payload.sections) ? payload.sections.filter((s): s is string => typeof s === "string") : [];
      return { ...payload, sections: visible.sections(sections) };
    }
    case "bot.queued": {
      const queues = field("queues");
      return { ...payload, queues: Object.fromEntries(Object.entries(queues).filter(([threadId]) => visible.thread(threadId))) };
    }
    case "bots.order": {
      const botIds = Array.isArray(payload.botIds) ? payload.botIds.filter((id): id is string => typeof id === "string") : [];
      return { ...payload, botIds: botIds.filter((id) => visible.bot(id)) };
    }
    case "message":
    case "message.patch":
    case "thread":
      return visible.thread(str(payload.threadId)) ? payload : undefined;
    case "bot": {
      const bot = field("bot");
      const id = str(bot.id);
      if (!visible.bot(id)) {
        if (!seen.bots.delete(id)) return undefined;
        return { kind: "bot.deleted", botId: id };
      }
      if (!seen.bots.has(id)) {
        seen.bots.add(id);
        const fresh = ctx.freshBot(id);
        if (fresh) return { ...payload, bot: memberBot({ ...fresh, ...bot }, visible) };
      }
      return { ...payload, bot: memberBot(bot, visible) };
    }
    case "bot.deleted":
      return seen.bots.delete(str(payload.botId)) ? payload : undefined;
    case "group": {
      const group = field("group");
      const id = str(group.id);
      if (!visible.group(id)) {
        if (!seen.groups.delete(id)) return undefined;
        return { kind: "group.deleted", groupId: id };
      }
      // An admin's copy of a room keeps its audience floor.
      const asSent = (record: Record<string, unknown>) => (visible.member ? memberGroup(record) : record);
      if (!seen.groups.has(id)) {
        seen.groups.add(id);
        const fresh = ctx.freshGroup(id);
        if (fresh) return { ...payload, group: asSent({ ...fresh, ...group }) };
      }
      return visible.member && "audienceFloor" in group ? { ...payload, group: memberGroup(group) } : payload;
    }
    case "group.deleted":
      return seen.groups.delete(str(payload.groupId)) ? payload : undefined;
    case "notify": {
      const notification = field("notification");
      return visible.thread(str(notification.threadId)) && (!notification.botId || visible.bot(str(notification.botId))) ? payload : undefined;
    }
    case "routine": {
      const routine = field("routine");
      return routineVisible(routine, visible) ? payload : undefined;
    }
    case "routine.run": {
      const run = field("run");
      return routineRunVisible(run, visible) ? payload : undefined;
    }
    case "webhook":
      return webhookVisible(field("webhook"), visible) ? payload : undefined;
    case "webhook.attempt": {
      const webhook = ctx.webhook(str(field("attempt").webhookId));
      return webhook && webhookVisible(webhook, visible) ? payload : undefined;
    }
    case "runtime":
      return visible.thread(str(field("event").threadId)) ? payload : undefined;
    case "screen":
      return visible.bot(str(payload.botId)) && visible.thread(str(payload.threadId)) ? payload : undefined;
    case "computer":
      return visible.bot(str(payload.botId)) ? payload : undefined;
    case "computer-control": {
      if (!visible.bot(str(payload.botId))) return undefined;
      // A plea for a hand from someone else's private chat names its site and reason: held is all that is shared.
      const help = field("help");
      if (typeof help.threadId !== "string" || !visible.hides(help.threadId)) return payload;
      const { help: _help, ...rest } = payload;
      return { ...rest, helpReason: null };
    }
    case "config":
    case "routine.deleted":
    case "webhook.deleted":
      return payload;
    default:
      // A frame kind added later is sent only when it names nothing hidden.
      if (typeof payload.threadId === "string" && !visible.thread(payload.threadId)) return undefined;
      if (typeof payload.botId === "string" && !visible.bot(payload.botId)) return undefined;
      if (typeof payload.groupId === "string" && !visible.group(payload.groupId)) return undefined;
      return payload;
  }
}

/** Kept current while nothing is restricted, so restricting a bot later withdraws it from this stream. */
export function noteSeen(payload: Record<string, unknown>, seen: StreamSeen): void {
  const id = (value: unknown) => (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : "");
  switch (payload.kind) {
    case "bot": if (id(payload.bot)) seen.bots.add(id(payload.bot)); break;
    case "bot.deleted": if (typeof payload.botId === "string") seen.bots.delete(payload.botId); break;
    case "group": if (id(payload.group)) seen.groups.add(id(payload.group)); break;
    case "group.deleted": if (typeof payload.groupId === "string") seen.groups.delete(payload.groupId); break;
  }
}

/** A room webhook's attempts preview what it posted there, so it is shown only to someone who sees the room as well as the bot. */
export function webhookVisible(value: { botId?: unknown; groupId?: unknown }, visible: Pick<VisibleSet, "everything" | "bot" | "group">): boolean {
  if (visible.everything) return true;
  if (typeof value.botId !== "string" || !visible.bot(value.botId)) return false;
  return typeof value.groupId !== "string" || !value.groupId || visible.group(value.groupId);
}

export function routineVisible(value: { botId?: unknown; groupId?: unknown }, visible: VisibleSet): boolean {
  if (visible.everything) return true;
  if (typeof value.groupId === "string" && value.groupId) return visible.group(value.groupId);
  return typeof value.botId === "string" && visible.bot(value.botId);
}

/** A run's prompt and output are its conversation's words: on a Team Cloud a run that went into someone's private chat
 * is theirs alone. */
export function routineRunVisible(run: { botId?: unknown; groupId?: unknown; threadId?: unknown; resultsThreadId?: unknown; sourceThreadId?: unknown }, visible: VisibleSet): boolean {
  if (!routineVisible(run, visible)) return false;
  return [run.threadId, run.resultsThreadId, run.sourceThreadId].every((id) => typeof id !== "string" || !id || !visible.hides(id));
}

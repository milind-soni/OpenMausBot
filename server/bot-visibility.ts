// Who may see a bot on a workspace several people share.
//
// A bot's optional `visibility` is set by an admin:
//   - absent or "everyone": every signed-in person, today's behaviour;
//   - "admins": admin sessions only;
//   - { people: [...] }: the listed addresses (or @domain entries) plus admins.
//
// This is access control, not an approval gate. It decides what a member's
// session is shown and may touch — the bot, its threads, their messages,
// attachments, exports, search hits, routines, webhooks and live frames —
// and nothing else. The owner on this machine, a session-less local service
// (the Slack worker), and admin sessions see everything. A desktop has no
// member sessions, so nothing there changes.
//
// Rooms follow their bots: a member sees a room only when the room has at
// least one bot and they can see every bot in it. A room is one shared
// transcript, so a restricted bot's words there would otherwise reach people
// who cannot see the bot. Teams (sidebar sections) are listed to a member
// only when they hold a bot or room that member can see.
//
// Bots reach each other only when the same people can see both (see
// sameAudience): an ask or a delegation carries one bot's words into the
// other's thread, so a teammate with a different audience could surface a
// restricted bot's answers to people who cannot see it.
//
// Pure: no store, no server. server/index.ts supplies the records.
import { z } from "zod";

import type { BotVisibility } from "../shared/wire.ts";

export type { BotVisibility };

/** The person looking, reduced to what visibility needs. `all` is the owner,
 * a local service or an admin session; `member` is any other session, with
 * the email it signed in with when it has one. */
export type Viewer = { kind: "all" } | { kind: "member"; email?: string };

export const SEES_EVERYTHING: Viewer = { kind: "all" };

export const MAX_VISIBILITY_PEOPLE = 500;
const ENTRY = /^(?:[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+|@[^\s@,;<>"]+\.[^\s@,;<>"]+)$/;

const peopleSchema = z.object({ people: z.array(z.string().max(320)).max(MAX_VISIBILITY_PEOPLE) }).strict();

/** Read an admin's input. null and "everyone" both mean the default, kept as
 * "everyone" so every client's copy of the bot changes too (an absent field
 * would leave a client's old value in place). An empty people list means
 * admins only: a list that names nobody must not quietly mean everyone. */
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

/** A value read back from bots.json. Anything unrecognised fails closed to
 * admins only: a hand-edited or damaged field must never widen access. */
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

/** True when exactly the same people can see both bots. */
export function sameAudience(a: unknown, b: unknown): boolean {
  const left = storedVisibility(a);
  const right = storedVisibility(b);
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.people.length !== right.people.length) return false;
  const set = new Set(left.people);
  return right.people.every((entry) => set.has(entry));
}

/** True when everyone who can see `inner` can also see `outer`. Admins see
 * every bot, so an admins-only audience is inside any other. */
export function audienceWithin(inner: unknown, outer: unknown): boolean {
  const small = storedVisibility(inner);
  const large = storedVisibility(outer);
  if (large === "everyone" || small === "admins") return true;
  if (small === "everyone" || large === "admins") return false;
  return small.people.every((entry) =>
    large.people.includes(entry) || (!entry.startsWith("@") && large.people.some((other) => other.startsWith("@") && entryMatches(other, entry))));
}

/** The people who can see both: everyone ∩ X is X, admins ∩ X is admins,
 * and two lists keep each entry the other also admits. An intersection that
 * names nobody is admins only. */
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

/** The narrowest of several audiences (a room's bots, and its floor). */
export function narrowestAudience(values: readonly unknown[]): BotVisibility {
  return values.reduce<BotVisibility>((floor, value) => intersectAudience(floor, value), "everyone");
}

/** Whether two readings name the same audience. */
export function audienceEquals(a: unknown, b: unknown): boolean {
  return sameAudience(a, b);
}

/** Whether a room's conversation may feed a bot's recall and its brief of
 * recent work: only when everyone who can see the bot can see every bot in
 * the room. Otherwise a member chatting with a bot everyone sees would get
 * back what a restricted bot said in a room they cannot open. */
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
  /** The narrowest audience the room has ever had. A bot leaving never
   * widens it; only an admin's explicit reset does (server/index.ts). */
  audienceFloor?: unknown;
}

export type ThreadOwner = { bot: string; group?: undefined } | { group: string; bot?: undefined };

/** What one viewer may see of the current fleet, built from the store's
 * records. When no bot is restricted, or the viewer sees everything, every
 * check is `true` and nothing is filtered — the records are not even read.
 * `ownerOf` resolves a thread to the bot or room that owns it; without one
 * the set indexes the records itself. */
export class VisibleSet {
  /** The viewer sees everything: nothing to filter. */
  readonly everything: boolean;
  private readonly bots = new Map<string, VisibilityBot>();
  private readonly groups = new Map<string, VisibilityGroup>();
  private readonly viewer: Viewer;
  private readonly ownerOf: (threadId: string) => ThreadOwner | undefined;
  private threads: Map<string, ThreadOwner> | null = null;
  private readonly botMemo = new Map<string, boolean>();

  constructor(
    bots: readonly VisibilityBot[],
    groups: readonly VisibilityGroup[],
    viewer: Viewer,
    ownerOf?: (threadId: string) => ThreadOwner | undefined,
  ) {
    this.viewer = viewer;
    this.everything = viewer.kind === "all" ||
      (!bots.some((bot) => isRestricted(bot.visibility)) && !groups.some((group) => isRestricted(group.audienceFloor)));
    this.ownerOf = ownerOf ?? ((threadId) => this.indexedOwner(threadId));
    if (this.everything) return;
    for (const bot of bots) this.bots.set(bot.id, bot);
    for (const group of groups) this.groups.set(group.id, group);
  }

  bot(id: string): boolean {
    if (this.everything) return true;
    let seen = this.botMemo.get(id);
    if (seen === undefined) {
      const bot = this.bots.get(id);
      seen = Boolean(bot && viewerSees(this.viewer, bot.visibility));
      this.botMemo.set(id, seen);
    }
    return seen;
  }

  /** At least one bot, every bot in it visible, and the room's floor — the
   * narrowest audience it has had — admits the viewer. */
  group(id: string): boolean {
    if (this.everything) return true;
    const group = this.groups.get(id);
    if (!group) return false;
    const members = group.memberIds.filter((member) => this.bots.has(member));
    return members.length > 0 && members.every((member) => this.bot(member)) && viewerSees(this.viewer, group.audienceFloor);
  }

  /** The bot or room that owns the thread is visible. An unknown thread is not. */
  thread(threadId: string): boolean {
    if (this.everything) return true;
    const owner = this.ownerOf(threadId);
    if (!owner) return false;
    return owner.bot !== undefined ? this.bot(owner.bot) : this.group(owner.group);
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

  /** Sections holding at least one visible bot or room. */
  sections(all: readonly string[]): string[] {
    if (this.everything) return [...all];
    const key = (value?: string) => value?.trim() || "";
    const shown = new Set<string>();
    for (const bot of this.bots.values()) if (this.bot(bot.id)) shown.add(key(bot.section));
    for (const group of this.groups.values()) if (this.group(group.id)) shown.add(key(group.section));
    return all.filter((section) => shown.has(key(section)));
  }

  /** An attachment is refused only when everything that references it is
   * hidden: an image in a restricted bot's thread, or its avatar. One that
   * nothing references yet (a member's own upload before sending) is served;
   * its name is random. `threadsReferencing` is only called when needed. */
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

/** The entity a path names, for the one visibility check every client route
 * passes through (server/index.ts). Fixed sub-paths that name no entity
 * (`/api/routines/wake`, `/api/routine-runs/seen-all`) are not subjects. */
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

/** The refusal a hidden subject gets: the same "not found" an unknown id
 * gets, so a member cannot tell a restricted bot from a missing one. */
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

// ── live frames ─────────────────────────────────────────────────────────
// One SSE broadcast goes to every client. For a member on a workspace with a
// restricted bot, each frame is checked against what that member may see,
// and the few frames that list several things are narrowed. `seen` tracks
// which bots and rooms this stream has been shown, so a bot that becomes
// hidden is withdrawn once (as `bot.deleted`), a newly visible one arrives
// whole, and nothing about a bot the member never saw is ever sent.

export interface StreamSeen {
  bots: Set<string>;
  groups: Set<string>;
}

export interface FrameContext {
  visible: VisibleSet;
  /** A webhook's bot, for its delivery attempts. */
  webhookBot: (webhookId: string) => string | undefined;
  /** The whole record of a bot this stream was not showing yet. */
  freshBot: (botId: string) => Record<string, unknown> | undefined;
  freshGroup: (groupId: string) => Record<string, unknown> | undefined;
}

/** The bot as a member receives it: no audience list (who else may see a bot
 * is an admin's business), and no teammate ids the member cannot see. */
export function memberBot<T extends object>(bot: T, visible: VisibleSet): T {
  if (visible.everything) return bot;
  const { visibility: _visibility, ...rest } = bot as T & { visibility?: unknown; peers?: unknown };
  const peers = Array.isArray(rest.peers) ? (rest.peers as unknown[]).filter((id): id is string => typeof id === "string" && visible.bot(id)) : undefined;
  return { ...rest, ...(peers ? { peers } : {}) } as T;
}

/** A room as a member receives it: without its audience floor. */
export function memberGroup<T extends object>(group: T): T {
  if (!("audienceFloor" in group)) return group;
  const { audienceFloor: _floor, ...rest } = group as T & { audienceFloor?: unknown };
  return rest as T;
}

/** A JSON response as a member receives it: every bot it carries (under
 * `bot`, or in `bots`, at the top or one level down) through memberBot. */
export function memberBody(body: unknown, visible: VisibleSet): unknown {
  if (visible.everything || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const narrow = (value: unknown, depth: number): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [key, child] of Object.entries(record)) {
      let next = child;
      if (key === "bot" && child && typeof child === "object" && !Array.isArray(child)) next = memberBot(child, visible);
      else if (key === "bots" && Array.isArray(child)) {
        next = child.map((bot) => (bot && typeof bot === "object" ? memberBot(bot as object, visible) : bot));
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

/** `undefined`: send nothing. Otherwise the payload to send, which is the
 * original object when nothing needed changing (the caller then reuses the
 * shared serialized frame). */
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
      if (!seen.groups.has(id)) {
        seen.groups.add(id);
        const fresh = ctx.freshGroup(id);
        if (fresh) return { ...payload, group: memberGroup({ ...fresh, ...group }) };
      }
      return "audienceFloor" in group ? { ...payload, group: memberGroup(group) } : payload;
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
      return routineVisible(run, visible) ? payload : undefined;
    }
    case "webhook":
      return visible.bot(str(field("webhook").botId)) ? payload : undefined;
    case "webhook.attempt": {
      const botId = ctx.webhookBot(str(field("attempt").webhookId));
      return botId && visible.bot(botId) ? payload : undefined;
    }
    case "runtime":
      return visible.thread(str(field("event").threadId)) ? payload : undefined;
    case "screen":
      return visible.bot(str(payload.botId)) && visible.thread(str(payload.threadId)) ? payload : undefined;
    case "computer":
    case "computer-control":
      return visible.bot(str(payload.botId)) ? payload : undefined;
    case "config":
    case "routine.deleted":
    case "webhook.deleted":
      return payload;
    default:
      // A frame kind added later: judge it by the ids it carries, and send it
      // only when it names nothing hidden.
      if (typeof payload.threadId === "string" && !visible.thread(payload.threadId)) return undefined;
      if (typeof payload.botId === "string" && !visible.bot(payload.botId)) return undefined;
      if (typeof payload.groupId === "string" && !visible.group(payload.groupId)) return undefined;
      return payload;
  }
}

/** Keep a member stream's record of what it was shown current while nothing
 * is restricted, so restricting a bot later withdraws it from that stream. */
export function noteSeen(payload: Record<string, unknown>, seen: StreamSeen): void {
  const id = (value: unknown) => (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : "");
  switch (payload.kind) {
    case "bot": if (id(payload.bot)) seen.bots.add(id(payload.bot)); break;
    case "bot.deleted": if (typeof payload.botId === "string") seen.bots.delete(payload.botId); break;
    case "group": if (id(payload.group)) seen.groups.add(id(payload.group)); break;
    case "group.deleted": if (typeof payload.groupId === "string") seen.groups.delete(payload.groupId); break;
  }
}

/** A routine or run targets a bot, and may run in a room. */
export function routineVisible(value: { botId?: unknown; groupId?: unknown }, visible: VisibleSet): boolean {
  if (visible.everything) return true;
  if (typeof value.groupId === "string" && value.groupId) return visible.group(value.groupId);
  return typeof value.botId === "string" && visible.bot(value.botId);
}

// Record shapes and pure helpers shared by the store facade
// (server/store.ts), its slice modules (server/store/*.ts) and the startup
// migration pipeline. This module must stay dependency-free beyond the
// shared wire types so every slice can import it without cycles.
import type {
  BotActivity, GroupDefaultResponder, WireBot, WireGroup,
  WireMessage, WireTask,
} from "../../shared/wire.ts";
import type { TeamSetupResult } from "../../shared/team-setup.ts";
import type { HandedState } from "../delta-context.ts";

/** One transcript line, serialized as stored — the shared wire shape. */
export type Message = WireMessage;

/** A room record: the shared wire shape minus the computed working flag,
 * which publicGroupState adds at projection time. */
export type GroupRecord = Omit<WireGroup, "working">;
/** Groups keep no private fields; the only projection work is the
 * transient `working` flag publicGroupState computes at broadcast time. */
export type GroupWireProjection = GroupRecord & { working: boolean };
export type GroupWireProjectionIsExact = AssertExact<WireGroup, GroupWireProjection> & AssertSameKeys<WireGroup, GroupWireProjection>;
export const groupWireProjectionIsExact: GroupWireProjectionIsExact = true;

// Unicode's complete emoji sequences include flags, skin tones and ZWJ
// combinations. Also allow unqualified single symbols (e.g. ♥), but not
// standalone components such as a digit, skin tone or regional indicator.
const projectEmojiPattern = new RegExp("^(?!\\p{Emoji_Component}$)(?:\\p{RGI_Emoji}|[\\p{Emoji}--\\p{Emoji_Component}])$", "v");
export function isProjectEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && projectEmojiPattern.exec(value)?.[0] === value;
}

/** One task = one conversation with its own context. Extends the shared
 * wire shape; the extras below are server-private bookkeeping the wire
 * projection (toWireTask) strips. */
export interface TaskRecord extends WireTask {
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current, so this is what decides an
   * inline replay. Absent on tasks from before the field existed. */
  lastInstanceId?: string;
  /** per instance: the stored messages that instance's current native
   * session has been handed on this task (server/delta-context.ts) */
  handedMessages?: Record<string, HandedState>;
}

/** TaskRecord fields no client may see. Everything else must be on WireTask:
 * the exactness assertion below fails to compile when either side drifts,
 * so a new server field forces a decision — wire-visible or private here. */
export type TaskWirePrivateKeys = "resumeCursors" | "lastInstanceId" | "handedMessages";
export type TaskWireProjection = Pick<TaskRecord, Exclude<keyof TaskRecord, TaskWirePrivateKeys>>;
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertSameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
/** Structural exactness alone lets an optional extra field through (a type
 * without the field still extends {field?: T}), so keys are checked too. */
export type TaskWireProjectionIsExact = AssertExact<WireTask, TaskWireProjection> & AssertSameKeys<WireTask, TaskWireProjection>;
export const taskWireProjectionIsExact: TaskWireProjectionIsExact = true;

/** The typed wire projection for one task. Pairs with the assertion above:
 * returning WireTask means an undeclared server field cannot ride silently. */
export function toWireTask(task: TaskRecord): WireTask {
  const { resumeCursors: _resumeCursors, lastInstanceId: _lastInstanceId, handedMessages: _handedMessages, ...wire } = task;
  return wire;
}

export const TASK_PATCH_FIELDS = [
  "title", "projectId", "modelSelection", "approvalMode", "autoApprove", "alwaysAllow",
  "unread", "rewound", "archivedAt", "pinnedMessageId", "resumeCursors", "lastInstanceId", "cwd",
  "routineRunId", "surface",
] as const satisfies readonly (keyof TaskRecord)[];
export type TaskPatch = Partial<Pick<TaskRecord, typeof TASK_PATCH_FIELDS[number]>>;

/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

/** What changed, emitted by the store itself right after each write. The
 * server maps these onto its SSE frames in ONE place, so no mutation path
 * can persist without the app hearing about it — the two-write-paths bug
 * (persist without emit → UI drifts; emit without persist → a restart
 * loses what the user just watched) is closed by construction. Bot and
 * group changes carry only the id: the wire shape (cursor stripping) is
 * the caller's business. */
export type StoreChange =
  | { type: "sections" }
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };

/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";
export const UNTITLED_THREAD = "New thread";

/** How a thread title is stored: one trim, one cut. Every title arrives
 * through this — the name a bot passes to createTask and the name a person
 * types in the sidebar alike — which is what makes "is this title still
 * the one the machine made?" a question you can answer by comparing. */
const TASK_TITLE_MAX = 80;
export function threadTitleFrom(title?: string): string {
  return title?.trim().slice(0, TASK_TITLE_MAX) || UNTITLED_THREAD;
}

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

/** One usable line out of a model's title reply: the first line, no
 * surrounding quotes, code fences, or markdown decoration, no trailing
 * period, single spaces — or null when what came back is empty, too long
 * to be a title, or otherwise not a plain name. The caller keeps its
 * fallback then. */
export function titleFromLlm(raw: string): string | null {
  const line = raw
    .trim()
    .split("\n")[0]!
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/^["'\u201C\u201D\u2018\u2019\u0060]+/, "")
    .replace(/["'\u201C\u201D\u2018\u2019\u0060]+$/, "")
    // decoration the quotes were hiding: "## Deploy app" keeps its
    // markers through the strips above, which never reach past a quote
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/[#*]+$/, "")
    .replace(/[.\u3002]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length >= 1 && line.length <= 48 ? line : null;
}

/** A bot record. Extends the shared wire shape; the extras below are
 * server-private (stripped by wireBot). avatarUrl is optional in the record
 * but always present (string | null) on the wire, so the record widens it. */
export interface BotRecord extends Omit<WireBot, "avatarUrl" | "tasks"> {
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** Server-private elevation journal. Full/Custom executes as Ask until
   * Electron confirms the exact prepared reply and then activates it over
   * the utility-process channel. Any marker surviving a restart is revoked
   * during Store load. */
  approvalGrant?: {
    requestId: string;
    mode: "full" | "custom";
    phase: "prepared" | "confirmed" | "activated" | "committed";
    /** Optional existing thread receiving this already-approved bot default. */
    threadId?: string;
    /** Composer grant: leave the bot default and other threads unchanged. */
    threadOnly?: true;
  };
  /** Receipt committed with a confirmed profile, for retrying card settlement. */
  lastProfileRequestId?: string;
  /** Receipt committed with a reviewed team batch; prevents replay after a lost response. */
  lastTeamSetupReceipt?: { requestId: string; result: TeamSetupResult };
}

/** BotRecord fields no client may see, plus the two the projection
 * re-derives rather than passes through (tasks are re-projected as
 * WireTask[], avatarUrl is coerced to always-present). The exactness
 * assertion fails to compile when either side drifts, so a new server
 * field forces a decision — wire-visible or private here. */
export type BotWirePrivateKeys = "resumeCursors" | "tasks" | "avatarUrl" | "approvalGrant" | "lastProfileRequestId" | "lastTeamSetupReceipt";
export type BotWireProjection = Pick<BotRecord, Exclude<keyof BotRecord, BotWirePrivateKeys>>;
export type BotWireProjectionIsExact = AssertExact<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection> & AssertSameKeys<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection>;
export const botWireProjectionIsExact: BotWireProjectionIsExact = true;

/** Sections are persisted as display labels, so exact trimmed labels are
 * their identity. Missing/blank means the unsectioned (General) team. */
export const sectionKey = (section?: string | null): string => section?.trim() || "";

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, the name must end on a word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length]; // must not run into a longer word
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Normalize persisted or API-provided routing. Old rooms did not have this
 * field; giving them their first member as lead fixes the old silent-send
 * behavior without making every prompt fan out to every model. */
export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
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

/** Resolve the bots invoked by a human room message. Explicit targets win;
 * otherwise the room policy chooses one member, everyone, or nobody. */
export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
): T[] {
  const available = members.filter((member) => !member.hidden);
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  return [];
}

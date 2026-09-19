// The calendar-rooms cluster -- the room-handoff tick timer, the approval
// bus with its stale-card sweep, the calendar-call room provisioning and
// delivery, the room-setup-pending predicate, reply-target resolution, the
// last-human-message scan, and the room-post eligibility gate -- extracted
// verbatim from index.ts. index.ts calls createCalendarRooms at the
// region's original site (the "config hot-reload" banner) so the handoff
// interval still starts at the same point in module evaluation order.
// roomSetupPending, resolveReplyTarget and deliverCalendarCall are consumed
// by factories wired earlier in index.ts (group state and the routine
// lifecycle), so those call sites pass wrapper thunks over the names
// returned here; calendarCalls is an index.ts let bound by the routine
// lifecycle and crosses through an accessor.
import { dismissStalePeerCards, type ApprovalBus } from "./peer-approval.ts";
import { canAccessTeam } from "./peer-roster.ts";
import { escapeAttribute } from "../shared/attachments.ts";
import { store } from "./runtime.ts";
import type { CalendarCall, CalendarCallManager } from "./calendar-calls.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import type { RoomHandoffs } from "./room-handoffs.ts";
import type { createBotViews } from "./bot-views.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";
import type { createGroupTurn } from "./group-turn.ts";

/** Everything the calendar-rooms cluster reads from its host. The helpers
 * arrive by value from factories wired above the region's site; calendarCalls
 * is an index.ts let reassigned by the routine lifecycle, so it crosses
 * through an accessor. */
export interface CalendarRoomsDeps {
  helpers: {
    roomHandoffs: RoomHandoffs;
    broadcast: ReturnType<typeof createEventsPipeline>["broadcast"];
    notify: ReturnType<typeof createEventsPipeline>["notify"];
    fullAccessForSource: ReturnType<typeof createBotViews>["fullAccessForSource"];
    startGroupTurn: ReturnType<typeof createGroupTurn>["startGroupTurn"];
  };
  lateBound: {
    calendarCalls(): CalendarCallManager | null;
  };
}

export function createCalendarRooms(deps: CalendarRoomsDeps) {
  const { roomHandoffs, broadcast, notify, fullAccessForSource, startGroupTurn } = deps.helpers;
  const calendarCalls = deps.lateBound.calendarCalls;

// ── config hot-reload ─────────────────────────────────────────────────
const roomHandoffTimer = setInterval(() => {
  try { roomHandoffs.tick(); } catch (error) { console.error("room handoffs:", error); }
}, 250);
roomHandoffTimer.unref();
/** Long enough for a real update, short enough that a room stays readable. */
const ROOM_POST_MAX_CHARS = 4_000;

// approval bus: peer-approval.ts only needs to push cards and broadcast
// them — its pending map lives in the module so the two respond endpoints
// can call resolvePeerComms without holding a reference back to here.
const approvalBus: ApprovalBus = { store, broadcast, notify, autoApply: fullAccessForSource };

// Approvals live only in memory, so any peer card still open on disk is one
// whose resolver died with the previous process. Left alone it can never be
// answered, and the composer stays disabled behind it — settle them at boot.
{
  const stale = dismissStalePeerCards(approvalBus);
  if (stale) console.log(`peer approvals: dismissed ${stale} card(s) left by a previous run`);
}

function sameCalendarRoster(group: GroupRecord, botIds: readonly string[]): boolean {
  if (group.dm || group.memberIds.length !== botIds.length) return false;
  const wanted = new Set(botIds);
  return group.memberIds.every((id) => wanted.has(id));
}

function ensureCalendarCallRoom(call: CalendarCall): GroupRecord {
  const linked = call.roomId ? store.group(call.roomId) : undefined;
  let group = linked && sameCalendarRoster(linked, call.botIds) && !roomSetupPending(linked)
    ? linked
    : undefined;
  group ??= store.createGroup(call.name, call.botIds, false, undefined, {
    bulletin: "",
    defaultResponder: { kind: "everyone" },
    completed: true,
  });
  if (call.roomId !== group.id) calendarCalls()!.linkRoom(call.id, group.id);
  return group;
}

function deliverCalendarCall(call: CalendarCall, scheduledFor: number): void {
  // A one-bot calendar entry remains a reminder that opens that bot's chat.
  // Multi-bot entries are rooms and begin with the shared event prompt.
  if (call.botIds.length < 2) return;
  const group = ensureCalendarCallRoom(call);
  const text = [
    `@everyone ${call.description.trim() || call.name}`,
    ...call.attachments.map((attachment) =>
      `<${attachment.kind === "image" ? "attached-image" : "attached-file"} path="${escapeAttribute(attachment.path)}" name="${escapeAttribute(attachment.name)}" />`
    ),
  ].join("\n\n");
  const sendId = `calendar_${call.id}_${scheduledFor}`;
  const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
  const messages = [...threadIds].flatMap((threadId) => store.messagesFor(threadId));
  if (messages.some((message) => message.sendId === sendId)) return;
  startGroupTurn(group.id, text, undefined, sendId);
}

function roomSetupPending(group: GroupRecord): boolean {
  const hasMarker =
    Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
  return (
    !group.dm &&
    hasMarker &&
    group.setupCompletedAt == null &&
    group.setupSkippedAt == null &&
    store.messagesFor(group.threadId).length === 0
  );
}

function resolveReplyTarget(threadId: string, value: unknown): Message | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw Object.assign(new Error("replyToId must be a message id"), { status: 400 });
  const target = store.messagesFor(threadId).find((message) => message.id === value);
  if (!target || target.kind !== "text" || !target.text?.trim()) {
    throw Object.assign(new Error("the message being replied to is no longer available"), { status: 404 });
  }
  return target;
}

/** When a person last wrote into the room's current conversation, if one
 * ever has. The posting budget's ceiling counts only the bot posts nobody
 * has answered since, so this is read fresh on every attempt rather than
 * remembered — the room's transcript is already the record of who spoke
 * last, and a second copy of it could only ever disagree.
 *
 * Only a person puts a user-role message in a room: the composer, or a
 * calendar call they scheduled. No bot tool has that ingress — post_to_room
 * appends role "bot", which is the rule this whole surface turns on. The
 * one door a bot's shell could reach on a headless server, the HTTP API
 * with no session behind it, stamps what it lets in (Message.via), and a
 * line so stamped does not count here — so a bot cannot re-arm the ceiling
 * it just spent. */
function lastHumanRoomMessageAt(group: GroupRecord): number | undefined {
  const messages = store.messagesFor(group.threadId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && message.kind === "text" && !message.via) return message.at;
  }
  return undefined;
}

/** Whether `bot` may write into `group` from outside a turn there, and the
 * exact refusal when it may not.
 *
 * Room membership is the one place the app's section boundary does not
 * reach: list_bots, ask_bot, delegate_bot and create_bot are all scoped to
 * the sender's section, but a person is free to put bots from two sections
 * in one room. A tool that pushed text into such a room would therefore be
 * the first way one section speaks to another with nobody in the loop, so
 * this refuses it outright rather than trying to judge when that is
 * harmless. The cost is real — a genuinely cross-section room cannot be
 * posted into from outside — and it is the cheaper mistake: the person can
 * still relay, and the boundary keeps meaning exactly one thing.
 *
 * Membership is read from the record here and never from a tool argument;
 * the argument only names which room to look up. */
function roomPostEligibility(
  bot: BotRecord,
  group: GroupRecord,
): { ok: true } | { ok: false; status: number; error: string } {
  if (group.dm) {
    return {
      ok: false,
      status: 400,
      error: "that is a one-to-one bot channel, not a room — use ask_bot or delegate_bot to reach a single bot",
    };
  }
  if (!group.memberIds.includes(bot.id)) {
    return { ok: false, status: 403, error: "you are not a member of that room" };
  }
  const outsider = group.memberIds
    .map((id) => store.bot(id))
    .find((member) => member && !canAccessTeam(bot, member.section));
  if (outsider) {
    return {
      ok: false,
      status: 403,
      error: `that room includes @${outsider.name}, who is outside your section — tell the user what you wanted to post there instead`,
    };
  }
  // A room whose setup the person has not finished has never been opened
  // for business, and its first message decides whether setup still counts
  // as pending. A bot must not be the one to settle that.
  if (roomSetupPending(group)) {
    return { ok: false, status: 409, error: "that room is still being set up — it cannot receive messages yet" };
  }
  return { ok: true };
}

  return {
    ROOM_POST_MAX_CHARS, approvalBus, ensureCalendarCallRoom, deliverCalendarCall,
    roomSetupPending, resolveReplyTarget, lastHumanRoomMessageAt, roomPostEligibility,
  };
}

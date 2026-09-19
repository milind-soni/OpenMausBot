// post_to_room: one bot-authored message into a room, budgeted and
// approved. Body moved verbatim from ../internal.ts; the dispatch chain
// there owns order.
import type { ServerResponse } from "node:http";

import { requestPeerApproval } from "../../peer-approval.ts";
import { decideRoomPost, emptyRoomPostBudget, type RoomPostAttempt } from "../../room-post-budget.ts";
import type { BotRecord, GroupRecord, Message } from "../../store.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type PostToRoomCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  approvalBus: InternalRoutesOptions["approvalBus"];
  roomPostBudgets: InternalRoutesOptions["roomPostBudgets"];
  personAskAt: InternalRoutesOptions["personAskAt"];
  roomPostEligibility: InternalRoutesOptions["roomPostEligibility"];
  lastHumanRoomMessageAt: InternalRoutesOptions["lastHumanRoomMessageAt"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  peerReviewRequired: InternalRoutesOptions["peerReviewRequired"];
  isUnattended: InternalRoutesOptions["isUnattended"];
  ROOM_POST_MAX_CHARS: InternalRoutesOptions["ROOM_POST_MAX_CHARS"];
}

// post_to_room: a bot puts ONE message into a room it belongs to,
// without a turn being started for anyone. Everything about it is a
// deliberate non-event:
//
//   role "bot", never "user". A user-role append is what the composer
//   writes, and it re-enters responder selection — one tool call would
//   become a round of real turns, which is the notification storm this
//   whole surface exists to avoid.
//
//   no startGroupTurn and no queue kick. The post lands, the room is
//   marked unread, the person reads it when they look. A bot wanting a
//   reply has ask_bot and delegate_bot, both of which are accounted for.
//
//   membership from the record, never from the argument: the argument
//   only says which room to look up.
export async function postToRoom(ctx: PostToRoomCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, approvalBus, roomPostBudgets, personAskAt, roomPostEligibility, lastHumanRoomMessageAt, connectorThread,
    peerReviewRequired, isUnattended, ROOM_POST_MAX_CHARS,
    internalCapability, internalSender, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
    const body = await readInternalBody();
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    const owner = connectorThread(from.id, fromThreadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    const groupId = String(body.groupId ?? "").trim();
    const message = String(body.message ?? "").trim();
    if (!groupId || !message) {
      return json(res, 400, { error: "post_to_room needs group_id (from list_rooms) and message" });
    }
    if (message.length > ROOM_POST_MAX_CHARS) {
      return json(res, 400, {
        error: `a room post is at most ${ROOM_POST_MAX_CHARS} characters — post the short version and keep the detail in your own reply`,
      });
    }
    let room = store.group(groupId);
    if (!room) return json(res, 404, { error: "no such room — call list_rooms and copy the exact id from the result" });
    // Posting into the room you are already speaking in is not a peer
    // message, it is your own reply arriving twice — and it feeds your
    // words back into the context the same turn is answering from.
    if (room.id === owner.group?.id) {
      return json(res, 409, { error: "you are already speaking in that room — say it in your reply instead" });
    }
    const eligibility = roomPostEligibility(from, room);
    if (!eligibility.ok) return json(res, eligibility.status, { error: eligibility.error });
    // The budget is read BEFORE any approval card and CHARGED only on
    // the path that actually appends. Reading it early is what stops a
    // bot in a loop turning that loop into a queue of cards for a person
    // to work through: the refusal lands on the bot, not in the inbox.
    // Charging it early would have been a lie in the other direction —
    // a denied card, a room deleted while the card was open, or a
    // roster change that ends the post all leave the room with nothing
    // in it, and a room that took no post must not be told it did. The
    // model would then be refused its retry with "you already posted
    // that", which is the one thing worse than a refusal: a false
    // receipt for a message nobody can read.
    const askBudget = (bot: BotRecord, group: GroupRecord) => {
      const attempt: RoomPostAttempt = {
        botId: bot.id,
        botName: bot.name,
        text: message,
        now: Date.now(),
      };
      // The person attending is whoever wrote last: in the room, or —
      // when the post was asked for in the sender's own conversation —
      // there. A room-sourced post has no such person; its room is the
      // conversation, and what a person wrote in it is already counted.
      const askedAt = owner.group ? undefined : personAskAt.get(fromThreadId);
      const spokeAt = Math.max(lastHumanRoomMessageAt(group) ?? -Infinity, askedAt ?? -Infinity);
      if (Number.isFinite(spokeAt)) attempt.lastHumanAt = spokeAt;
      return decideRoomPost(roomPostBudgets.get(group.id) ?? emptyRoomPostBudget(), attempt);
    };
    // A refusal is stored, an allowance is not: the budget a refusal
    // hands back never contains the attempt — it is the pruning, plus
    // the breaker if this call is what tripped it — so keeping it costs
    // the room nothing and losing it would let a ring re-form one call
    // later.
    const preflight = askBudget(from, room);
    if (!preflight.allowed) {
      roomPostBudgets.set(room.id, preflight.budget);
      return json(res, 429, { error: preflight.message });
    }
    let poster = from;
    if (peerReviewRequired(from, fromThreadId)) {
      // Same gate ask_bot carries, aimed at the room instead of a peer:
      // a bot the user asked to be consulted about must be consulted here
      // too, or the newest way to reach other bots is the one way round it.
      const verdict = await requestPeerApproval(
        approvalBus,
        from,
        { id: room.id, name: room.name },
        message,
        "post_to_room",
        fromThreadId,
      );
      requireActiveInternalCapability();
      if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
      // The card may have been open for minutes. Re-read both records so a
      // roster change, a section move, or a deletion during that window
      // cannot be posted through on a stale decision.
      const freshFrom = store.bot(internalSender.id);
      const freshRoom = store.group(groupId);
      if (!freshFrom || !freshRoom) return json(res, 404, { error: "that bot or room no longer exists" });
      const stillEligible = roomPostEligibility(freshFrom, freshRoom);
      if (!stillEligible.ok) return json(res, stillEligible.status, { error: stillEligible.error });
      poster = freshFrom;
      room = freshRoom;
    }
    // The room's budget is charged here, against the records the append
    // below will actually use. Between the preflight and this line the
    // room may have taken another bot's post, so this decision — not the
    // preflight — is the one that can refuse.
    const decision = askBudget(poster, room);
    roomPostBudgets.set(room.id, decision.budget);
    if (!decision.allowed) return json(res, 429, { error: decision.message });
    // Unattended inheritance: the mark rides the sender, and reading it
    // here is also what keeps its window alive through a turn that only
    // posts — an aged-out mark would hand the next hop to auto-approve.
    const unattended = isUnattended(poster.id, internalCapability.threadId);
    const posted = store.appendMessage(room.threadId, {
      role: "bot",
      kind: "text",
      text: message,
      from: { botId: poster.id, name: poster.name, color: poster.color },
      peerPost: unattended ? { unattended: true } : {},
    });
    store.patchGroup(room.id, { unread: true });
    // The same visibility contract the peer tools keep: whatever a bot
    // does elsewhere shows up in the conversation it is actually in.
    // The chip is settled — the post has already landed — and carries
    // the same link a "Messaged @X" chip does, which is what makes it a
    // receipt rather than a log line: linked chips stay visible with
    // tool calls off, and open the room they name.
    const chip: Omit<Message, "id" | "at"> = {
      role: "bot",
      kind: "activity",
      tool: { name: `Posted in ${room.name}`, ok: true },
      comm: { groupId: room.id, withBotId: poster.id, withName: room.name, withColor: poster.color },
    };
    if (owner.group) chip.from = { botId: poster.id, name: poster.name, color: poster.color };
    store.appendMessage(fromThreadId, chip);
    return json(res, 201, { ok: true, messageId: posted.id, roomName: room.name });
}


// Read-only discovery: list_bots, list_threads, close_thread, list_rooms.
// Bodies moved verbatim from ../internal.ts; the dispatch chain there owns
// path matching, methods, and order.
import type { ServerResponse } from "node:http";

import { peerStatus, peerStatusWords, reachablePeers } from "../../peer-roster.ts";
import { queuedThreadPosition } from "../../steer-queue.ts";
import type { BotRecord, TaskRecord } from "../../store.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type RosterCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  roomHandoffs: InternalRoutesOptions["roomHandoffs"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  threadBusy: InternalRoutesOptions["threadBusy"];
  roomPostEligibility: InternalRoutesOptions["roomPostEligibility"];
}

export async function agentsList(ctx: RosterCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, internalSender, json,
  } = ctx;
    const sender = internalSender;
    // title/description included so the caller can judge the team (who
    // does what, who has no job description yet). Every bot reads this
    // now, not just the Chief, so it answers the same reachability
    // question the roster does — same peers, same order.
    const bots = reachablePeers(store.bots, sender)
      .map((b) => {
        const status = peerStatus(b.activity, b.busy);
        return {
          id: b.id,
          name: b.name,
          section: b.section?.trim() || "",
          model: b.modelSelection.model,
          busy: !!b.busy,
          status,
          statusText: peerStatusWords(status),
          title: b.title || undefined,
          description: b.description || undefined,
        };
      });
    return json(res, 200, { bots });
}

// Nothing else ever tells a bot a room id, so this is the discovery
// half of post_to_room: it lists exactly the rooms that tool would
// accept, resolved from the sender's own membership. A room a post
// would be refused for gets no id — an id would only teach the model
// to keep trying — but it is still NAMED, with the refusal it would
// have met. Without that the bot can only say it is in no room at
// all, while the person is looking at it in that very room.
// list_threads: the caller's own threads, plus — on every peer it can
// reach — only the threads the caller itself opened. A peer's other
// threads are its own business (and the person's), so the scope is
// "what you started", never "what that bot is doing". State is read
// the way the sidebar reads it, so the bot and the person agree.
export async function threadsList(ctx: RosterCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, roomHandoffs, connectorThread, threadBusy, internalCapability, internalSender, json,
  } = ctx;
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const rows: Array<{
      threadId: string; botId: string; botName: string; title: string;
      state: "running" | "waiting-on-you" | "queued" | "idle" | "closed";
      unread: boolean; openedAt: number; delegationId?: string; own: boolean;
    }> = [];
    const stateOf = (bot: BotRecord, task: TaskRecord) => {
      if (task.activity === "waiting-on-you") return "waiting-on-you" as const;
      if (threadBusy(bot.id, task.threadId)) return "running" as const;
      if (queuedThreadPosition(bot.id, task.threadId) !== null) return "queued" as const;
      if (roomHandoffs.activeDirect(task.threadId)) return "queued" as const;
      if (task.closedBy) return "closed" as const;
      return "idle" as const;
    };
    for (const task of store.tasks(from.id)) {
      rows.push({
        threadId: task.threadId, botId: from.id, botName: from.name, title: task.title,
        state: stateOf(from, task), unread: task.unread === true, openedAt: task.openedBy?.at ?? task.createdAt,
        delegationId: task.openedBy?.delegationId, own: true,
      });
    }
    for (const peer of reachablePeers(store.bots, from)) {
      for (const task of store.tasks(peer.id)) {
        if (task.openedBy?.botId !== from.id) continue;
        rows.push({
          threadId: task.threadId, botId: peer.id, botName: peer.name, title: task.title,
          state: stateOf(peer, task), unread: task.unread === true, openedAt: task.openedBy.at,
          delegationId: task.openedBy.delegationId, own: false,
        });
      }
    }
    rows.sort((a, b) => b.openedAt - a.openedAt);
    return json(res, 200, { threads: rows.slice(0, 100) });
}

// close_thread: a bot tidies a thread it opened (or one of its own)
// once its result has been read. Closing is the sidebar's idle state
// plus a chip saying who closed it — never a deletion, which stays a
// person's confirmed action, and never while the thread is running.
export async function threadClose(ctx: RosterCtx, res: ServerResponse, closeMatch: RegExpMatchArray): Promise<boolean> {
  const {
    store, roomHandoffs, connectorThread, threadBusy, internalCapability, internalSender, json,
  } = ctx;
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const threadId = closeMatch[1]!;
    const owner = [from, ...reachablePeers(store.bots, from)].find((bot) => store.taskByThread(bot.id, threadId));
    const task = owner ? store.taskByThread(owner.id, threadId) : undefined;
    if (!owner || !task) return json(res, 404, { error: "no such thread — call list_threads for the ones you can see" });
    if (owner.id !== from.id && task.openedBy?.botId !== from.id) {
      return json(res, 403, { error: "that thread is not yours to close — only the bot that opened it, or its own bot, can" });
    }
    if (threadId === fromThreadId) return json(res, 400, { error: "you cannot close the thread you are speaking in — finish your turn instead" });
    if (threadBusy(owner.id, threadId) || queuedThreadPosition(owner.id, threadId) !== null || roomHandoffs.activeDirect(threadId)) {
      return json(res, 409, { error: `#${task.title} is still running — wait for it to finish (list_threads), or the person can stop it from the app` });
    }
    // Closing twice is not an error and leaves no second chip: the
    // thread is already folded away, so there is nothing more to do.
    if (task.closedBy) {
      return json(res, 200, { closed: true, alreadyClosed: true, threadId, title: task.title, botName: owner.name, closedBy: task.closedBy.name });
    }
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: from.id, name: from.name, color: from.color },
      tool: { name: `Closed by @${from.name}`, ok: true },
    });
    if (task.unread) store.patchTask(owner.id, threadId, { unread: false });
    // The stamp is what the sidebar folds on and what list_threads
    // reports; the chip above is only the transcript's record of it.
    store.setTaskClosedBy(owner.id, threadId, { botId: from.id, name: from.name, at: Date.now() });
    return json(res, 200, { closed: true, threadId, title: task.title, botName: owner.name });
}

export async function roomsList(ctx: RosterCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, roomPostEligibility, connectorThread, internalCapability, internalSender, json,
  } = ctx;
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const rooms: Array<{ id: string; name: string; members: string[] }> = [];
    const unpostable: Array<{ name: string; reason: string }> = [];
    for (const group of store.groups) {
      if (group.dm || !group.memberIds.includes(from.id)) continue;
      const eligibility = roomPostEligibility(from, group);
      if (!eligibility.ok) {
        unpostable.push({ name: group.name, reason: eligibility.error });
        continue;
      }
      rooms.push({
        id: group.id,
        name: group.name,
        members: group.memberIds
          .map((id) => store.bot(id))
          .filter((member): member is BotRecord => Boolean(member))
          .map((member) => member.name),
      });
    }
    return json(res, 200, { rooms: rooms.slice(0, 50), unpostable: unpostable.slice(0, 50) });
}


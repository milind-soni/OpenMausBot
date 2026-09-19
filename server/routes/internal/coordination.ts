// Room-target discovery and coordinate_bots dispatch. Body moved verbatim
// from ../internal.ts; the dispatch chain there owns order.
import type { ServerResponse } from "node:http";

import { z } from "zod";
import { fitsOnOneLine } from "../../bot-profile.ts";
import { requestPeerApproval } from "../../peer-approval.ts";
import { reachablePeers, resolveTeammate } from "../../peer-roster.ts";
import { queuedThreadPosition } from "../../steer-queue.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type CoordinationCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  roomHandoffs: InternalRoutesOptions["roomHandoffs"];
  approvalBus: InternalRoutesOptions["approvalBus"];
  roomHandoffProblem: InternalRoutesOptions["roomHandoffProblem"];
  threadBusy: InternalRoutesOptions["threadBusy"];
  delegatedFullAccess: InternalRoutesOptions["delegatedFullAccess"];
  grantDelegatedFullAccess: InternalRoutesOptions["grantDelegatedFullAccess"];
  peerReviewRequired: InternalRoutesOptions["peerReviewRequired"];
}

export async function roomTargetsOrCoordinateBots(ctx: CoordinationCtx, res: ServerResponse, method: string, path: string): Promise<boolean> {
  const {
    store, roomHandoffs, approvalBus, roomHandoffProblem, threadBusy, delegatedFullAccess, grantDelegatedFullAccess,
    peerReviewRequired, internalCapability, internalSender, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
    const source = store.groupByThread(internalCapability.threadId);
    if (!internalCapability.roomCoordination || (source && (source.dm || !source.memberIds.includes(internalSender.id)))) {
      return json(res, 403, { error: "Coordination requires an active chat turn. Finish together already manages its own teammate turns." });
    }
    const address = { groupId: source?.id, threadId: internalCapability.threadId, botId: internalSender.id };
    const problem = roomHandoffProblem(address);
    if (problem) return json(res, 403, { error: problem });
    if (method === "GET" && path === "/api/internal/room-targets") {
      const rooms = store.groups.filter(g => !g.dm).map(g => ({
        id: g.id, name: g.name, workingFolder: g.cwd || null,
        members: g.memberIds.map(id => store.bot(id)).filter(b => b && b.id !== internalSender.id &&
          !roomHandoffProblem({ groupId: g.id, threadId: g.id === source?.id ? address.threadId : g.threadId, botId: b.id }, address))
          .map(b => ({ id: b!.id, name: b!.name, title: b!.title, busy: b!.busy })),
      })).filter(g => g.members.length);
      return json(res, 200, { currentRoom: source ? { id: source.id, name: source.name, workingFolder: source.cwd || null } : null,
        bots: reachablePeers(store.bots, internalSender).map(bot => ({ id: bot.id, name: bot.name, title: bot.title, section: bot.section, busy: bot.busy })),
        rooms, note: "Without group_id: use this room when in a room, otherwise your standing conversation with that teammate — every assignment you send it continues the same thread, so write as if it remembers the last one. Each bot uses its own environment and permissions. Files are not transferred: pass absolute paths only when accessible to the recipient, otherwise pass the content." });
    }
    if (method === "POST" && path === "/api/internal/coordinate-bots") {
      const parsed = z.object({
        groupId: z.string().min(1).max(128).optional(),
        botIds: z.array(z.string().min(1).max(128)).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
        message: z.string().trim().min(1).max(4000), requestKey: z.string().regex(/^[\w-]{1,100}$/),
        rework: z.boolean().default(false),
        // Only ever a name for a thread, so it travels under the same
        // one-line rule as a peer thread title.
        label: z.string().trim().min(1).max(60).refine(fitsOnOneLine).optional(),
      }).safeParse(await readInternalBody());
      if (!parsed.success) return json(res, 400, { error: "Provide 1-4 distinct botIds, message (1-4000 characters), a short requestKey (letters, digits, underscores or hyphens) and an optional one-line label of at most 60 characters." });
      const groupId = parsed.data.groupId ?? source?.id;
      const destination = groupId ? store.group(groupId) : undefined;
      if (groupId && !destination) return json(res, 404, { error: "No such room; use list_room_targets." });
      // A slot may carry a teammate's name instead of its id — the
      // roster shows both, list_bots shows both, and a Chief reading its
      // prompt reaches for the name. A unique reachable name resolves;
      // anything else is refused with the id or name the caller sent
      // and the way to the real ids (peer-roster.ts).
      const botIds: string[] = [];
      for (const raw of parsed.data.botIds) {
        const resolved = resolveTeammate(store.bots, internalSender, raw);
        if ("error" in resolved) return json(res, 403, { error: resolved.error });
        botIds.push(resolved.id);
      }
      if (new Set(botIds).size !== botIds.length) return json(res, 400, { error: "bot_ids name the same teammate twice — send each teammate once" });
      const targets = botIds.map(botId => ({ groupId: destination?.id,
        threadId: destination ? destination.id === source?.id ? address.threadId : destination.threadId : store.bot(botId)?.threadId ?? "", botId,
      }));
      for (const target of targets) {
        // roomHandoffProblem's "no longer exists" is written for a route
        // that was valid and went away. Here the id is the model's own
        // argument — usually a display name dropped into a bot_ids slot —
        // so say which id failed and where the real ones are, instead of
        // telling the model a teammate it can still reach is gone. Only
        // the id the caller sent is echoed back, never a bot's name.
        const addressed = store.bot(target.botId);
        const eligibility =
          target.botId === internalSender.id ? "Choose a teammate, not yourself"
          : !addressed ? `No bot with id "${target.botId}" — call list_bots and copy the exact id from the result`
          : addressed.hidden ? `The bot with id "${target.botId}" is no longer available — call list_bots for the ones you can reach`
          : roomHandoffProblem(target, address);
        if (eligibility) return json(res, 403, { error: eligibility });
      }
      let approvalGranted = false;
      if (peerReviewRequired(internalSender, address.threadId)) {
        const verdicts = await Promise.all(targets.map(target =>
          requestPeerApproval(approvalBus, internalSender, store.bot(target.botId)!, parsed.data.message, "delegate_bot", address.threadId)));
        requireActiveInternalCapability();
        if (verdicts.some(verdict => verdict !== "allow")) return json(res, 403, { error: "Denied by user; no work sent." });
        approvalGranted = true;
      }
      const accepted: { requestId: string; botId: string; duplicate: boolean; status: string }[] = [];
      const errors: { botId: string; error: string }[] = [];
      for (const target of targets) {
        let createdThread: string | undefined;
        try {
          requireActiveInternalCapability();
          if (!destination) {
            // One durable conversation per pair of bots, resolved from
            // the recipient's own threads — never from this turn, the
            // request key, or the thread the person has selected there.
            const resolved = store.resolvePairConversation(internalSender, target.botId, {
              label: parsed.data.label,
              // "Still working" exactly as close_thread reads it: a
              // running turn, a queued one, or coordinated work already
              // addressed at that thread.
              working: threadId => threadBusy(target.botId, threadId)
                || queuedThreadPosition(target.botId, threadId) !== null
                || roomHandoffs.activeDirect(threadId),
            });
            if (!resolved) throw new Error("The recipient no longer exists");
            target.threadId = resolved.task.threadId;
            if (resolved.created) createdThread = resolved.task.threadId;
            if (delegatedFullAccess(internalSender, internalCapability.threadId, store.bot(target.botId)!)) {
              grantDelegatedFullAccess(internalSender, store.bot(target.botId)!, target.threadId);
            }
          }
          const { node, duplicate } = roomHandoffs.enqueue(address, internalCapability.generation, internalCapability.roomHandoffId,
            target, parsed.data.requestKey + ":" + target.botId, parsed.data.message, approvalGranted, parsed.data.rework, [...store.messagesFor(address.threadId)].reverse().find(m => m.role === "user" && m.kind === "text")?.text ?? "");
          // A re-dispatched request_key is answered by the request it
          // already made, so a thread resolved for the retry (the pair
          // conversation was busy with that very request) goes back
          // before anyone sees a row that leads nowhere.
          if (duplicate && createdThread && createdThread !== node.threadId) store.deleteTask(target.botId, createdThread);
          createdThread = undefined; // The durable coordinator now owns this task.
          accepted.push({ requestId: node.id, botId: node.botId, duplicate, status: node.status });
          if (!duplicate) {
            const recipient = store.bot(target.botId)!;
            store.appendMessage(address.threadId, { role: "bot", kind: "activity",
              from: { botId: internalSender.id, name: internalSender.name, color: internalSender.color },
              tool: { name: "Sent to " + recipient.name + (destination && destination.id !== source?.id ? " · " + destination.name : ""), ok: true },
              ...(destination ? { comm: { groupId: destination.id, threadId: node.threadId, withBotId: recipient.id, withName: recipient.name, withColor: recipient.color } }
                : { threadRef: { botId: recipient.id, threadId: node.threadId, title: store.taskByThread(recipient.id, node.threadId)!.title } }),
            });
          }
        } catch (error) {
          if (createdThread) store.deleteTask(target.botId, createdThread);
          errors.push({ botId: target.botId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return json(res, accepted.length ? 200 : 409, { accepted, errors,
        ...(accepted.length ? { message: "End your turn after sending all work. These actual teammates will reply and resume you automatically. Do not poll or wait." } : { error: errors.map(e => e.error).join("; ") }),
      });
    }
    // Neither inner route matched (another method on these paths): keep
    // falling through the dispatch chain in ../internal.ts, as the inline
    // body did.
    return false;
}

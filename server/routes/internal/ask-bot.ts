// ask_bot: the synchronous peer turn, with approval, mirroring, and the
// timeout-to-delegation conversion. Body moved verbatim from ../internal.ts;
// the dispatch chain there owns order.
import type { ServerResponse } from "node:http";

import { getOrCreateChannel, mirrorActivity, mirrorExchange, mirrorReply } from "../../comms-visibility.ts";
import { newId } from "../../contracts.ts";
import { queueDelegation } from "../../delegations.ts";
import { PEER_ACCESS_HELP, canAccessTeam, canReachPeer, peerAllowed, resolveTeammate } from "../../peer-roster.ts";
import { withPeerProvenance } from "../../peer-provenance.ts";
import { requestPeerApproval } from "../../peer-approval.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type AskBotCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  commsBus: InternalRoutesOptions["commsBus"];
  approvalBus: InternalRoutesOptions["approvalBus"];
  delegationWatch: InternalRoutesOptions["delegationWatch"];
  askBotAndWait: InternalRoutesOptions["askBotAndWait"];
  activeRoutineRunForThread: InternalRoutesOptions["activeRoutineRunForThread"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  peerReviewRequired: InternalRoutesOptions["peerReviewRequired"];
  isUnattended: InternalRoutesOptions["isUnattended"];
  ASK_BOT_TIMEOUT_MS: InternalRoutesOptions["ASK_BOT_TIMEOUT_MS"];
  MAX_COMMS_DEPTH: InternalRoutesOptions["MAX_COMMS_DEPTH"];
}

export async function askBot(ctx: AskBotCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, commsBus, approvalBus, delegationWatch, askBotAndWait, activeRoutineRunForThread, connectorThread,
    peerReviewRequired, isUnattended, ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH,
    internalCapability, internalSender, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
    const body = await readInternalBody();
    const fromBotId = internalSender.id;
    const toBotRef = String(body.toBotId ?? "");
    const message = String(body.message ?? "").trim();
    if (
      body.depth !== undefined &&
      (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
    ) {
      return json(res, 403, { error: "the recursion depth does not match this turn" });
    }
    const depth = internalCapability.depth;
    if (!toBotRef || !message) return json(res, 400, { error: "toBotId and message required" });
    if (toBotRef === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
    if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
    // A unique reachable teammate name is accepted where an id is
    // expected; see resolveTeammate for why.
    const resolvedTo = resolveTeammate(store.bots, internalSender, toBotRef);
    if ("error" in resolvedTo) return json(res, 404, { error: `no such bot: ${resolvedTo.error}` });
    if (resolvedTo.id === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
    const toBotId = resolvedTo.id;
    const target = store.bot(toBotId);
    if (!target) return json(res, 404, { error: "no such bot" });
    // An unknown sender used to fall through: no mirroring AND no
    // approval, while still running the peer turn. That made an
    // unresolvable id the cheapest way past the gate, so it is now a
    // hard refusal — every peer turn has an accountable sender.
    const from = internalSender;
    if (!canAccessTeam(from, target.section) || target.hidden) {
      return json(res, 403, { error: `that bot belongs to a different section or is unavailable. ${PEER_ACCESS_HELP}` });
    }
    // The sender's allow-list, when it has one. Checked here rather than
    // trusted from the roster: the tool call carries a bot id, and an id
    // the model held from an earlier turn must not outlive the grant.
    if (!peerAllowed(from, target.id)) {
      return json(res, 403, { error: `that bot is not on this bot's allowed peers. ${PEER_ACCESS_HELP}` });
    }
    const fromThreadId = internalCapability.threadId;
    // Rooms are conversations too. The task-only lookup here refused every
    // ask made from a room turn — the bot could see its teammates and not
    // reach them — while create_bot and the routine endpoints already
    // accepted a group thread the sender belongs to. One ownership rule,
    // and it is still the sender's own membership that decides.
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source thread does not belong to sender" });
    }
    // A busy peer used to be a flat bounce ("try again later") — a
    // dead-end mid-turn that models rarely retry, so the exchange just
    // evaporated. Demote the synchronous ask into a durable handoff
    // instead: the message waits in the delegation ledger (up to 24
    // hours, receipts, restart-safe) and the asker gets a task id it
    // can check next turn. If the ledger refuses (cap/depth), fall back
    // to the plain busy bounce rather than dropping the refusal reason.
    const queueBusyFallback = (approvalAlreadyGranted = false) => {
      const queued = queueDelegation(
        commsBus,
        from,
        { toBotId, message, reason: "asked while busy", depth, approvalAlreadyGranted },
        MAX_COMMS_DEPTH,
        fromThreadId,
      );
      if (queued.result !== "ok" || !queued.id) return json(res, 200, { busy: true });
      return json(res, 200, { busy: true, taskId: queued.id, toBotName: target.name });
    };
    if (target.busy) return queueBusyFallback();
    let currentFrom = from;
    let currentTarget = target;

    // the exchange is mirrored into a bot⇄bot channel: it shows up in
    // the sidebar like any room, keeps the pair's full history, and the
    // user can open it and chip in. Both 1:1 threads get a clickable
    // chip that opens the channel, so bot-to-bot turns are never
    // invisible (they cost the user tokens).
    //
    // per-bot approval gate: a chief-of-staff bot without this on is
    // free to coordinate; one with it on must wait for a human card
    // (15-min timeout → deny) before its peer turn starts. The channel
    // and the chips are created only AFTER the verdict, so a denied
    // contact leaves no trace of an exchange that never happened.
    if (peerReviewRequired(from, fromThreadId)) {
      const verdict = await requestPeerApproval(
        approvalBus,
        from,
        target,
        message,
        "ask_bot",
        fromThreadId,
      );
      requireActiveInternalCapability();
      if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
      // The card may have been open for minutes. Re-read both records so
      // deleted bots cannot recreate transcripts through stale objects.
      const freshFrom = store.bot(fromBotId);
      const freshTarget = store.bot(toBotId);
      if (!freshFrom || !freshTarget) return json(res, 404, { error: "no such bot" });
      if (!canAccessTeam(freshFrom, freshTarget.section) || freshTarget.hidden) {
        return json(res, 200, { error: "that bot moved to a different section" });
      }
      if (!peerAllowed(freshFrom, freshTarget.id)) {
        return json(res, 200, { error: "that bot is no longer an allowed peer" });
      }
      // Membership can be revoked while the card is open: re-check the
      // same way, so a bot removed from a room mid-approval cannot go on
      // speaking through it.
      if (!connectorThread(freshFrom.id, fromThreadId)) {
        return json(res, 404, { error: "source conversation no longer belongs to sender" });
      }
      // The user just approved this exact ask_bot request. Preserve that
      // decision if it has to become an async handoff; asking twice makes
      // the fallback look stuck behind a second, surprising card.
      if (freshTarget.busy) return queueBusyFallback(true);
      currentFrom = freshFrom;
      currentTarget = freshTarget;
    }
    // An ask made from inside a room is mirrored into that room — the
    // conversation the person is actually reading — the way delegate_bot
    // already does. The pair channel is for asks made from a bot's own
    // thread; sending a room's ask there put the whole exchange behind
    // an unbadged "A ⇄ B" entry nobody had a reason to open.
    const channel = getOrCreateChannel(
      store,
      currentFrom,
      currentTarget,
      connectorThread(currentFrom.id, fromThreadId)?.group,
    );
    mirrorExchange(commsBus, currentFrom, currentTarget, message, channel, fromThreadId);
    const prefixed = withPeerProvenance(message, {
      botName: currentFrom.name,
      delivery: "ask_bot",
      unattended: isUnattended(currentFrom.id, fromThreadId),
    });
    const targetThreadId = currentTarget.threadId;
    const outcome = await askBotAndWait(toBotId, prefixed, depth, fromBotId, fromThreadId, targetThreadId);
    requireActiveInternalCapability();
    const replySender = store.bot(fromBotId);
    const replyTarget = store.bot(toBotId);
    if (!replySender || !replyTarget || !canReachPeer(replySender, replyTarget)) {
      return json(res, 403, { error: "Result withheld: team access changed while the teammate was working" });
    }
    if (outcome.status === "timeout" && !delegationWatch.has(targetThreadId)) {
      // The peer's turn is still running — only the wait ended. Convert
      // the ask into a delegation claim ticket: the watch mirrors the
      // terminal state into the channel AND the asker's thread when the
      // turn settles, and check/wait_delegation read the same receipt.
      // Losing the reply was the old behavior, and it read as "the bots
      // don't respond to each other".
      const taskId = newId();
      delegationWatch.set(targetThreadId, {
        channelId: channel.id,
        toBotId,
        toBotName: currentTarget.name,
        taskId,
        sourceThreadId: fromThreadId,
        sourceBotId: currentFrom.id,
        routineRunId: activeRoutineRunForThread(fromThreadId)?.id,
      });
      store.appendMessage(fromThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `@${currentTarget.name} is still working — ask converted to a delegation` },
      });
      return json(res, 200, { timeout: true, taskId, toBotName: currentTarget.name, waitedMs: ASK_BOT_TIMEOUT_MS });
    }
    if (outcome.status === "failed" && !outcome.text.trim()) {
      // No partial answer to hand back — mirror the failure where the
      // exchange lives, with the provider's reason instead of silence.
      const why = outcome.stopReason?.trim() ? ` — ${outcome.stopReason.trim().slice(0, 120)}` : "";
      mirrorActivity(commsBus, currentTarget, channel, `Turn failed${why}`, false);
      return json(res, 200, { botName: currentTarget.name, text: `(the bot's turn failed${why})` });
    }
    const reply = outcome.status === "timeout"
      ? outcome.text || "(timed out waiting for the bot to reply)"
      : outcome.text;
    mirrorReply(commsBus, currentTarget, reply, channel);
    return json(res, 200, { botName: currentTarget.name, text: reply });
}

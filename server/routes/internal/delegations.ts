// Delegation status long-poll and delegate_bot queueing. Bodies moved
// verbatim from ../internal.ts; the dispatch chain there owns order.
import type { ServerResponse } from "node:http";

import { DELEGATION_TTL_MS, findDelegationReceipt, pendingDelegationInfo, queueDelegation, summarizeDelegatedActivity, type QueueResult } from "../../delegations.ts";
import { canAccessTeam, peerAllowed, peerStatus, resolveTeammate, PEER_ACCESS_HELP} from "../../peer-roster.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type DelegationsCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  commsBus: InternalRoutesOptions["commsBus"];
  delegationWatch: InternalRoutesOptions["delegationWatch"];
  MAX_COMMS_DEPTH: InternalRoutesOptions["MAX_COMMS_DEPTH"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  peerReviewRequired: InternalRoutesOptions["peerReviewRequired"];
}

// Async handoff: the source bot queues a task for a peer and goes
// back to the user; the peer turn runs after the source's
// turn.completed. Returns immediately (the caller does not wait).
export async function delegationStatus(ctx: DelegationsCtx, res: ServerResponse, url: URL, delegationMatch: RegExpMatchArray): Promise<boolean> {
  const {
    store, delegationWatch, connectorThread, internalCapability, internalSender, json,
  } = ctx;
    const taskId = delegationMatch[1];
    const fromThreadId = internalCapability.threadId;
    const from = internalSender;
    if (!connectorThread(from.id, fromThreadId)) return json(res, 403, { error: "unknown sender" });
    const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms")) || 0, 0), 240_000);
    const deadline = Date.now() + waitMs;
    // Bounded long-poll: the delegating bot parks ONE cheap HTTP request
    // here instead of burning a model inference per status check.
    for (;;) {
      const receipt = findDelegationReceipt(taskId);
      if (receipt) {
        if (receipt.sourceThreadId !== fromThreadId) {
          return json(res, 403, { error: "that task belongs to a different conversation" });
        }
        return json(res, 200, { status: receipt.status, toBotName: receipt.toBotName, result: receipt.result ?? "" });
      }
      const stillQueued = pendingDelegationInfo(taskId);
      const runningEntry = [...delegationWatch.entries()].find(([, watch]) => watch.taskId === taskId);
      const running = runningEntry?.[1];
      const owner = stillQueued?.sourceThreadId ?? running?.sourceThreadId;
      if (!owner) return json(res, 404, { error: "unknown task id — delegation receipts are kept for about 48 hours" });
      if (owner !== fromThreadId) return json(res, 403, { error: "that task belongs to a different conversation" });
      if (Date.now() >= deadline) {
        const toBotId = stillQueued?.toBotId ?? running?.toBotId ?? "";
        if (running && runningEntry) {
          const recent = summarizeDelegatedActivity(
            store.messagesFor(runningEntry[0]),
            running.startedAtMs ?? Date.now(),
          );
          return json(res, 200, {
            status: "running",
            toBotName: store.bot(toBotId)?.name ?? toBotId,
            elapsedMs: Math.max(0, Date.now() - (running.startedAtMs ?? Date.now())),
            recentActivity: recent,
          });
        }
        const queuedTarget = store.bot(toBotId);
        return json(res, 200, {
          status: "queued",
          toBotName: queuedTarget?.name ?? toBotId,
          ...(stillQueued
            ? {
              // A deleted target must never read as "available" — peerStatus's
              // undefined/undefined fallback is "available", which is wrong here.
              targetStatus: queuedTarget ? peerStatus(queuedTarget.activity, queuedTarget.busy) : "unavailable",
              expiresInMs: Math.max(0, stillQueued.queuedAt + DELEGATION_TTL_MS - Date.now()),
            }
            : {}),
        });
      }
      await new Promise((wake) => setTimeout(wake, 500));
    }
}

export async function delegateBot(ctx: DelegationsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, commsBus, MAX_COMMS_DEPTH, connectorThread, peerReviewRequired, internalCapability, internalSender, json, readInternalBody,
  } = ctx;
    const body = await readInternalBody();
    const toBotRef = String(body.toBotId ?? "");
    const message = String(body.message ?? "").trim();
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
    if (
      body.depth !== undefined &&
      (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
    ) {
      return json(res, 403, { error: "the recursion depth does not match this turn" });
    }
    const depth = internalCapability.depth;
    if (!toBotRef || !message) return json(res, 400, { error: "toBotId and message required" });
    const from = internalSender;
    const resolvedTo = resolveTeammate(store.bots, from, toBotRef);
    if ("error" in resolvedTo) return json(res, 404, { error: `no such bot: ${resolvedTo.error}` });
    const toBotId = resolvedTo.id;
    const target = store.bot(toBotId);
    if (!target) return json(res, 404, { error: "no such bot" });
    if (!canAccessTeam(from, target.section) || target.hidden) {
      return json(res, 403, { error: `that bot belongs to a different section or is unavailable. ${PEER_ACCESS_HELP}` });
    }
    if (!peerAllowed(from, target.id)) {
      return json(res, 403, { error: `that bot is not on this bot's allowed peers. ${PEER_ACCESS_HELP}` });
    }
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source thread does not belong to sender" });
    }
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId, message, reason, depth },
      MAX_COMMS_DEPTH,
      fromThreadId,
    );
    if (queued.result !== "ok" || !queued.id) {
      // the agent reads this string — a bare enum ("too_deep") tells it
      // nothing about what to do instead
      const said: Record<Exclude<QueueResult, "ok">, string> = {
        self: "a bot cannot delegate to itself",
        too_deep: "delegation chains are limited to one hop — do this one yourself",
        no_target: "no such bot",
        too_many: "too many delegations queued on this turn — finish some first",
      };
      return json(res, 200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
    }
    const targetName = store.bot(toBotId)?.name ?? toBotId;
    return json(res, 200, {
      queued: true,
      taskId: queued.id,
      message: peerReviewRequired(from, internalCapability.threadId)
        ? `Queued for review — @${targetName} will only pick it up if the user approves after your turn finishes.`
        : `Delegation queued — @${targetName} will pick it up after your current turn finishes.`,
    });
}

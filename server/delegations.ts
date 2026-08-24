// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { cancelPeerApprovalForOwner, requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import { WorkOrderCapacityError, WorkOrderInputError, WorkOrderStore } from "./work-orders.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
}

interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for crash-safe removal from the queue. */
  id: string;
  /** Durable lifecycle record, when the server has work-order persistence enabled. */
  workOrderId?: string;
  /** Target task pinned when the delegation was accepted. */
  targetTaskId?: string;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many" | "capacity" | "invalid_input";

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");

function savePending(): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist queue", error);
  }
}

/** Load what a previous process left queued. Missing or corrupt → empty. */
export function _loadPending(): void {
  pendingDelegations.clear();
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        return [{
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          toBotId: item.toBotId,
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          ...(typeof item.workOrderId === "string" && item.workOrderId ? { workOrderId: item.workOrderId } : {}),
          ...(typeof item.targetTaskId === "string" && item.targetTaskId ? { targetTaskId: item.targetTaskId } : {}),
        }];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = 4;

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = from.threadId,
  workOrders?: WorkOrderStore,
  sourceExecutionId?: string,
): QueueResult {
  if (item.toBotId === from.id) return "self";
  if (item.depth >= maxDepth) return "too_deep";
  const target = bus.store.bot(item.toBotId);
  if (!target) return "no_target";
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return "too_many";
  let workOrder;
  try {
    workOrder = workOrders?.create({
      kind: "delegation",
      sourceBotId: from.id,
      sourceTaskId: sourceThreadId,
      ...(sourceExecutionId ? { sourceExecutionId } : {}),
      targetBotId: target.id,
      targetTaskId: target.threadId,
      request: item.message,
      ...(item.reason ? { reason: item.reason } : {}),
      priority: "peer",
      depth: item.depth,
      delivery: "channel",
    });
  } catch (error) {
    if (error instanceof WorkOrderCapacityError) return "capacity";
    if (error instanceof WorkOrderInputError) return "invalid_input";
    throw error;
  }
  list.push({
    ...item,
    id: newId(),
    targetTaskId: target.threadId,
    ...(workOrder ? { workOrderId: workOrder.id } : {}),
  });
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
  });
  return "ok";
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
    workOrderId?: string,
    targetTaskId?: string,
  ) => void | Promise<void>,
  workOrders?: WorkOrderStore,
): void {
  if (drainingThreads.has(threadId)) return;
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const from = bus.store.botByThread(threadId);
  if (!from) {
    pendingDelegations.delete(threadId);
    savePending();
    return;
  }
  const snapshot = [...list];
  drainingThreads.add(threadId);
  let deferred = false;
  void (async () => {
    for (const item of snapshot) {
      try {
        const result = await processOne(bus, approvalBus, from, threadId, item, runTarget, workOrders);
        if (result === "defer") {
          deferred = true;
          break;
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        try {
          bus.store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `error: delegation failed — ${why.slice(0, 120)}`, ok: false },
          });
        } catch (reportError) {
          console.error("delegation failed and could not be reported", reportError);
        }
      } finally {
        if (!deferred) acknowledgeDelegation(threadId, item.id);
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    // A later turn may have queued and settled while this thread was
    // waiting for approval. Its items were not in our snapshot, so start a
    // fresh drain instead of leaving them parked until another restart.
    if (!deferred && pendingDelegations.get(threadId)?.length) {
      drainDelegations(bus, approvalBus, threadId, runTarget, workOrders);
    }
  });
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus: CommsBus, threadId: string, workOrders?: WorkOrderStore): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  pendingDelegations.delete(threadId);
  savePending();
  for (const item of list) transitionIfActive(workOrders, item.workOrderId, "cancelled", { error: "source turn did not finish" });
  const from = bus.store.botByThread(threadId);
  if (!from) return;
  bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
  });
}

/** Remove a queued item by its durable id. The in-memory queue can otherwise
 * outlive a cancellation request and dispatch work that the API already
 * reported as cancelled. */
export function cancelDelegationByWorkOrder(workOrderId: string, workOrders?: WorkOrderStore): boolean {
  let removed = false;
  for (const [threadId, list] of pendingDelegations) {
    const remaining = list.filter((item) => item.workOrderId !== workOrderId);
    if (remaining.length === list.length) continue;
    removed = true;
    if (remaining.length) pendingDelegations.set(threadId, remaining);
    else pendingDelegations.delete(threadId);
  }
  if (removed) savePending();
  cancelPeerApprovalForOwner(workOrderId);
  transitionIfActive(workOrders, workOrderId, "cancelled", { error: "cancelled by user" });
  return removed;
}

/** Drop queued items targeting a bot that is being deleted. */
export function discardDelegationsForTarget(bus: CommsBus, botId: string, workOrders?: WorkOrderStore): void {
  let changed = false;
  for (const [threadId, list] of pendingDelegations) {
    const removed = list.filter((item) => item.toBotId === botId);
    if (!removed.length) continue;
    changed = true;
    const remaining = list.filter((item) => item.toBotId !== botId);
    if (remaining.length) pendingDelegations.set(threadId, remaining);
    else pendingDelegations.delete(threadId);
    for (const item of removed) {
      transitionIfActive(workOrders, item.workOrderId, "failed", { error: "target bot was deleted" });
    }
    if (bus.store.botByThread(threadId)) {
      bus.store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: delegation to ${botId} failed — target bot was deleted`, ok: false },
      });
    }
  }
  if (changed) savePending();
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
    workOrderId?: string,
    targetTaskId?: string,
  ) => void | Promise<void>,
  workOrders?: WorkOrderStore,
): Promise<"done" | "defer"> {
  const existing = workOrders?.get(item.workOrderId ?? "");
  if (existing && ["completed", "failed", "cancelled"].includes(existing.state)) return "done";
  let sender = from;
  let target = bus.store.bot(item.toBotId);
  const targetTaskId = existing?.targetTaskId ?? item.targetTaskId ?? target?.threadId;
  const sourceTaskId = existing?.sourceTaskId ?? sourceThreadId;
  if (workOrders && item.workOrderId && (!existing || existing.sourceTaskId !== sourceThreadId)) return "done";
  if (!bus.store.taskByThread(from.id, sourceTaskId)) {
    transitionIfActive(workOrders, item.workOrderId, "failed", { error: "source task no longer exists" });
    return "done";
  }
  if (!target) {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
    });
    transitionIfActive(workOrders, item.workOrderId, "failed", { error: "target bot no longer exists" });
    return "done";
  }
  if (!targetTaskId || !bus.store.taskByThread(target.id, targetTaskId)) {
    transitionIfActive(workOrders, item.workOrderId, "failed", { error: "target task no longer exists" });
    return "done";
  }
  if (existing?.state === "queued") {
    // A recovered/approved item has already passed the source approval gate.
  }
  if (target.busy) {
    // Busy is admission pressure, not a terminal failure. The item remains
    // durable and is retried when the target's current turn settles.
    return "defer";
  }
  if (sender.approvePeerComms && existing?.state !== "queued") {
    transitionIfActive(workOrders, item.workOrderId, "awaiting-approval");
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
      item.workOrderId,
    );
    const afterApproval = workOrders?.get(item.workOrderId ?? "");
    if (afterApproval?.state === "cancelled" || afterApproval?.state === "failed") return "done";
    if (verdict !== "allow") {
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
      });
      transitionIfActive(workOrders, item.workOrderId, "cancelled", { error: "denied by user" });
      return "done";
    }
    // The approval could have been sitting for up to 15 minutes. Everything
    // checked above is a stale snapshot now: re-read both bots and re-check
    // busy, or an allow can start a second turn on a bot that is mid-turn —
    // and mirror a "Messaged @X" chip for an exchange that never happens.
    const current = bus.store.bot(item.toBotId);
    const currentSender = bus.store.bot(from.id);
    if (!current || !currentSender || !bus.store.taskByThread(currentSender.id, sourceTaskId) || !bus.store.taskByThread(current.id, targetTaskId)) {
      transitionIfActive(workOrders, item.workOrderId, "failed", { error: "source or target task no longer exists" });
      return "done";
    }
    if (current.busy) {
      transitionIfActive(workOrders, item.workOrderId, "queued");
      return "defer";
    }
    sender = currentSender;
    target = current;
  }
  if (existing?.state === "pending-source") transitionIfActive(workOrders, item.workOrderId, "queued");
  const currentOrder = workOrders?.get(item.workOrderId ?? "");
  if (currentOrder?.state === "cancelled" || currentOrder?.state === "failed") return "done";
  const channel = getOrCreateChannel(bus.store, sender, target);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${sender.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  transitionIfActive(workOrders, item.workOrderId, "running", { attempt: (workOrders?.get(item.workOrderId ?? "")?.attempt ?? 0) + 1 });
  try {
    await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, item.workOrderId, targetTaskId);
    if (workOrders?.get(item.workOrderId ?? "")?.state === "running") {
      transitionIfActive(workOrders, item.workOrderId, "completed");
    }
  } catch (error) {
    if (workOrders?.get(item.workOrderId ?? "")?.state === "running") {
      transitionIfActive(workOrders, item.workOrderId, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
  return "done";
}

function transitionIfActive(
  workOrders: WorkOrderStore | undefined,
  id: string | undefined,
  to: "awaiting-approval" | "queued" | "running" | "completed" | "failed" | "cancelled",
  patch: { result?: string; error?: string; attempt?: number } = {},
): void {
  if (!workOrders || !id) return;
  const current = workOrders.get(id);
  if (!current || ["completed", "failed", "cancelled"].includes(current.state)) return;
  workOrders.transition(id, to, patch);
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: whether a source thread's asynchronous drain is still settling. */
export function _isDraining(threadId: string): boolean {
  return drainingThreads.has(threadId);
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
}

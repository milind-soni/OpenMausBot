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
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { peerAllowed } from "./peer-roster.ts";
import { sectionKey, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The user already approved this exact peer message while it was still
   * an ask_bot request. If that peer became busy before dispatch, the
   * fallback handoff must not ask them to approve the same action twice. */
  approvalAlreadyGranted?: boolean;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
  /** When the delegation is initiated from a shared channel, mirror the
   * exchange back into that channel instead of creating a pair DM. */
  originatingGroupId?: string;
  /** start_thread on a peer: the thread the opener created on the target
   * for this handoff. The target's turn runs THERE, not in whatever the
   * person is looking at, and "busy" means "no free slot" rather than
   * "any thread running". Absent = a classic delegation into the target's
   * active thread. */
  targetThreadId?: string;
}

interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for crash-safe removal from the queue —
   * and the task id the delegating bot uses with check/wait_delegation. */
  id: string;
  /** The bot that queued this handoff. Stored explicitly because a shared
   * channel's thread is not owned by any single bot. */
  sourceBotId: string;
  /** Busy-target retries so far. The item stays queued (not canceled) while
   * the target is busy, and is retried when any of the target's turns
   * settles — up to MAX_BUSY_ATTEMPTS. */
  attempts: number;
  /** True after this item observed the target's current busy period. Other
   * queue activity must not count that same period again; the target's idle
   * transition clears this marker before the next retry. */
  waitingOnBusy?: boolean;
}

export type DelegationOutcome = "done" | "failed" | "denied" | "busy_gave_up" | "dropped" | "error";

/** The durable terminal record of one handoff: what the delegating bot reads
 * back with check_delegation / wait_delegation. Bounded and pruned — this is
 * a receipt drawer, not a transcript. */
export interface DelegationReceipt {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  status: DelegationOutcome;
  /** the peer's reply on success; the failure name otherwise (bounded) */
  result?: string;
  finishedAt: number;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

/** What queueDelegation hands back: the verdict, and on success the task id
 * the delegating bot can later read back with check/wait_delegation. */
export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
}

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
/** Threads whose drain was requested WHILE a drain was already running.
 * Dropping such a request loses real work: the waiting-on retry fires the
 * moment a busy target settles, and that can land mid-drain. */
const queuedRedrains = new Set<string>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");
const RECEIPTS_FILE = join(DATA_DIR, "delegation-receipts.json");
const MAX_RECEIPTS = 100;
const RECEIPT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RESULT_MAX_CHARS = 4_000;
export const MAX_BUSY_ATTEMPTS = 3;

let receipts: DelegationReceipt[] = [];

function saveReceipts(): void {
  try {
    writeFileAtomic(RECEIPTS_FILE, JSON.stringify(receipts, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist receipts", error);
  }
}

/** Record one terminal outcome. Newest first; pruned by count and age so the
 * drawer can never grow without bound. */
export function recordDelegationReceipt(receipt: Omit<DelegationReceipt, "finishedAt"> & { finishedAt?: number }): void {
  const now = Date.now();
  const bounded: DelegationReceipt = {
    id: receipt.id,
    sourceThreadId: receipt.sourceThreadId,
    toBotId: receipt.toBotId,
    toBotName: receipt.toBotName,
    status: receipt.status,
    finishedAt: receipt.finishedAt ?? now,
  };
  if (receipt.result !== undefined) bounded.result = receipt.result.slice(0, RESULT_MAX_CHARS);
  receipts = [bounded, ...receipts.filter((existing) => existing.id !== bounded.id)]
    .filter((existing) => now - existing.finishedAt <= RECEIPT_MAX_AGE_MS)
    .slice(0, MAX_RECEIPTS);
  saveReceipts();
}

export function findDelegationReceipt(id: string): DelegationReceipt | null {
  return receipts.find((receipt) => receipt.id === id) ?? null;
}

/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(id: string): { sourceThreadId: string; toBotId: string; attempts: number } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, attempts: item.attempts };
  }
  return null;
}

/** Source threads currently waiting for this busy bot — the set its idle
 * transition re-drains. Fresh items are excluded: they run when their SOURCE
 * turn settles, and draining them early would start the peer too soon. */
export function threadsWaitingOn(toBotId: string): string[] {
  return [...pendingDelegations.entries()]
    .filter(([, items]) => items.some((item) => item.toBotId === toBotId && item.waitingOnBusy === true))
    .map(([threadId]) => threadId);
}

/** Mark a target's observed busy period as finished and return the source
 * threads that should be retried. This makes retries count distinct busy
 * periods, not unrelated drain requests on the same source thread.
 * `only` narrows the release: a bot that is still busy in one thread has
 * nevertheless freed a slot for the fresh-thread handoffs waiting on it,
 * while its active-thread handoffs go on waiting for it to go idle. */
export function releaseDelegationsWaitingOn(toBotId: string, only?: (item: DelegationItem) => boolean): string[] {
  const released: string[] = [];
  for (const [threadId, items] of pendingDelegations) {
    let any = false;
    for (const item of items) {
      if (item.toBotId !== toBotId || item.waitingOnBusy !== true || (only && !only(item))) continue;
      delete item.waitingOnBusy;
      any = true;
    }
    if (any) released.push(threadId);
  }
  if (released.length) savePending();
  return released;
}

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
        const loaded: PendingDelegationItem = {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          sourceBotId: typeof item.sourceBotId === "string" && item.sourceBotId ? item.sourceBotId : "",
          toBotId: item.toBotId,
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
        };
        if (item.approvalAlreadyGranted === true) loaded.approvalAlreadyGranted = true;
        if (item.waitingOnBusy === true) loaded.waitingOnBusy = true;
        if (typeof item.originatingGroupId === "string" && item.originatingGroupId) {
          loaded.originatingGroupId = item.originatingGroupId;
        }
        if (typeof item.targetThreadId === "string" && item.targetThreadId) {
          loaded.targetThreadId = item.targetThreadId;
        }
        return [loaded];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
  receipts = [];
  try {
    const rawReceipts = JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"));
    if (Array.isArray(rawReceipts)) {
      const now = Date.now();
      const loaded: DelegationReceipt[] = [];
      for (const value of rawReceipts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        // SAFETY: the Partial view only names candidate fields; every one is
        // narrowed below before a receipt is constructed from the narrowed
        // locals, so nothing unvalidated survives into `receipts`.
        const candidate = value as Partial<DelegationReceipt>;
        const { id, sourceThreadId, toBotId, toBotName, status, result, finishedAt } = candidate;
        if (typeof id !== "string" || !id) continue;
        if (typeof sourceThreadId !== "string" || typeof toBotId !== "string") continue;
        if (typeof toBotName !== "string" || typeof status !== "string") continue;
        if (!Number.isFinite(finishedAt) || now - finishedAt! > RECEIPT_MAX_AGE_MS) continue;
        const receipt: DelegationReceipt = { id, sourceThreadId, toBotId, toBotName, status, finishedAt: finishedAt! };
        if (typeof result === "string") receipt.result = result;
        loaded.push(receipt);
      }
      receipts = loaded.slice(0, MAX_RECEIPTS);
    }
  } catch {
    /* no receipts yet */
  }
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** Read-only metadata for the local Team Map. Task prompts stay private;
 * the UI only needs to know who handed work to whom and the optional label. */
export function pendingDelegationSnapshot(): Array<{
  sourceThreadId: string;
  sourceBotId: string;
  toBotId: string;
  reason?: string;
  targetThreadId?: string;
}> {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => ({
      sourceThreadId,
      sourceBotId: item.sourceBotId,
      toBotId: item.toBotId,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.targetThreadId ? { targetThreadId: item.targetThreadId } : {}),
    })),
  );
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
): QueuedDelegation {
  if (item.toBotId === from.id) return { result: "self" };
  if (item.depth >= maxDepth) return { result: "too_deep" };
  const target = bus.store.bot(item.toBotId);
  if (!target) return { result: "no_target" };
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  // If the source thread is a shared group that contains both bots, keep it
  // as the authoritative channel instead of routing into a pair DM later.
  const originatingGroup = item.originatingGroupId
    ? bus.store.group(item.originatingGroupId)
    : (sourceThreadId ? bus.store.groupByThread(sourceThreadId) : undefined);
  const groupId =
    originatingGroup &&
    !originatingGroup.dm &&
    originatingGroup.memberIds.includes(from.id) &&
    originatingGroup.memberIds.includes(target.id)
      ? originatingGroup.id
      : undefined;
  const id = newId();
  list.push({ ...item, id, sourceBotId: from.id, attempts: 0, ...(groupId ? { originatingGroupId: groupId } : {}) });
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const sourceGroup = sourceThreadId ? bus.store.groupByThread(sourceThreadId) : undefined;
  // A fresh-thread handoff is announced as the thread it opened, with a
  // link to it; a classic one as the delegation it is.
  const openedThread = item.targetThreadId ? bus.store.taskByThread(target.id, item.targetThreadId) : undefined;
  const chip: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "activity",
    // settled at birth: queueing is the whole act. Left open, the chip
    // would spin until the transcript is closed — the chat never patches it
    tool: {
      name: openedThread
        ? `Opened thread #${openedThread.title} on ${target.name}`
        : `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`,
      ok: true,
    },
  };
  if (openedThread) chip.threadRef = { botId: target.id, threadId: openedThread.threadId, title: openedThread.title };
  if (sourceGroup && !sourceGroup.dm) chip.from = { botId: from.id, name: from.name, color: from.color };
  bus.store.appendMessage(sourceThreadId, chip);
  return { result: "ok", id };
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
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
    targetThreadId: string | undefined,
  ) => void | Promise<void>,
  /** Terminal failures before dispatch also need to wake the source. A
   * launched peer reports through its provider-turn finalizer instead. */
  onSettled?: (receipt: DelegationReceipt) => void,
): void {
  if (drainingThreads.has(threadId)) {
    queuedRedrains.add(threadId);
    return;
  }
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const snapshot = [...list];
  drainingThreads.add(threadId);
  void (async () => {
    for (const item of snapshot) {
      // Stop/deletion may remove queued work while another item awaits a
      // person's approval. A stale snapshot is never authority to launch it.
      if (!pendingDelegations.get(threadId)?.some((candidate) => candidate.id === item.id)) continue;
      // A shared channel's thread is not owned by any single bot, so each
      // queued item carries its own source bot identity.
      const from =
        bus.store.botByThread(threadId) ??
        bus.store.bot(item.sourceBotId);
      if (!from) {
        recordDelegationReceipt({
          id: item.id,
          sourceThreadId: threadId,
          toBotId: item.toBotId,
          toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
          status: "dropped",
          result: "the delegating bot no longer exists",
        });
        acknowledgeDelegation(threadId, item.id);
        continue;
      }
      let outcome: "settled" | "requeued" | "dispatched" = "settled";
      try {
        outcome = await processOne(bus, approvalBus, from, threadId, item, runTarget);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        recordDelegationReceipt({
          id: item.id,
          sourceThreadId: threadId,
          toBotId: item.toBotId,
          toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
          status: "error",
          result: why.slice(0, 200),
        });
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
        // A requeued item (busy target, retries left) stays for the drain
        // that the target's own settling turn will trigger.
        const stillQueued = pendingDelegations.get(threadId)?.some((candidate) => candidate.id === item.id);
        if (outcome !== "requeued") acknowledgeDelegation(threadId, item.id);
        if (outcome === "settled" && stillQueued) {
          const receipt = findDelegationReceipt(item.id);
          try {
            if (receipt) onSettled?.(receipt);
          } catch (error) {
            console.error("delegation settled but its source could not be resumed", error);
          }
        }
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    // A later turn may have queued and settled while this thread was
    // waiting for approval. Only items OUTSIDE our snapshot warrant a fresh
    // drain — re-draining a just-requeued item would burn its bounded busy
    // retries in milliseconds instead of once per target settle.
    const redrainRequested = queuedRedrains.delete(threadId);
    const snapshotIds = new Set(snapshot.map((item) => item.id));
    const hasNewItems = pendingDelegations.get(threadId)?.some((item) => !snapshotIds.has(item.id)) ?? false;
    if (redrainRequested || hasNewItems) {
      drainDelegations(bus, approvalBus, threadId, runTarget, onSettled);
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
export function discardDelegations(bus: CommsBus, threadId: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  pendingDelegations.delete(threadId);
  savePending();
  for (const item of list) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
      status: "dropped",
      result: "the delegating turn did not finish",
    });
  }
  const from =
    bus.store.botByThread(threadId) ??
    bus.store.bot(list.find((item) => bus.store.bot(item.sourceBotId))?.sourceBotId ?? list[0]!.sourceBotId);
  if (!from) return;
  bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
  });
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
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
    targetThreadId: string | undefined,
  ) => void | Promise<void>,
): Promise<"settled" | "requeued" | "dispatched"> {
  let sender = from;
  let target = bus.store.bot(item.toBotId);
  // Retained approval authorizes the message, not a deleted conversation or
  // revoked room membership. Check every retry before writing to its source.
  if (!sourceThreadBelongsToBot(bus.store, sender.id, sourceThreadId)) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: target?.name ?? item.toBotId,
      status: "dropped",
      result: "the source conversation no longer belongs to the delegating bot",
    });
    return "settled";
  }
  if (!target) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: item.toBotId,
      status: "error",
      result: "no such bot",
    });
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
    });
    return "settled";
  }
  if (dropIfUnreachable(bus, sender, target, sourceThreadId, item)) {
    return "settled";
  }
  if (dropIfThreadGone(bus, target, sourceThreadId, item)) {
    return "settled";
  }
  const held = holdWhileTargetBusy(bus, target, sourceThreadId, item);
  if (held) return held;
  if (item.waitingOnBusy) {
    delete item.waitingOnBusy;
    savePending();
  }
  if (sender.approvePeerComms && !item.approvalAlreadyGranted) {
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
    );
    if (!pendingDelegations.get(sourceThreadId)?.some((candidate) => candidate.id === item.id)) return "settled";
    // Approval may have waited for minutes. Revalidate before even reporting
    // a denial, which otherwise recreates a deleted source transcript.
    const current = bus.store.bot(item.toBotId);
    const currentSender = bus.store.bot(from.id);
    if (!current || !currentSender || !sourceThreadBelongsToBot(bus.store, currentSender.id, sourceThreadId)) {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: item.toBotId,
        toBotName: target.name,
        status: "dropped",
        result: "the peer or source conversation no longer exists",
      });
      return "settled";
    }
    if (verdict !== "allow") {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: target.id,
        toBotName: target.name,
        status: "denied",
        result: "the user denied this handoff",
      });
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
      });
      return "settled";
    }
    // A busy-target retry must not ask for the very same approval again.
    item.approvalAlreadyGranted = true;
    savePending();
    // Recheck peer access and busy state too: an approval must not start a
    // second turn or mirror an exchange that cannot actually happen.
    if (dropIfUnreachable(bus, currentSender, current, sourceThreadId, item)) {
      return "settled";
    }
    if (dropIfThreadGone(bus, current, sourceThreadId, item)) {
      return "settled";
    }
    const heldAfterApproval = holdWhileTargetBusy(bus, current, sourceThreadId, item);
    if (heldAfterApproval) return heldAfterApproval;
    sender = currentSender;
    target = current;
  }
  // Use the originating group as the channel when both bots are still
  // members; otherwise the exchange falls back to the pair DM.
  const originatingGroup =
    (item.originatingGroupId ? bus.store.group(item.originatingGroupId) : undefined) ??
    (sourceThreadId ? bus.store.groupByThread(sourceThreadId) : undefined);
  const channel = getOrCreateChannel(bus.store, sender, target, originatingGroup);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  // A fresh thread's first line gets the shared peer-provenance note from
  // the harness (which knows whether the opener was unattended); the
  // classic handoff keeps the prefix it has always had.
  const prefixed = item.targetThreadId
    ? item.message
    : `[Delegated by @${sender.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, item.id, sender.id, item.targetThreadId);
  return "dispatched";
}

/** A busy target holds the handoff. What "busy" means depends on where the
 * turn will run: a classic delegation lands in the target's active thread,
 * so it waits for the bot to go idle, with bounded retries so a stuck peer
 * cannot pin the handoff forever. A fresh-thread handoff needs only a free
 * slot, and waits in line for one without a bound — it IS the line, the
 * same one a person's message joins at that limit. Returns null when the
 * target can take the turn now. */
function holdWhileTargetBusy(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): "requeued" | "settled" | null {
  if (item.targetThreadId) {
    if (bus.threadSlotFree ? bus.threadSlotFree(target.id) : !target.busy) return null;
    if (item.waitingOnBusy) return "requeued";
    item.waitingOnBusy = true;
    savePending();
    // one chip per wait, not one per retry: the line moves on every settle
    if (item.attempts === 0) {
      item.attempts = 1;
      const title = bus.store.taskByThread(target.id, item.targetThreadId)?.title ?? "thread";
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Thread #${title} on @${target.name} waiting for a free slot` },
      });
    }
    return "requeued";
  }
  if (!target.busy) return null;
  if (item.waitingOnBusy) return "requeued";
  item.attempts += 1;
  item.waitingOnBusy = true;
  if (item.attempts < MAX_BUSY_ATTEMPTS) {
    savePending();
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} waiting — they're busy (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS} when they finish)` },
    });
    return "requeued";
  }
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "busy_gave_up",
    result: `@${target.name} stayed busy through ${MAX_BUSY_ATTEMPTS} retries`,
  });
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${target.name} canceled — still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
  });
  return "settled";
}

/** The thread a fresh-thread handoff was opened in may be deleted while the
 * handoff waits. There is nowhere for the turn to run then, and running it
 * in the target's active thread would put a bot's job in front of the
 * person unasked. */
function dropIfThreadGone(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): boolean {
  if (!item.targetThreadId || bus.store.taskByThread(target.id, item.targetThreadId)) return false;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "dropped",
    result: `the thread opened on @${target.name} was deleted before it could start`,
  });
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Thread on @${target.name} canceled — it was deleted before it could start`, ok: false },
  });
  return true;
}

/** The source thread may be a bot's own task or a shared group where the
 * bot is a member. This is the same check the API gate uses for group turns. */
function sourceThreadBelongsToBot(store: Store, botId: string, threadId: string): boolean {
  if (store.taskByThread(botId, threadId)) return true;
  const group = store.groupByThread(threadId);
  return Boolean(group && group.memberIds.includes(botId));
}

/** Section membership and the sender's peer allow-list are execution
 * boundaries, not just sidebar styling. A queued handoff may wait through a
 * turn, a busy target, or human approval, so the permission granted when it
 * was queued must be checked again at the final dispatch edge — the user may
 * have moved either bot, or narrowed the sender's peers, in between. */
function dropIfUnreachable(
  bus: CommsBus,
  sender: BotRecord,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): boolean {
  const sectionsDiffer = sectionKey(sender.section) !== sectionKey(target.section);
  if (!sectionsDiffer && peerAllowed(sender, target.id)) return false;
  const reason = sectionsDiffer
    ? "bots now belong to different sections"
    : `@${target.name} is no longer an allowed peer`;
  const result = sectionsDiffer
    ? `@${sender.name} and @${target.name} now belong to different sections`
    : `@${sender.name} is no longer allowed to contact @${target.name}`;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "dropped",
    result,
  });
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${target.name} canceled — ${reason}`, ok: false },
  });
  return true;
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
  queuedRedrains.clear();
  receipts = [];
}

// ── peer wake (delegated reply resumes the source bot) ────────────────
// A successful delegated reply is appended to the source thread, but that
// alone leaves the source idle — the user has to nudge it ("what did the
// bot say?"). The harness wakes the source with a control-plane revival
// prompt so it can fold the result in and answer. The prompt is pure and
// testable; the burst budget below keeps a re-delegating bot from
// ping-ponging forever.

/** The revival prompt the harness feeds a delegating bot when its peer
 * replies. The peer's text is already in the thread; this tells the source
 * to stop idling and answer the user with the outcome. */
export function buildDelegationRevivalPrompt(targetName: string): string {
  return [
    "[A delegated task just completed]",
    `The task you delegated to @${targetName} has finished, and their reply is now in this conversation.`,
    "Pick the work back up: review the reply, then answer the user with the outcome — lead with the concrete result and say what happens next. Do not re-delegate the same task.",
  ].join("\n\n");
}

/** Same wake for a failed delegated turn: the source must tell the user it
 * did not finish and decide the next step, instead of leaving the failure
 * as a silent chip nobody acts on. */
export function buildDelegationFailurePrompt(targetName: string, reason: string): string {
  return [
    "[A delegated task failed]",
    `The task you delegated to @${targetName} did not finish: ${reason}`,
    "Take over: tell the user what failed in plain terms, then decide the next step — retry with a narrower task, do the work yourself, or propose an alternative. Do not re-delegate the exact same task unchanged.",
  ].join("\n\n");
}

export const DELEGATION_WAKE_MAX_PER_WINDOW = 3;
export const DELEGATION_WAKE_WINDOW_MS = 5 * 60 * 1000;

/** Bounded auto-wake budget per source thread. A delegation completion
 * wakes the source; if that source re-delegates and the new completion
 * wakes it again, this cap stops an A→B→A→B ping-pong. The window is
 * short, so a user actively driving the bot outpaces it. */
export class DelegationWakeBudget {
  private readonly entries = new Map<string, { count: number; windowStart: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  tryAcquire(threadId: string): boolean {
    const now = this.now();
    const entry = this.entries.get(threadId);
    if (!entry || now - entry.windowStart >= DELEGATION_WAKE_WINDOW_MS) {
      this.entries.set(threadId, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= DELEGATION_WAKE_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
  }

  /** A genuine user turn clears the debt — the user is driving now. */
  reset(threadId: string): void {
    this.entries.delete(threadId);
  }
}

// ── live status for a running delegated turn ──────────────────────────
// check_delegation used to say only queued/running/finished. A chief that
// coordinates specialists needs to see whether a long-running peer is
// actually progressing, so the harness summarizes what the peer's thread
// has done since the delegated turn started.

export interface DelegatedActivityMessage {
  at: number;
  kind: string;
  text?: string;
  tool?: { name?: string } | null;
}

export function formatDelegationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Recent, bounded activity from the peer's thread since the delegated
 * turn started — newest last. Empty means the peer has produced nothing
 * visible since dispatch, which reads as "maybe stuck" to the caller. */
export function summarizeDelegatedActivity(
  messages: readonly DelegatedActivityMessage[],
  startedAtMs: number,
  limit = 5,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.at < startedAtMs) continue;
    if (message.kind === "activity") {
      const name = (message.tool?.name ?? "").trim();
      if (name) lines.push(`tool: ${name}`);
      continue;
    }
    if (message.kind === "text" && message.text?.trim()) {
      const text = message.text.trim().replace(/\s+/g, " ");
      lines.push(`text: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`);
    }
  }
  return lines.slice(-limit);
}

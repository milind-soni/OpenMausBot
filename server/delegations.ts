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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import {
  cloneRuntimePolicy,
  effectiveTaskRuntimePolicy,
  isBotRuntimePolicy,
  runtimePolicyFingerprint,
  runtimePolicyOverrideFingerprint,
  validateRuntimePolicyPatch,
  type BotRuntimePolicy,
  type RuntimePolicyOverrides,
} from "./bot-runtime-policy.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { sectionKey, type BotRecord, type GroupRecord } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** Optional one-task policy override. It is validated before queueing. */
  runtimePolicyOverride?: RuntimePolicyOverrides;
  /** The user already approved this exact peer message while it was still
   * an ask_bot request. If that peer became busy before dispatch, the
   * fallback handoff must not ask them to approve the same action twice. */
  approvalAlreadyGranted?: boolean;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
}

interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for crash-safe removal from the queue —
   * and the task id the delegating bot uses with check/wait_delegation. */
  id: string;
  /** Busy-target retries so far. The item stays queued (not canceled) while
   * the target is busy, and is retried when any of the target's turns
   * settles — up to MAX_BUSY_ATTEMPTS. */
  attempts: number;
  /** True after this item observed the target's current busy period. Other
   * queue activity must not count that same period again; the target's idle
   * transition clears this marker before the next retry. */
  waitingOnBusy?: boolean;
  evidence?: DelegationEvidence;
  runtimePolicySnapshot?: import("./bot-runtime-policy.ts").BotRuntimePolicy;
}

export interface DelegationEvidence {
  evidenceKey: string;
  runtimePolicyFingerprint: string;
  runtimePolicyOverrideFingerprint?: string;
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
  /** Hash-only evidence for reproducing the admission decision. */
  evidence?: DelegationEvidence;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many" | "invalid_runtime_policy" | "runtime_policy_chief_only";

/** What queueDelegation hands back: the verdict, and on success the task id
 * the delegating bot can later read back with check/wait_delegation. */
export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
  evidence?: DelegationEvidence;
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

/** Hash normalized delegation evidence parts without retaining their raw values. */
function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n\u241f\n"), "utf8").digest("hex");
}

/** Normalize user-controlled evidence text for deterministic hashing. */
function normalized(value: string | undefined): string {
  return (value ?? "").trim().normalize("NFKC").replaceAll("\\", "/").replace(/\s+/gu, " ").toLowerCase();
}

/** Build hash-only evidence for a queued delegation and its policy snapshot. */
function delegationEvidence(
  message: string,
  reason: string | undefined,
  policy: BotRuntimePolicy,
  runtimePolicyOverride: RuntimePolicyOverrides | undefined,
): DelegationEvidence {
  const effectiveFingerprint = runtimePolicyFingerprint(policy);
  const overrideFingerprint = runtimePolicyOverrideFingerprint(runtimePolicyOverride);
  return {
    evidenceKey: digest([
      normalized(message),
      normalized(reason),
      effectiveFingerprint,
      overrideFingerprint ?? "none",
    ]),
    runtimePolicyFingerprint: effectiveFingerprint,
    ...(overrideFingerprint ? { runtimePolicyOverrideFingerprint: overrideFingerprint } : {}),
  };
}

/** Return the optional evidence field for durable queue and receipt records. */
function evidenceFields(item: PendingDelegationItem): { evidence?: DelegationEvidence } {
  return item.evidence ? { evidence: item.evidence } : {};
}

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
  if (receipt.evidence) bounded.evidence = receipt.evidence;
  receipts = [bounded, ...receipts.filter((existing) => existing.id !== bounded.id)]
    .filter((existing) => now - existing.finishedAt <= RECEIPT_MAX_AGE_MS)
    .slice(0, MAX_RECEIPTS);
  saveReceipts();
}

/** Find one bounded terminal delegation receipt by its stable task id. */
export function findDelegationReceipt(id: string): DelegationReceipt | null {
  return receipts.find((receipt) => receipt.id === id) ?? null;
}

/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(id: string): { sourceThreadId: string; toBotId: string; attempts: number; evidence?: DelegationEvidence } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, attempts: item.attempts, ...evidenceFields(item) };
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
 * periods, not unrelated drain requests on the same source thread. */
export function releaseDelegationsWaitingOn(toBotId: string): string[] {
  const threads = threadsWaitingOn(toBotId);
  if (!threads.length) return threads;
  for (const threadId of threads) {
    for (const item of pendingDelegations.get(threadId) ?? []) {
      if (item.toBotId === toBotId) delete item.waitingOnBusy;
    }
  }
  savePending();
  return threads;
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
        let runtimePolicyOverride: RuntimePolicyOverrides | undefined;
        if (item.runtimePolicyOverride !== undefined) {
          try {
            const validated = validateRuntimePolicyPatch(item.runtimePolicyOverride);
            if (!validated || typeof validated !== "object") return [];
            runtimePolicyOverride = validated;
          } catch {
            return [];
          }
        }
        const loaded: PendingDelegationItem = {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          toBotId: item.toBotId,
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          ...(runtimePolicyOverride ? { runtimePolicyOverride } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
        };
        if (item.approvalAlreadyGranted === true) loaded.approvalAlreadyGranted = true;
        if (item.waitingOnBusy === true) loaded.waitingOnBusy = true;
        if (item.evidence && typeof item.evidence === "object" && !Array.isArray(item.evidence)) {
          const evidence = item.evidence as Partial<DelegationEvidence>;
          if (typeof evidence.evidenceKey === "string" && typeof evidence.runtimePolicyFingerprint === "string") {
            loaded.evidence = {
              evidenceKey: evidence.evidenceKey,
              runtimePolicyFingerprint: evidence.runtimePolicyFingerprint,
              ...(typeof evidence.runtimePolicyOverrideFingerprint === "string"
                ? { runtimePolicyOverrideFingerprint: evidence.runtimePolicyOverrideFingerprint }
                : {}),
            };
          }
        }
        if (isBotRuntimePolicy(item.runtimePolicySnapshot)) {
          loaded.runtimePolicySnapshot = cloneRuntimePolicy(item.runtimePolicySnapshot);
        } else {
          // Old queue records have no recoverable effective policy identity;
          // recompute both policy and evidence together at dispatch rather
          // than retaining a fingerprint for a different snapshot.
          delete loaded.evidence;
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
        if (candidate.evidence && typeof candidate.evidence === "object" && !Array.isArray(candidate.evidence)) {
          const evidence = candidate.evidence as Partial<DelegationEvidence>;
          if (typeof evidence.evidenceKey === "string" && typeof evidence.runtimePolicyFingerprint === "string") {
            receipt.evidence = {
              evidenceKey: evidence.evidenceKey,
              runtimePolicyFingerprint: evidence.runtimePolicyFingerprint,
              ...(typeof evidence.runtimePolicyOverrideFingerprint === "string"
                ? { runtimePolicyOverrideFingerprint: evidence.runtimePolicyOverrideFingerprint }
                : {}),
            };
          }
        }
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
  toBotId: string;
  reason?: string;
}> {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => ({
      sourceThreadId,
      toBotId: item.toBotId,
      ...(item.reason ? { reason: item.reason } : {}),
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
  let runtimePolicyOverride: RuntimePolicyOverrides | undefined;
  if (item.runtimePolicyOverride !== undefined) {
    try {
      const validated = validateRuntimePolicyPatch(item.runtimePolicyOverride);
      if (!validated || typeof validated !== "object") return { result: "invalid_runtime_policy" };
      runtimePolicyOverride = validated;
    } catch {
      return { result: "invalid_runtime_policy" };
    }
    if (!from.chiefOfStaff) return { result: "runtime_policy_chief_only" };
  }
  const runtimePolicySnapshot = effectiveTaskRuntimePolicy(target.runtimePolicy, runtimePolicyOverride);
  const evidence = delegationEvidence(item.message, item.reason, runtimePolicySnapshot, runtimePolicyOverride);
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  const id = newId();
  list.push({
    ...item,
    ...(runtimePolicyOverride ? { runtimePolicyOverride } : {}),
    id,
    attempts: 0,
    evidence,
    runtimePolicySnapshot: cloneRuntimePolicy(runtimePolicySnapshot),
  });
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
  });
  return { result: "ok", id, evidence };
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
    evidence: DelegationEvidence,
    runtimePolicySnapshot: BotRuntimePolicy,
    runtimePolicyOverride: RuntimePolicyOverrides | undefined,
  ) => void | Promise<void>,
): void {
  if (drainingThreads.has(threadId)) {
    queuedRedrains.add(threadId);
    return;
  }
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
  void (async () => {
    for (const item of snapshot) {
      let outcome: "settled" | "requeued" = "settled";
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
          ...evidenceFields(item),
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
        if (outcome !== "requeued") acknowledgeDelegation(threadId, item.id);
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
      drainDelegations(bus, approvalBus, threadId, runTarget);
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
      ...evidenceFields(item),
    });
  }
  const from = bus.store.botByThread(threadId);
  if (!from) return;
  bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
  });
}

/** Process one queued delegation through admission, provider execution, and durable receipt settlement. */
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
    evidence: DelegationEvidence,
    runtimePolicySnapshot: BotRuntimePolicy,
    runtimePolicyOverride: RuntimePolicyOverrides | undefined,
  ) => void | Promise<void>,
): Promise<"settled" | "requeued"> {
  let sender = from;
  let target = bus.store.bot(item.toBotId);
  if (!target) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: item.toBotId,
      status: "error",
      result: "no such bot",
      ...evidenceFields(item),
    });
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
    });
    return "settled";
  }
  if (item.runtimePolicyOverride && !sender.chiefOfStaff) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: target.id,
      toBotName: target.name,
      status: "denied",
      result: "only a Chief of Staff may set a runtime policy override",
      ...evidenceFields(item),
    });
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — only a Chief of Staff may set a runtime policy override`, ok: false },
    });
    return "settled";
  }
  if (dropIfSectionsChanged(bus, sender, target, sourceThreadId, item)) {
    return "settled";
  }
  if (target.busy) {
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
      ...evidenceFields(item),
    });
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
    });
    return "settled";
  }
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
    if (verdict !== "allow") {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: target.id,
        toBotName: target.name,
        status: "denied",
        result: "the user denied this handoff",
        ...evidenceFields(item),
      });
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
      });
      return "settled";
    }
    // The approval could have been sitting for up to 15 minutes. Everything
    // checked above is a stale snapshot now: re-read both bots and re-check
    // busy, or an allow can start a second turn on a bot that is mid-turn —
    // and mirror a "Messaged @X" chip for an exchange that never happens.
    const current = bus.store.bot(item.toBotId);
    const currentSender = bus.store.bot(from.id);
    if (!current || !currentSender || !bus.store.taskByThread(currentSender.id, sourceThreadId)) {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: current?.id ?? item.toBotId,
        toBotName: current?.name ?? item.toBotId,
        status: "error",
        result: "the sender or source conversation disappeared while approval was pending",
        ...evidenceFields(item),
      });
      return "settled";
    }
    if (item.runtimePolicyOverride && !currentSender.chiefOfStaff) {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: current.id,
        toBotName: current.name,
        status: "denied",
        result: "only a Chief of Staff may set a runtime policy override",
        ...evidenceFields(item),
      });
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${current.name} canceled — Chief of Staff authority was revoked`, ok: false },
      });
      return "settled";
    }
    if (dropIfSectionsChanged(bus, currentSender, current, sourceThreadId, item)) {
      return "settled";
    }
    if (current.busy) {
      if (item.waitingOnBusy) return "requeued";
      item.attempts += 1;
      item.waitingOnBusy = true;
      if (item.attempts < MAX_BUSY_ATTEMPTS) {
        savePending();
        bus.store.appendMessage(sourceThreadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `Delegation to @${current.name} waiting — they're busy (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS} when they finish)` },
        });
        return "requeued";
      }
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: current.id,
        toBotName: current.name,
        status: "busy_gave_up",
        result: `@${current.name} stayed busy through ${MAX_BUSY_ATTEMPTS} retries`,
        ...evidenceFields(item),
      });
      bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${current.name} canceled — still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
      });
      return "settled";
    }
    sender = currentSender;
    target = current;
  }
  const runtimePolicySnapshot = item.runtimePolicySnapshot
    ? cloneRuntimePolicy(item.runtimePolicySnapshot)
    : effectiveTaskRuntimePolicy(target.runtimePolicy, item.runtimePolicyOverride);
  const evidence = item.evidence ?? delegationEvidence(item.message, item.reason, runtimePolicySnapshot, item.runtimePolicyOverride);
  item.evidence = evidence;
  item.runtimePolicySnapshot = runtimePolicySnapshot;
  savePending();
  bus.store.recordTaskRuntimePolicy(target.id, target.threadId, runtimePolicySnapshot, item.runtimePolicyOverride);
  const channel = getOrCreateChannel(bus.store, sender, target);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${sender.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, item.id, evidence, runtimePolicySnapshot, item.runtimePolicyOverride);
  return "settled";
}

/** Section membership is an execution boundary, not just sidebar styling.
 * A queued handoff may wait through a turn, a busy target, or human approval,
 * so the permission granted when it was queued must be checked again at the
 * final dispatch edge. */
function dropIfSectionsChanged(
  bus: CommsBus,
  sender: BotRecord,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): boolean {
  if (sectionKey(sender.section) === sectionKey(target.section)) return false;
  const result = `@${sender.name} and @${target.name} now belong to different sections`;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "dropped",
    result,
    ...evidenceFields(item),
  });
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${target.name} canceled — bots now belong to different sections`, ok: false },
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

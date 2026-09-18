import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { deleteAcpInstructionReceipt } from "./drivers/acp/instruction-receipts.ts";
import { GROUP_CONTEXT_MESSAGES } from "./room-context.ts";

export type RoomContinuationOwner = {
  groupId: string;
  threadId: string;
  botId: string;
};

export type RoomContinuationSelection = {
  instanceId: string;
  model: string;
};

export type RoomContinuationRecord = {
  version: 1;
  cursors: Record<string, unknown>;
  lastInstanceId?: string;
  selection?: RoomContinuationSelection;
  deliveredThroughMessageId?: string;
  deliveredEligibleMessages: number;
  inFlight?: {
    instanceId: string;
    startedAt: number;
    deliveredThroughMessageId?: string;
  };
};

type StoredRecord = RoomContinuationOwner & RoomContinuationRecord & {
  /** Private generation fencing invalidation races with provider handshakes. */
  generation: number;
  inFlight?: RoomContinuationRecord["inFlight"] & { generation: number };
};

export type RoomTurnPlanReason =
  | "new"
  | "resume"
  | "model-changed"
  | "cursor-missing"
  | "anchor-missing"
  | "window-rotated"
  | "restart-uncertain";

export type RoomTurnPlanMode = "fresh" | "resume" | "recovery" | "rotate";

export type RoomTurnPlan = {
  owner: RoomContinuationOwner;
  instanceId: string;
  selection: RoomContinuationSelection;
  mode: RoomTurnPlanMode;
  reason: RoomTurnPlanReason;
  resumeCursor?: unknown;
  text: string;
  recoveryText?: string;
  deliveredThroughMessageId?: string;
  deliveredEligibleMessages: number;
  roomMessagesSent: number;
  roomMessagesRetained: number;
  /** Private fence carried only between planning and settlement. */
  generation: number;
};

export type RoomTurnPlanInput = {
  owner: RoomContinuationOwner;
  selection: RoomContinuationSelection;
  fullText: string;
  recoveryText?: string;
  eligibleMessageIds: readonly string[];
  deltaFor: (anchor?: string) => {
    text: string;
    anchorFound: boolean;
    eligibleMessages: number;
    sentMessages: number;
  };
};

const CONTINUATION_VERSION = 1 as const;
const CONTINUATIONS_FILE = join(DATA_DIR, "room-continuations.json");
const MAX_ELIGIBLE_MESSAGES = GROUP_CONTEXT_MESSAGES;
const records = new Map<string, StoredRecord>();
const ownerGenerations = new Map<string, number>();
const botGenerations = new Map<string, number>();
// Group-level fencing covers a planned first turn that has not reached
// `markDispatched` yet. Unlike an owner record, there is nothing durable to
// mutate in that window, so the generation has to live separately.
const groupGenerations = new Map<string, number>();
const threadGenerations = new Map<string, number>();
/** Provider mutations fence plans that have not reached markDispatched yet. */
const instanceGenerations = new Map<string, number>();
/**
 * All invalidation scopes draw from one process-wide sequence. Keeping the
 * maps above scoped preserves isolation, while the shared allocator prevents
 * a lower counter in one scope from colliding with a plan fenced by another.
 */
let generationEpoch = 0;

function key(owner: RoomContinuationOwner): string {
  return JSON.stringify([owner.groupId, owner.threadId, owner.botId]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseRecord(value: unknown): StoredRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Partial<StoredRecord>;
  if (entry.version !== CONTINUATION_VERSION ||
      typeof entry.groupId !== "string" || typeof entry.threadId !== "string" || typeof entry.botId !== "string" ||
      !entry.cursors || typeof entry.cursors !== "object" || Array.isArray(entry.cursors) ||
      typeof entry.deliveredEligibleMessages !== "number" || !Number.isSafeInteger(entry.deliveredEligibleMessages) ||
      entry.deliveredEligibleMessages < 0 || entry.deliveredEligibleMessages > MAX_ELIGIBLE_MESSAGES) return undefined;
  const selection = entry.selection;
  if (selection !== undefined && (!selection || typeof selection !== "object" ||
      typeof selection.instanceId !== "string" || typeof selection.model !== "string")) return undefined;
  const inFlight = entry.inFlight;
  if (inFlight !== undefined && (!inFlight || typeof inFlight !== "object" ||
      typeof inFlight.instanceId !== "string" || typeof inFlight.startedAt !== "number" || !Number.isFinite(inFlight.startedAt) ||
      (inFlight.deliveredThroughMessageId !== undefined && typeof inFlight.deliveredThroughMessageId !== "string"))) return undefined;
  const rawGeneration = (entry as { generation?: unknown }).generation;
  const generation = typeof rawGeneration === "number" && Number.isSafeInteger(rawGeneration) && rawGeneration >= 0
    ? rawGeneration
    : 0;
  const rawInFlightGeneration = inFlight ? (inFlight as { generation?: unknown }).generation : undefined;
  const inFlightGeneration = typeof rawInFlightGeneration === "number" && Number.isSafeInteger(rawInFlightGeneration) && rawInFlightGeneration >= 0
    ? rawInFlightGeneration
    : generation;
  return {
    version: CONTINUATION_VERSION,
    groupId: entry.groupId,
    threadId: entry.threadId,
    botId: entry.botId,
    cursors: clone(entry.cursors as Record<string, unknown>),
    ...(typeof entry.lastInstanceId === "string" ? { lastInstanceId: entry.lastInstanceId } : {}),
    ...(selection ? { selection: { instanceId: selection.instanceId, model: selection.model } } : {}),
    ...(typeof entry.deliveredThroughMessageId === "string" ? { deliveredThroughMessageId: entry.deliveredThroughMessageId } : {}),
    deliveredEligibleMessages: entry.deliveredEligibleMessages,
    generation,
    ...(inFlight ? { inFlight: {
      instanceId: inFlight.instanceId,
      startedAt: inFlight.startedAt,
      ...(typeof inFlight.deliveredThroughMessageId === "string" ? { deliveredThroughMessageId: inFlight.deliveredThroughMessageId } : {}),
      generation: inFlightGeneration,
    } } : {}),
  };
}

function load(): void {
  if (!existsSync(CONTINUATIONS_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(CONTINUATIONS_FILE, "utf8")) as { version?: unknown; records?: unknown };
    if (parsed?.version !== CONTINUATION_VERSION || !Array.isArray(parsed.records)) return;
    for (const value of parsed.records) {
      const record = parseRecord(value);
      if (record) {
        records.set(key(record), record);
        generationEpoch = Math.max(generationEpoch, record.generation, record.inFlight?.generation ?? 0);
      }
    }
  } catch {
    // A malformed private file is equivalent to no cursor. The next accepted
    // turn rewrites it atomically; never fail a room because of stale state.
  }
}

function nextGenerationEpoch(): number {
  generationEpoch += 1;
  return generationEpoch;
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    CONTINUATIONS_FILE,
    `${JSON.stringify({ version: CONTINUATION_VERSION, records: [...records.values()] })}\n`,
    { mode: 0o600 },
  );
}

function ownerKey(owner: RoomContinuationOwner): string {
  return key(owner);
}

function threadKey(owner: Pick<RoomContinuationOwner, "groupId" | "threadId">): string {
  return JSON.stringify([owner.groupId, owner.threadId]);
}

function generationFor(owner: RoomContinuationOwner, record?: StoredRecord, instanceId?: string): number {
  return Math.max(
    record?.generation ?? 0,
    ownerGenerations.get(ownerKey(owner)) ?? 0,
    botGenerations.get(owner.botId) ?? 0,
    groupGenerations.get(owner.groupId) ?? 0,
    threadGenerations.get(threadKey(owner)) ?? 0,
    instanceId === undefined ? 0 : instanceGenerations.get(instanceId) ?? 0,
  );
}

function newRecord(owner: RoomContinuationOwner, generation: number): StoredRecord {
  return {
    ...clone(owner),
    version: CONTINUATION_VERSION,
    cursors: {},
    deliveredEligibleMessages: 0,
    generation,
  };
}

function resetForFresh(record: StoredRecord): void {
  // A fresh rebuild cannot use the old native session's instruction receipt.
  // Remove it before dropping the cursor, otherwise rotation/anchor recovery
  // leaves an orphaned receipt that can never be reached by cleanup.
  deleteReceipts(record);
  record.cursors = {};
  record.lastInstanceId = undefined;
  record.selection = undefined;
  record.deliveredThroughMessageId = undefined;
  record.deliveredEligibleMessages = 0;
}

function makePlan(
  input: RoomTurnPlanInput,
  mode: RoomTurnPlanMode,
  reason: RoomTurnPlanReason,
  text: string,
  resumeCursor: unknown,
  deliveredThroughMessageId: string | undefined,
  deliveredEligibleMessages: number,
  roomMessagesSent: number,
  roomMessagesRetained: number,
  generation: number,
): RoomTurnPlan {
  return {
    owner: clone(input.owner),
    instanceId: input.selection.instanceId,
    selection: clone(input.selection),
    mode,
    reason,
    ...(resumeCursor !== undefined ? { resumeCursor: clone(resumeCursor) } : {}),
    text,
    ...(resumeCursor !== undefined && input.recoveryText !== undefined ? { recoveryText: input.recoveryText } : {}),
    ...(deliveredThroughMessageId ? { deliveredThroughMessageId } : {}),
    deliveredEligibleMessages,
    roomMessagesSent,
    roomMessagesRetained,
    generation,
  };
}

/** Choose fresh, resume, rebuild, or rotation without exposing the private
 * file format to callers. Planning may invalidate stale state, but it never
 * commits a new cursor or delivery anchor before dispatch settles. */
export function planRoomTurn(input: RoomTurnPlanInput): RoomTurnPlan {
  const existing = records.get(key(input.owner));
  const generation = generationFor(input.owner, existing, input.selection.instanceId);
  const selected = input.selection;
  const lastId = input.eligibleMessageIds.at(-1);
  if (!existing) {
    return makePlan(input, "fresh", "new", input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }

  if (existing.inFlight) {
    resetForFresh(existing);
    existing.inFlight = undefined;
    persist();
    return makePlan(input, "rotate", "restart-uncertain", input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }

  const instanceChanged = existing.lastInstanceId !== undefined && existing.lastInstanceId !== selected.instanceId;
  const modelChanged = existing.selection !== undefined &&
    (existing.selection.instanceId !== selected.instanceId || existing.selection.model !== selected.model);
  if (instanceChanged || modelChanged) {
    resetForFresh(existing);
    persist();
    return makePlan(input, "fresh", "model-changed", input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }

  const resumeCursor = existing.cursors[selected.instanceId];
  if (resumeCursor === undefined) {
    const reason: RoomTurnPlanReason = existing.lastInstanceId || existing.selection ? "cursor-missing" : "new";
    return makePlan(input, "fresh", reason, input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }
  const anchor = existing.deliveredThroughMessageId;
  if (!anchor) {
    resetForFresh(existing);
    persist();
    return makePlan(input, "fresh", "anchor-missing", input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }
  const delta = input.deltaFor(anchor);
  if (!delta.anchorFound) {
    resetForFresh(existing);
    persist();
    return makePlan(input, "fresh", "anchor-missing", input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }
  const nextCount = existing.deliveredEligibleMessages + delta.eligibleMessages;
  if (nextCount > MAX_ELIGIBLE_MESSAGES) {
    resetForFresh(existing);
    persist();
    return makePlan(input, "rotate", "window-rotated", input.fullText, undefined, lastId, input.eligibleMessageIds.length, input.eligibleMessageIds.length, 0, generation);
  }
  return makePlan(
    input,
    "resume",
    "resume",
    delta.text,
    resumeCursor,
    lastId,
    nextCount,
    delta.sentMessages,
    existing.deliveredEligibleMessages,
    generation,
  );
}

/** Mark the exact plan as ambiguous before the provider handshake starts. A
 * restart can then rotate instead of replaying a potentially accepted turn.
 * A false result means an authority/model invalidation won the race before
 * dispatch; the caller must not send the stale turn. */
export function markDispatched(plan: RoomTurnPlan): boolean {
  const ownerKey = key(plan.owner);
  const current = records.get(ownerKey);
  if (generationFor(plan.owner, current, plan.instanceId) !== plan.generation) return false;
  const next = current ?? newRecord(plan.owner, plan.generation);
  next.generation = plan.generation;
  next.lastInstanceId = plan.instanceId;
  next.selection = clone(plan.selection);
  next.inFlight = {
    instanceId: plan.instanceId,
    startedAt: Date.now(),
    ...(next.deliveredThroughMessageId ? { deliveredThroughMessageId: next.deliveredThroughMessageId } : {}),
    generation: plan.generation,
  };
  records.set(ownerKey, next);
  persist();
  return true;
}

/** Bind a provider-native session only after the runtime announces it. A
 * stale event arriving after invalidation is ignored by the generation fence. */
export function recordSession(
  owner: RoomContinuationOwner,
  instanceId: string,
  cursor: unknown,
  plan?: RoomTurnPlan,
): void {
  const current = records.get(key(owner));
  if (!current || !current.inFlight || current.inFlight.instanceId !== instanceId) return;
  const expectedGeneration = plan?.generation ?? current.inFlight.generation;
  if (generationFor(owner, current, instanceId) !== expectedGeneration || current.inFlight.generation !== expectedGeneration) return;
  current.cursors[instanceId] = clone(cursor);
  current.lastInstanceId = instanceId;
  records.set(key(owner), current);
  persist();
}

/** Commit the delivery anchor only after the protocol turn has settled. A
 * failure clears the old cursor so it cannot cause a replay on the next turn. */
export function settle(plan: RoomTurnPlan, outcome: string): void {
  const current = records.get(key(plan.owner));
  if (!current || generationFor(plan.owner, current, plan.instanceId) !== plan.generation) return;
  // Some callers can settle a provider failure after a dispatch promise was
  // rejected before the in-flight marker was observed. It is still safe to
  // clear that plan's cursor while the generation matches; a successful
  // settlement without a marker is never allowed to commit an anchor.
  if (!current.inFlight) {
    if (outcome === "settled") return;
    deleteReceipts(current);
    current.cursors = {};
    current.deliveredThroughMessageId = undefined;
    current.deliveredEligibleMessages = 0;
    persist();
    return;
  }
  if (current.inFlight.generation !== plan.generation) return;
  current.inFlight = undefined;
  if (outcome === "settled") {
    current.lastInstanceId = plan.instanceId;
    current.selection = clone(plan.selection);
    current.deliveredThroughMessageId = plan.deliveredThroughMessageId;
    current.deliveredEligibleMessages = Math.max(0, Math.min(MAX_ELIGIBLE_MESSAGES, plan.deliveredEligibleMessages));
  } else {
    // Keep the selection identity so the next plan is an explicit
    // cursor-missing recovery, not an indistinguishable first-ever turn.
    deleteReceipts(current);
    current.cursors = {};
    current.deliveredThroughMessageId = undefined;
    current.deliveredEligibleMessages = 0;
  }
  records.set(key(plan.owner), current);
  persist();
}

/** Invalidate a private owner. The in-flight marker is dropped and the
 * generation advances, so a provider event from the old setup cannot bind a
 * cursor or commit an anchor after access/model policy changed. */
export function invalidateOwner(owner: RoomContinuationOwner, _reason: RoomTurnPlanReason | string): void {
  const current = records.get(key(owner));
  const generation = nextGenerationEpoch();
  ownerGenerations.set(ownerKey(owner), generation);
  if (!current) return;
  deleteReceipts(current);
  current.cursors = {};
  current.deliveredThroughMessageId = undefined;
  current.deliveredEligibleMessages = 0;
  current.inFlight = undefined;
  current.generation = generation;
  records.set(key(owner), current);
  persist();
}

/** Model/profile changes invalidate every room owner for the bot. */
export function invalidateBot(botId: string): void {
  const generation = nextGenerationEpoch();
  botGenerations.set(botId, generation);
  let changed = false;
  for (const record of records.values()) {
    if (record.botId !== botId) continue;
    // Keep the prior selection identity so the next plan can report a
    // model/instance change instead of collapsing the invalidation into a
    // generic first-ever turn. The stale instance is not counted as an
    // active provider consumer; only cursors and in-flight work are.
    deleteReceipts(record);
    record.cursors = {};
    record.deliveredThroughMessageId = undefined;
    record.deliveredEligibleMessages = 0;
    record.inFlight = undefined;
    record.generation = generation;
    changed = true;
  }
  if (changed) persist();
}

/** Membership and section changes alter who may read and write a room
 * transcript. Clear every private owner in that room before the next turn so
 * a native session cannot resume with the old access context. */
export function invalidateGroup(groupId: string): void {
  const groupGeneration = nextGenerationEpoch();
  groupGenerations.set(groupId, groupGeneration);
  let changed = false;
  for (const record of records.values()) {
    if (record.groupId !== groupId) continue;
    deleteReceipts(record);
    record.cursors = {};
    record.deliveredThroughMessageId = undefined;
    record.deliveredEligibleMessages = 0;
    record.inFlight = undefined;
    record.generation = groupGeneration;
    records.set(key(record), record);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Invalidate room sessions for one provider instance after a successful
 * configuration or account mutation. Dormant cursors and their private ACP
 * instruction receipts are removed; an in-flight mutation is blocked by the
 * provider guard, while this generation fence handles a plan racing that
 * guard before it reaches markDispatched.
 */
export function invalidateInstance(instanceId: string): void {
  const nextInstanceGeneration = nextGenerationEpoch();
  instanceGenerations.set(instanceId, nextInstanceGeneration);
  let changed = false;
  for (const record of records.values()) {
    const ownsInstance = record.inFlight?.instanceId === instanceId
      || (record.inFlight === undefined && (record.lastInstanceId === instanceId
        || record.selection?.instanceId === instanceId));
    const hasCursor = Object.hasOwn(record.cursors, instanceId);
    if (!ownsInstance && !hasCursor) continue;
    if (ownsInstance) {
      // Preserve the selection identity so the next plan reports
      // cursor-missing, but make it impossible to resume the mutated session.
      deleteReceipts(record);
      record.cursors = {};
      record.deliveredThroughMessageId = undefined;
      record.deliveredEligibleMessages = 0;
      record.inFlight = undefined;
      record.generation = nextInstanceGeneration;
    } else {
      deleteReceipts(record, instanceId);
      delete record.cursors[instanceId];
      record.generation = nextInstanceGeneration;
    }
    records.set(key(record), record);
    changed = true;
  }
  if (changed) persist();
}

/** Drop a rejected native cursor without invalidating the dispatch generation.
 * ACP/other drivers use this when they announce a replacement session after a
 * before-accept load failure. */
export function clearCursor(owner: RoomContinuationOwner, instanceId: string, cursor?: unknown): void {
  const current = records.get(key(owner));
  if (!current) return;
  const previous = current.cursors[instanceId];
  if (cursor !== undefined && previous !== undefined && !isDeepStrictEqual(previous, cursor)) return;
  if (typeof previous === "string") deleteAcpInstructionReceipt(instanceId, owner.botId, owner.threadId, previous);
  delete current.cursors[instanceId];
  records.set(key(owner), current);
  persist();
}

function deleteReceipts(record: StoredRecord, onlyInstanceId?: string): void {
  for (const [instanceId, cursor] of Object.entries(record.cursors)) {
    if (onlyInstanceId !== undefined && instanceId !== onlyInstanceId) continue;
    if (typeof cursor === "string") {
      deleteAcpInstructionReceipt(instanceId, record.botId, record.threadId, cursor);
    }
  }
}

export function deleteThread(groupId: string, threadId: string): void {
  const threadGenerationKey = JSON.stringify([groupId, threadId]);
  threadGenerations.set(threadGenerationKey, nextGenerationEpoch());
  let changed = false;
  for (const [recordKey, record] of records) {
    if (record.groupId !== groupId || record.threadId !== threadId) continue;
    deleteReceipts(record);
    records.delete(recordKey);
    changed = true;
  }
  if (changed) persist();
}

export function deleteBot(botId: string): void {
  botGenerations.set(botId, nextGenerationEpoch());
  let changed = false;
  for (const [recordKey, record] of records) {
    if (record.botId !== botId) continue;
    deleteReceipts(record);
    records.delete(recordKey);
    changed = true;
  }
  if (changed) persist();
}

/** Provider account guards use private room records as active consumers. */
export function usesInstance(instanceId: string): boolean {
  // Rollback leaves private cursor files on disk by design. They are not an
  // active provider consumer while continuity is disabled, and settled
  // cursors must not block account maintenance forever while waiting for a
  // future room turn. Only an in-flight handshake is busy.
  if (process.env.OMB_ROOM_SESSION_CONTINUITY !== "1") return false;
  return [...records.values()].some((record) => record.inFlight?.instanceId === instanceId);
}

load();

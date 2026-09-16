import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = join(DATA_DIR, "box-delete-requests.json");
const LOCK_FILE = join(DATA_DIR, "box-delete-requests.lock");
const MAX_RECORDS = 4_096;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const MAX_REAPER_GENERATIONS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const PROVIDER_STATUSES = new Set(["pending", "processing", "blocked", "completed"]);

export type BoxDeletionPhase = "prepared" | "accepted" | "blocked";
export type BoxDeletionStatus = "pending" | "processing" | "blocked" | "completed";

export interface BoxDeletionRecord {
  boxId: string;
  name: string;
  ownerBotId: string | null;
  phase: BoxDeletionPhase;
  operationId?: string;
  status?: BoxDeletionStatus;
  requestedAt: number;
  updatedAt: number;
}

export interface BoxDeletionIdentity {
  boxId: string;
  name: string;
  ownerBotId: string | null;
}

export interface BoxDeletionOperationReceipt {
  id: string;
  kind: "box";
  targetId: string;
  status: BoxDeletionStatus;
}

interface JournalFile {
  version: 1;
  records: BoxDeletionRecord[];
}

interface JournalLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

interface JournalReaperOwner extends JournalLockOwner {
  targetToken: string;
}

interface LegacyJournalReaperOwner {
  legacy: true;
  pid: number;
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 100
    && !/[\r\n\0]/.test(value);
}

function isRecord(value: unknown): value is BoxDeletionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.boxId !== "string"
    || !BOX_ID.test(record.boxId)
    || !validName(record.name)
    || !(record.ownerBotId === null || (typeof record.ownerBotId === "string" && BOT_ID.test(record.ownerBotId)))
    || !(["prepared", "accepted", "blocked"] as unknown[]).includes(record.phase)
    || !validTimestamp(record.requestedAt)
    || !validTimestamp(record.updatedAt)
    || record.updatedAt < record.requestedAt
    || !(record.operationId === undefined || (typeof record.operationId === "string" && OPERATION_ID.test(record.operationId)))
    || !(record.status === undefined || (typeof record.status === "string" && PROVIDER_STATUSES.has(record.status)))
  ) return false;

  if (record.phase === "prepared") return record.operationId === undefined && record.status === undefined;
  if (record.phase === "accepted") {
    return typeof record.operationId === "string"
      && (record.status === "pending" || record.status === "processing" || record.status === "completed");
  }
  return record.status === "blocked";
}

function stateError(detail: string, cause?: unknown): Error & { status: number } {
  return Object.assign(
    new Error(
      `Cloud computer deletion is paused because its recovery state is ${detail}. `
      + "Check the Box provider before repairing OpenMausBot's local state.",
    ),
    { status: 503, cause },
  );
}

function clone(record: BoxDeletionRecord): BoxDeletionRecord {
  return { ...record };
}

function nextUpdatedAt(record: BoxDeletionRecord): number {
  return Math.max(Date.now(), record.updatedAt);
}

function loadFresh(): BoxDeletionRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw stateError("unreadable", error);
  }

  const journal = raw as Partial<JournalFile>;
  if (
    !journal
    || typeof journal !== "object"
    || Array.isArray(journal)
    || journal.version !== 1
    || !Array.isArray(journal.records)
    || journal.records.length > MAX_RECORDS
    || !journal.records.every(isRecord)
  ) throw stateError("invalid");

  const boxIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const record of journal.records) {
    if (boxIds.has(record.boxId)) throw stateError("invalid");
    boxIds.add(record.boxId);
    if (record.operationId) {
      if (operationIds.has(record.operationId)) throw stateError("invalid");
      operationIds.add(record.operationId);
    }
  }
  return journal.records.map(clone);
}

function save(records: BoxDeletionRecord[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(FILE, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw stateError("unavailable", error);
  }
}

function isLockOwner(value: unknown): value is JournalLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && Number.isInteger(owner.pid)
    && Number(owner.pid) > 0
    && Number(owner.pid) <= 0x7fffffff
    && typeof owner.token === "string"
    && UUID.test(owner.token)
    && validTimestamp(owner.createdAt);
}

function readLockOwner(): JournalLockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(LOCK_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw stateError("lock is unreadable", error);
  }
  try {
    const owner: unknown = JSON.parse(raw);
    if (!isLockOwner(owner)) throw stateError("lock is invalid");
    return owner;
  } catch (error) {
    if ((error as Error & { status?: number }).status === 503) throw error;
    throw stateError("lock is invalid", error);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw stateError("lock owner could not be verified", error);
  }
}

function unlinkCandidate(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw stateError("lock cleanup failed", error);
    }
  }
}

function readReaperOwner(
  path: string,
  targetToken: string,
): JournalReaperOwner | LegacyJournalReaperOwner | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw stateError("stale-lock recovery record is unreadable", error);
  }
  if (/^[1-9][0-9]*\n?$/.test(raw)) {
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid <= 0x7fffffff) return { legacy: true, pid };
  }
  try {
    const owner: unknown = JSON.parse(raw);
    if (!isLockOwner(owner) || !("targetToken" in owner) || owner.targetToken !== targetToken) {
      throw stateError("stale-lock recovery record is invalid");
    }
    return owner as JournalReaperOwner;
  } catch (error) {
    if ((error as Error & { status?: number }).status === 503) throw error;
    throw stateError("stale-lock recovery record is invalid", error);
  }
}

function publishReaper(path: string, owner: JournalReaperOwner): boolean {
  const candidate = `${path}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw stateError("stale-lock recovery candidate is unavailable", error);
  }
  try {
    try {
      linkSync(candidate, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw stateError("stale-lock recovery is unavailable", error);
    }
  } finally {
    unlinkCandidate(candidate);
  }
}

function successorReaperPath(targetToken: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${LOCK_FILE}.reap-${targetToken}-${digest}`;
}

function claimReaperAuthority(expected: JournalLockOwner): boolean {
  let reaperPath = `${LOCK_FILE}.reap-${expected.token}`;
  for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation += 1) {
    const candidate: JournalReaperOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
      targetToken: expected.token,
    };
    if (publishReaper(reaperPath, candidate)) return true;
    const current = readReaperOwner(reaperPath, expected.token);
    if (!current) continue;
    if (processIsAlive(current.pid)) return false;
    const identity = "legacy" in current ? `legacy:${current.pid}` : current.token;
    reaperPath = successorReaperPath(expected.token, identity);
  }
  throw stateError("stale lock could not be recovered after repeated interrupted attempts");
}

function reapDeadLock(expected: JournalLockOwner): boolean {
  if (!claimReaperAuthority(expected)) return false;
  const current = readLockOwner();
  if (!current || current.token !== expected.token) return true;
  if (processIsAlive(current.pid)) return false;
  try {
    unlinkSync(LOCK_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw stateError("stale lock could not be retired", error);
    }
  }
  return true;
}

function acquireJournalLock(): JournalLockOwner {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw stateError("lock directory is unavailable", error);
  }
  const owner: JournalLockOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  const candidate = `${LOCK_FILE}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw stateError("lock candidate is unavailable", error);
  }

  const deadline = performance.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(candidate, LOCK_FILE);
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw stateError("lock could not be acquired", error);
        }
      }
      const current = readLockOwner();
      const reaped = current !== null && !processIsAlive(current.pid) && reapDeadLock(current);
      if (performance.now() >= deadline) throw stateError("locked by another OpenMausBot process");
      if (reaped) continue;
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
    }
  } finally {
    unlinkCandidate(candidate);
  }
}

function releaseJournalLock(owner: JournalLockOwner): void {
  const current = readLockOwner();
  if (!current || current.token !== owner.token || current.pid !== owner.pid) {
    throw stateError("lock ownership changed unexpectedly");
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch (error) {
    throw stateError("lock could not be released", error);
  }
}

function withJournalLock<T>(operation: (records: BoxDeletionRecord[]) => T): T {
  const owner = acquireJournalLock();
  try {
    return operation(loadFresh());
  } finally {
    releaseJournalLock(owner);
  }
}

function validateIdentity(identity: BoxDeletionIdentity): void {
  if (!BOX_ID.test(identity.boxId)) throw new Error("invalid cloud computer id for deletion");
  if (!validName(identity.name)) throw new Error("invalid cloud computer name for deletion");
  if (!(identity.ownerBotId === null || BOT_ID.test(identity.ownerBotId))) {
    throw new Error("invalid cloud computer owner for deletion");
  }
}

function parseOperation(
  boxId: string,
  value: unknown,
  expectedStatus?: BoxDeletionStatus,
): BoxDeletionOperationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid cloud computer deletion operation");
  }
  const operation = value as Record<string, unknown>;
  if (
    typeof operation.id !== "string"
    || !OPERATION_ID.test(operation.id)
    || operation.kind !== "box"
    || operation.targetId !== boxId
    || typeof operation.status !== "string"
    || !PROVIDER_STATUSES.has(operation.status)
    || (expectedStatus !== undefined && operation.status !== expectedStatus)
  ) throw new Error("invalid or mismatched cloud computer deletion operation");
  return operation as unknown as BoxDeletionOperationReceipt;
}

/** Write the immutable target before sending DELETE to the provider. Existing
 * in-flight work wins; a blocked operation may be explicitly retried. */
export function prepareBoxDeletion(identity: BoxDeletionIdentity): BoxDeletionRecord {
  validateIdentity(identity);
  return withJournalLock((records) => {
    const existing = records.find((record) => record.boxId === identity.boxId);
    if (existing) {
      if (existing.name !== identity.name || existing.ownerBotId !== identity.ownerBotId) {
        throw stateError("conflicted with the remembered deletion target");
      }
      if (existing.phase !== "blocked") return clone(existing);
    }
    if (!existing && records.length >= MAX_RECORDS) throw stateError("full");
    const now = Date.now();
    const prepared: BoxDeletionRecord = {
      ...identity,
      phase: "prepared",
      requestedAt: now,
      updatedAt: now,
    };
    save([...records.filter((record) => record.boxId !== identity.boxId), prepared]);
    return clone(prepared);
  });
}

/** Bind a provider receipt to the exact immutable Box target. A caller cannot
 * accidentally attach another Box's operation to this deletion fence. */
export function markBoxDeletionAccepted(boxId: string, value: unknown): BoxDeletionRecord {
  if (!BOX_ID.test(boxId)) throw new Error("invalid cloud computer id for deletion");
  const operation = parseOperation(boxId, value);
  if (operation.status === "blocked") {
    throw new Error("blocked cloud computer deletion must use markBoxDeletionBlocked");
  }
  const acceptedStatus = operation.status;
  return withJournalLock((records) => {
    const existing = records.find((record) => record.boxId === boxId);
    if (!existing || existing.phase === "blocked") throw stateError("out of date");
    if (existing.operationId && existing.operationId !== operation.id) {
      throw stateError("conflicted with another deletion operation");
    }
    if (records.some((record) => record.boxId !== boxId && record.operationId === operation.id)) {
      throw stateError("conflicted with another deletion operation");
    }
    const ranks: Record<Exclude<BoxDeletionStatus, "blocked">, number> = {
      pending: 0,
      processing: 1,
      completed: 2,
    };
    if (
      existing.phase === "accepted"
      && existing.status !== undefined
      && existing.status !== "blocked"
      && ranks[acceptedStatus] < ranks[existing.status]
    ) return clone(existing);
    const accepted: BoxDeletionRecord = {
      ...existing,
      phase: "accepted",
      operationId: operation.id,
      status: acceptedStatus,
      updatedAt: nextUpdatedAt(existing),
    };
    save(records.map((record) => record.boxId === boxId ? accepted : record));
    return clone(accepted);
  });
}

/** Record an explicit provider block without discarding the target. The
 * target remains fenced from normal use; only a deliberate deletion retry
 * may prepare the same immutable target again. */
export function markBoxDeletionBlocked(boxId: string, value?: unknown): BoxDeletionRecord {
  if (!BOX_ID.test(boxId)) throw new Error("invalid cloud computer id for deletion");
  const operation = value === undefined ? null : parseOperation(boxId, value, "blocked");
  return withJournalLock((records) => {
    const existing = records.find((record) => record.boxId === boxId);
    if (!existing) throw stateError("out of date");
    if (operation && existing.operationId && existing.operationId !== operation.id) {
      throw stateError("conflicted with another deletion operation");
    }
    if (
      operation
      && records.some((record) => record.boxId !== boxId && record.operationId === operation.id)
    ) throw stateError("conflicted with another deletion operation");
    const blocked: BoxDeletionRecord = {
      ...existing,
      phase: "blocked",
      ...(operation?.id || existing.operationId ? { operationId: operation?.id ?? existing.operationId } : {}),
      status: "blocked",
      updatedAt: nextUpdatedAt(existing),
    };
    save(records.map((record) => record.boxId === boxId ? blocked : record));
    return clone(blocked);
  });
}

/** A fresh, lock-protected copy suitable for server reconciliation. */
export function boxDeletionSnapshot(): BoxDeletionRecord[] {
  return withJournalLock((records) => records.map(clone));
}

export const listBoxDeletions = boxDeletionSnapshot;

export function getBoxDeletion(boxId: string): BoxDeletionRecord | null {
  if (!BOX_ID.test(boxId)) throw new Error("invalid cloud computer id for deletion");
  return withJournalLock((records) => {
    const record = records.find((candidate) => candidate.boxId === boxId);
    return record ? clone(record) : null;
  });
}

export function isBoxDeletionPending(boxId: string): boolean {
  return getBoxDeletion(boxId) !== null;
}

export function hasPendingBoxDeletionForBot(botId: string): boolean {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer deletion");
  return withJournalLock((records) => records.some((record) => record.ownerBotId === botId));
}

/** Remove a record only after direct absence or a completed target-bound
 * provider operation proves the immutable Box identity is gone. */
export function retireBoxDeletion(boxId: string): void {
  if (!BOX_ID.test(boxId)) throw new Error("invalid deleted cloud computer id");
  withJournalLock((records) => {
    const next = records.filter((record) => record.boxId !== boxId);
    if (next.length !== records.length) save(next);
  });
}

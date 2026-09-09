import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = join(DATA_DIR, "box-create-requests.json");
const LOCK_FILE = join(DATA_DIR, "box-create-requests.lock");
const KEY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_REQUESTS = 4_096;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const MAX_REAPER_GENERATIONS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export interface BoxCreateRequest {
  botId: string;
  requestBody: string;
  idempotencyKey: string;
  createdAt: number;
  boxId?: string;
  /** The provider Box has its deterministic OpenMaus name. Until this is
   * true, deleting the bot would make an ambiguous or unnamed Box orphaned. */
  resolved?: true;
}

export interface BoxCreateAttempt {
  request: BoxCreateRequest;
  /** True only when this call wrote a brand-new provider key. This is
   * deliberately process-local provenance: a resumed key may resolve a Box
   * created by an earlier app run and must never authorize automatic cleanup. */
  startedNow: boolean;
}

export interface BoxCreateRecoverySnapshot {
  botId: string;
  boxId?: string;
  resolved: boolean;
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

function isRequest(value: unknown): value is BoxCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.botId === "string"
    && BOT_ID.test(request.botId)
    && typeof request.requestBody === "string"
    && request.requestBody.length > 0
    && request.requestBody.length <= 1_024
    && typeof request.idempotencyKey === "string"
    && UUID.test(request.idempotencyKey)
    && typeof request.createdAt === "number"
    && Number.isFinite(request.createdAt)
    && request.createdAt > 0
    && (request.boxId === undefined || (typeof request.boxId === "string" && BOX_ID.test(request.boxId)))
    && (request.resolved === undefined || (request.resolved === true && typeof request.boxId === "string"))
  );
}

function recoveryStateError(detail: string, cause?: unknown): Error & { status: number } {
  return Object.assign(
    new Error(
      `Cloud computer creation is paused because its recovery state is ${detail}. `
      + "Check ascii.dev for an unnamed Box before repairing OpenMausBot's local state.",
    ),
    { status: 503, cause },
  );
}

function loadFresh(): BoxCreateRequest[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw recoveryStateError("unreadable", error);
  }
  const file = raw as { version?: unknown; requests?: unknown };
  if (
    !file
    || typeof file !== "object"
    || Array.isArray(file)
    || file.version !== 1
    || !Array.isArray(file.requests)
    || file.requests.length > MAX_REQUESTS
    || !file.requests.every(isRequest)
  ) {
    throw recoveryStateError("invalid");
  }
  const identities = new Set<string>();
  const keys = new Set<string>();
  const botsWithKnownBoxes = new Set<string>();
  for (const request of file.requests) {
    const identity = `${request.botId}\0${request.requestBody}`;
    if (identities.has(identity) || keys.has(request.idempotencyKey)) throw recoveryStateError("invalid");
    if (request.boxId && botsWithKnownBoxes.has(request.botId)) throw recoveryStateError("invalid");
    identities.add(identity);
    keys.add(request.idempotencyKey);
    if (request.boxId) botsWithKnownBoxes.add(request.botId);
  }
  return file.requests.map((request) => ({ ...request }));
}

function save(next: BoxCreateRequest[]): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    writeFileAtomic(FILE, `${JSON.stringify({ version: 1, requests: next }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw recoveryStateError("unavailable", error);
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
    && typeof owner.createdAt === "number"
    && Number.isFinite(owner.createdAt)
    && owner.createdAt > 0;
}

function readLockOwner(): JournalLockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(LOCK_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw recoveryStateError("lock is unreadable", error);
  }
  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    throw recoveryStateError("lock is invalid", error);
  }
  if (!isLockOwner(owner)) throw recoveryStateError("lock is invalid");
  return owner;
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
    throw recoveryStateError("stale-lock recovery record is unreadable", error);
  }

  // Versions before the successor chain wrote only the elected reaper's PID.
  // Treat that immutable record as generation zero so an interrupted upgrade
  // remains recoverable without deleting another contender's authority.
  if (/^[1-9][0-9]*\n?$/.test(raw)) {
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid <= 0x7fffffff) return { legacy: true, pid };
  }

  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    throw recoveryStateError("stale-lock recovery record is invalid", error);
  }
  if (!isLockOwner(owner) || !("targetToken" in owner) || owner.targetToken !== targetToken) {
    throw recoveryStateError("stale-lock recovery record is invalid");
  }
  return owner as JournalReaperOwner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    // EPERM proves a process owns the pid even though this account cannot
    // signal it. Every other answer is ambiguous and must keep the lock.
    if (code === "EPERM") return true;
    throw recoveryStateError("lock owner could not be verified", error);
  }
}

function unlinkCandidate(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw recoveryStateError("lock cleanup failed", error);
    }
  }
}

function publishReaper(path: string, owner: JournalReaperOwner): boolean {
  const candidate = `${path}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw recoveryStateError("stale-lock recovery candidate is unavailable", error);
  }
  try {
    try {
      linkSync(candidate, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw recoveryStateError("stale-lock recovery is unavailable", error);
    }
  } finally {
    unlinkCandidate(candidate);
  }
}

function successorReaperPath(targetToken: string, reaperIdentity: string): string {
  const digest = createHash("sha256").update(reaperIdentity).digest("hex").slice(0, 32);
  return `${LOCK_FILE}.reap-${targetToken}-${digest}`;
}

/** Elect exactly one live process to retire this immutable lock owner. A
 * reaper can itself crash, so each dead reaper deterministically names the
 * next election. Election records are never removed: no contender can delete
 * a successor's authority between checking it and publishing its own. */
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
  throw recoveryStateError("stale lock could not be recovered after repeated interrupted attempts");
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
      throw recoveryStateError("stale lock could not be retired", error);
    }
  }
  return true;
}

function acquireJournalLock(): JournalLockOwner {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw recoveryStateError("lock directory is unavailable", error);
  }
  const owner: JournalLockOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  // The fully-written candidate exists before link(2) publishes it at the
  // fixed lock path. Unlike open-then-write, contenders can never observe an
  // ownerless lock after a crash between those two operations.
  const candidate = `${LOCK_FILE}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw recoveryStateError("lock candidate is unavailable", error);
  }

  const deadline = performance.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(candidate, LOCK_FILE);
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw recoveryStateError("lock could not be acquired", error);
        }
      }

      const current = readLockOwner();
      const reaped = current !== null && !processIsAlive(current.pid) && reapDeadLock(current);
      // Every retry path is bounded. In particular, an adversarially changing
      // lock can disappear between link(EEXIST) and read, or replace each
      // successfully reaped owner before the next link attempt.
      if (performance.now() >= deadline) {
        throw recoveryStateError("locked by another OpenMausBot process");
      }
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
    throw recoveryStateError("lock ownership changed unexpectedly");
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch (error) {
    throw recoveryStateError("lock could not be released", error);
  }
}

function withJournalLock<T>(operation: (requests: BoxCreateRequest[]) => T): T {
  const owner = acquireJournalLock();
  try {
    return operation(loadFresh());
  } finally {
    releaseJournalLock(owner);
  }
}

/** Record the exact provider request before it leaves the process. A known
 * Box wins over a changed body: once a provider resource exists, recovering
 * and naming it is safer than issuing any second create request. */
export function beginBoxCreate(botId: string, requestBody: string): BoxCreateAttempt {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer creation");
  if (!requestBody || requestBody.length > 1_024) throw new Error("invalid cloud computer create request");
  return withJournalLock((requests) => {
    const known = requests.find((request) => request.botId === botId && request.boxId);
    if (known) return { request: { ...known }, startedNow: false };

    const now = Date.now();
    const pending = requests.find((request) => request.botId === botId);
    if (pending) {
      if (pending.requestBody !== requestBody) {
        throw recoveryStateError("waiting for an earlier cloud computer request to be reconciled");
      }
      if (now - pending.createdAt >= KEY_RETENTION_MS) {
        // Once the provider forgets the idempotency key, retrying it (or using
        // a new key) may create a second billable Box. Absence cannot be
        // inferred from a lost response, so stop for manual reconciliation.
        throw recoveryStateError("older than ascii.dev's 24-hour retry window");
      }
      return { request: { ...pending }, startedNow: false };
    }

    const request: BoxCreateRequest = {
      botId,
      requestBody,
      idempotencyKey: randomUUID(),
      createdAt: now,
    };
    if (requests.length >= MAX_REQUESTS) throw recoveryStateError("full");
    save([...requests, request]);
    return { request: { ...request }, startedNow: true };
  });
}

/** Persist the returned identity before the caller attempts to rename it. */
export function rememberCreatedBox(request: BoxCreateRequest, boxId: string): BoxCreateRequest {
  if (!BOX_ID.test(boxId)) throw new Error("ascii.dev returned an invalid cloud computer id");
  return withJournalLock((requests) => {
    const current = requests.find((candidate) => (
      candidate.botId === request.botId
      && candidate.requestBody === request.requestBody
      && candidate.idempotencyKey === request.idempotencyKey
    ));
    if (!current || (current.boxId !== undefined && current.boxId !== boxId)) {
      throw recoveryStateError("out of date");
    }
    const completed = { ...current, boxId };
    // There can be an older rejected-TTL request for this bot. Once a Box is
    // known, it is the only recovery authority we need to retain.
    save([...requests.filter((candidate) => candidate.botId !== request.botId), completed]);
    return { ...completed };
  });
}

/** Mark the recovery record safe only after the deterministic provider rename
 * succeeds. Keeping the resolved Box ID still lets a later retry recover from
 * an eventually-consistent account listing without blocking bot deletion. */
export function resolveBoxCreate(request: BoxCreateRequest): BoxCreateRequest {
  return withJournalLock((requests) => {
    const current = requests.find((candidate) => (
      candidate.botId === request.botId
      && candidate.requestBody === request.requestBody
      && candidate.idempotencyKey === request.idempotencyKey
      && candidate.boxId === request.boxId
    ));
    if (!current?.boxId) throw recoveryStateError("out of date");
    const resolved: BoxCreateRequest = { ...current, resolved: true };
    save(requests.map((candidate) => candidate.idempotencyKey === current.idempotencyKey ? resolved : candidate));
    return { ...resolved };
  });
}

/** Read-only deletion guard. Both a key-only request with an ambiguous
 * provider outcome and a known-but-not-yet-named Box must keep its bot owner. */
export function hasUnresolvedBoxCreate(botId: string): boolean {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer creation");
  return withJournalLock((requests) => (
    requests.some((request) => request.botId === botId && request.resolved !== true)
  ));
}

/** Sanitized local recovery authority for configuration guards. The fresh,
 * lock-protected read can prove a remembered provider id even while the
 * account-wide LIST endpoint is eventually consistent. Provider request
 * bodies and idempotency keys never cross this boundary. */
export function boxCreateRecoverySnapshot(): BoxCreateRecoverySnapshot[] {
  return withJournalLock((requests) => requests.map((request) => ({
    botId: request.botId,
    ...(request.boxId ? { boxId: request.boxId } : {}),
    resolved: request.resolved === true,
  })));
}

/** Persist ownership discovered from a pre-journal deterministic Box name.
 * The provider listing proves which live bot owns the exact immutable id, but
 * it must never steal an identity remembered for another bot. It supersedes
 * stale attempts for the same bot, is idempotent, and fails closed on a true
 * cross-bot conflict. */
export function adoptResolvedBox(botId: string, boxId: string): void {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer ownership");
  if (!BOX_ID.test(boxId)) throw new Error("invalid cloud computer id for ownership");
  withJournalLock((requests) => {
    const sameBox = requests.find((request) => request.boxId === boxId);
    if (sameBox && sameBox.botId !== botId) {
      throw recoveryStateError("conflicted with another bot's remembered cloud computer");
    }
    const adopted: BoxCreateRequest = sameBox
      ? { ...sameBox, resolved: true }
      : {
          botId,
          requestBody: JSON.stringify({ adopted: "legacy-name", boxId }),
          idempotencyKey: randomUUID(),
          createdAt: Date.now(),
          boxId,
          resolved: true,
        };
    const retained = requests.filter((request) => request.botId !== botId);
    if (retained.length >= MAX_REQUESTS) throw recoveryStateError("full");
    if (
      requests.filter((request) => request.botId === botId).length === 1
      && sameBox?.resolved === true
      && sameBox.botId === botId
    ) return;
    // A successfully listed deterministic legacy name resolves any older
    // key-only/remembered attempt for this bot. Keeping those stale rows would
    // leave deletion permanently blocked after the adopted Box is removed.
    save([...retained, adopted]);
  });
}

/** Retire only the durable identity for a Box the provider has confirmed was
 * deleted. Callers must never use this for a failed or ambiguous deletion. */
export function retireDeletedBoxCreate(boxId: string): void {
  if (!BOX_ID.test(boxId)) throw new Error("invalid deleted cloud computer id");
  withJournalLock((requests) => {
    const next = requests.filter((request) => request.boxId !== boxId);
    if (next.length !== requests.length) save(next);
  });
}

export function discardBoxCreate(request: BoxCreateRequest): void {
  withJournalLock((requests) => {
    const next = requests.filter((candidate) => candidate.idempotencyKey !== request.idempotencyKey);
    if (next.length !== requests.length) save(next);
  });
}

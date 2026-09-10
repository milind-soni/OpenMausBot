import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

const LEASE_NAME = "openmausbot-server.lease";
const DELEGATED_CHILD_DIR = ".openmausbot-server-child";
// This is an internal, parent-to-utility-process capability. Callers must get
// it from utilityServerLeaseEnvironment(); neither its name nor its token is part
// of the public configuration surface.
const CHILD_LEASE_ENV = "OPENMAUSBOT_INTERNAL_DATA_DIR_LEASE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PID = 0x7fffffff;
const MAX_BOOT_ID = 128;
const MAX_REAPER_GENERATIONS = 128;

export class DataDirLeaseError extends Error {
  name = "DataDirLeaseError";
}

function leaseError(message, cause) {
  return Object.assign(new DataDirLeaseError(message), { cause });
}

function isPid(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_PID;
}

/**
 * A pid does not identify a process across a reboot. The kernel restarts pid
 * allocation, so the low pid a login-item launch recorded is typically reused
 * by a root-owned daemon on the next boot; process.kill(pid, 0) then answers
 * EPERM, which reads as alive, and the desktop refuses to start forever with
 * no instance for anyone to close. Recording which boot wrote the lease turns
 * that guess into proof.
 *
 * Both signals below may only ever prove a lease DEAD, never alive, and both
 * are exact rather than heuristic: a wrong "stale" verdict would let two
 * instances share one data directory, which is the harm this module exists to
 * prevent. Nothing here is derived from the wall clock, which NTP can move.
 */
let cachedBootSession;

function readBootSession() {
  try {
    if (process.platform === "linux") {
      return normalizeBootId(readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
    }
    if (process.platform === "darwin") {
      return normalizeBootId(execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }));
    }
  } catch {
    // An unreadable boot id is not a startup failure. The lease simply falls
    // back to the pid-only protocol this module has always used.
  }
  return null;
}

function normalizeBootId(value) {
  const id = String(value).trim();
  return id.length > 0 && id.length <= MAX_BOOT_ID && !/[^0-9A-Za-z:_.-]/.test(id) ? id : null;
}

/** Stable for one boot; Windows has no equivalent, so it reports null there. */
function bootSession() {
  if (cachedBootSession === undefined) cachedBootSession = readBootSession();
  return cachedBootSession;
}

function uptimeMs() {
  const seconds = uptime();
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1000) : 0;
}

function isBootIdentity(value) {
  return value === null || (typeof value === "string" && normalizeBootId(value) === value);
}

function ownerPredatesThisBoot(owner) {
  const current = bootSession();
  if (current !== null && typeof owner.boot === "string") return owner.boot !== current;
  // Without a boot id, a since-boot clock is still one-directional: it cannot
  // run backwards within a single boot, so a larger recorded value can only
  // have been written before a reboot.
  if (Number.isInteger(owner.uptime)) return uptimeMs() < owner.uptime;
  // A record written by an older build carries neither signal. Treating it as
  // current preserves the previous behaviour exactly.
  return false;
}

/** The only liveness question this module should ever ask about a record. */
function ownerIsAlive(owner) {
  return !ownerPredatesThisBoot(owner) && processIsAlive(owner.pid);
}

function isLeaseOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return value.version === 1
    && isPid(value.pid)
    && typeof value.host === "string"
    && value.host.length > 0
    && value.host.length <= 255
    && !/[\r\n\0]/.test(value.host)
    && typeof value.token === "string"
    && UUID.test(value.token)
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && value.createdAt > 0
    // Optional so a lease written by an older build stays readable rather
    // than bricking startup on an "invalid lease" during the upgrade.
    && (value.boot === undefined || isBootIdentity(value.boot))
    && (value.uptime === undefined || (Number.isInteger(value.uptime) && value.uptime >= 0));
}

function isReaperOwner(value, targetToken) {
  return isLeaseOwner(value)
    && value.targetToken === targetToken;
}

function parseRecord(path, invalidMessage, validate) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw leaseError("OpenMausBot cannot read the data-directory lease; refusing to start to protect its state.", error);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw leaseError(invalidMessage, error);
  }
  if (!validate(record)) throw leaseError(invalidMessage);
  return record;
}

function readOwner(path) {
  return parseRecord(
    path,
    "The OpenMausBot data-directory lease is invalid; refusing to start to protect its state.",
    isLeaseOwner,
  );
}

function readReaper(path, targetToken) {
  return parseRecord(
    path,
    "The OpenMausBot stale-lease recovery record is invalid; refusing to start to protect its state.",
    (value) => isReaperOwner(value, targetToken),
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the pid exists but this account cannot signal it.
    if (error?.code === "EPERM") return true;
    throw leaseError("OpenMausBot could not verify the data-directory lease owner; refusing to start.", error);
  }
}

function unlinkExact(path, message) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw leaseError(message, error);
  }
}

/** Publish an already complete record with one hard-link operation. */
function publishRecord(path, record, prepareMessage, acquireMessage) {
  const candidatePath = `${path}.candidate-${record.pid}-${record.token}`;
  try {
    writeFileSync(candidatePath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw leaseError(prepareMessage, error);
  }
  try {
    try {
      linkSync(candidatePath, path);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw leaseError(acquireMessage, error);
    }
  } finally {
    unlinkExact(candidatePath, "OpenMausBot could not remove its lease candidate.");
  }
}

function successorReaperPath(leasePath, targetToken, reaperToken) {
  const digest = createHash("sha256").update(reaperToken).digest("hex").slice(0, 32);
  return `${leasePath}.reap-${targetToken}-${digest}`;
}

/**
 * Elect exactly one live process to retire a particular dead lease owner.
 *
 * A reaper can itself crash. Its successor is elected at a deterministic new
 * path derived from the dead reaper's random token. We never unlink election
 * records, so no contender can delete a newer replacement between a liveness
 * check and publication. A chain of real crashes remains recoverable instead
 * of bricking this data directory forever.
 */
function claimReaperAuthority(leasePath, expected) {
  let reaperPath = `${leasePath}.reap-${expected.token}`;
  for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation += 1) {
    const candidate = {
      version: 1,
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
      createdAt: Date.now(),
      boot: bootSession(),
      uptime: uptimeMs(),
      targetToken: expected.token,
    };
    if (publishRecord(
      reaperPath,
      candidate,
      "OpenMausBot could not prepare stale-lease recovery.",
      "OpenMausBot could not safely recover the stale data-directory lease.",
    )) return true;

    const current = readReaper(reaperPath, expected.token);
    if (!current) continue;
    if (current.host !== candidate.host) {
      throw leaseError(
        `A stale OpenMausBot data-directory lease is being recovered on another machine. Recovery record: ${JSON.stringify(reaperPath)}.`,
      );
    }
    if (ownerIsAlive(current)) return false;
    reaperPath = successorReaperPath(leasePath, expected.token, current.token);
  }
  throw leaseError("OpenMausBot could not recover the stale data-directory lease after repeated interrupted attempts.");
}

function retireDeadOwner(leasePath, expected) {
  if (!claimReaperAuthority(leasePath, expected)) return false;
  const current = readOwner(leasePath);
  if (!current || current.token !== expected.token) return true;
  if (current.host !== hostname()) {
    throw leaseError(
      `The stale OpenMausBot data-directory lease changed ownership to another machine. Lease record: ${JSON.stringify(leasePath)}.`,
    );
  }
  if (ownerIsAlive(current)) return false;
  unlinkExact(leasePath, "OpenMausBot could not retire the stale data-directory lease.");
  return true;
}

function validateDataDir(dataDir) {
  if (typeof dataDir !== "string" || dataDir.trim().length === 0 || /[\r\n\0]/.test(dataDir)) {
    throw leaseError("OpenMausBot cannot lease an invalid data directory.");
  }
  return dataDir;
}

function prepareDataDir(dataDir, legacyDataDir) {
  validateDataDir(dataDir);
  if (legacyDataDir !== undefined) {
    validateDataDir(legacyDataDir);
    // Preserve the server's pre-rename migration order. Acquiring the new
    // directory first would create it and make the later one-time rename a
    // no-op, presenting an existing user with an empty workspace.
    if (!existsSync(dataDir) && existsSync(legacyDataDir)) {
      try {
        renameSync(legacyDataDir, dataDir);
      } catch {
        // Match the established migration: cross-device/busy falls through
        // to a fresh directory, while the untouched legacy data remains.
      }
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw leaseError("OpenMausBot cannot create its data directory.", error);
  }
  return join(dataDir, LEASE_NAME);
}

function assertNoLiveDelegatedChild(dataDir) {
  const childLeasePath = join(dataDir, DELEGATED_CHILD_DIR, LEASE_NAME);
  const child = readOwner(childLeasePath);
  if (!child) return;
  if (child.host !== hostname()) {
    throw leaseError(
      `This OpenMausBot data directory still has a delegated server on another machine. Delegated server lease: ${JSON.stringify(childLeasePath)}.`,
    );
  }
  if (ownerIsAlive(child)) {
    throw leaseError(
      `OpenMausBot's previous server process ${child.pid} is still shutting down. Try again shortly.`,
    );
  }
}

function capabilityFor(owner) {
  return `v1:${owner.pid}:${owner.token}`;
}

function parseCapability(value) {
  if (typeof value !== "string") return null;
  const match = /^v1:([1-9][0-9]{0,9}):([0-9a-f-]{36})$/.exec(value);
  if (!match || !UUID.test(match[2])) return null;
  const pid = Number(match[1]);
  return isPid(pid) ? { pid, token: match[2] } : null;
}

function consumeChildCapability(environment) {
  const value = environment[CHILD_LEASE_ENV];
  if (value === undefined) return null;
  try {
    delete environment[CHILD_LEASE_ENV];
  } catch (error) {
    throw leaseError("OpenMausBot could not consume its private desktop lease delegation.", error);
  }
  if (environment[CHILD_LEASE_ENV] !== undefined) {
    throw leaseError("OpenMausBot could not consume its private desktop lease delegation.");
  }
  return value;
}

function validateChildDelegation(dataDir, encoded) {
  validateDataDir(dataDir);
  const capability = parseCapability(encoded);
  const invalid = () => leaseError("The OpenMausBot desktop lease delegation is invalid; refusing to start to protect its state.");
  if (!capability) throw invalid();
  const parentLeasePath = join(dataDir, LEASE_NAME);
  const matchesLiveParent = (owner) => Boolean(owner
    && owner.pid === capability.pid
    && owner.token === capability.token
    && owner.host === hostname()
    && ownerIsAlive(owner));
  if (!matchesLiveParent(readOwner(parentLeasePath))) {
    throw invalid();
  }

  // Parent authorization and child exclusivity are separate. The parent
  // capability may be reused for a fallback port, but only one live utility
  // server can hold this subordinate lease at a time. A crashed child is
  // recovered by the same conservative protocol as a standalone owner.
  const childLease = acquireDataDirLeaseInternal(
    join(dataDir, DELEGATED_CHILD_DIR),
    { guardDelegatedChild: false },
  );
  if (!matchesLiveParent(readOwner(parentLeasePath))) {
    childLease.release();
    throw invalid();
  }
  return Object.freeze({
    ownerPid: childLease.ownerPid,
    delegated: true,
    // Release only this process's subordinate claim. The Electron parent's
    // durable lease remains untouched until the desktop finally exits.
    release: () => childLease.release(),
  });
}

function acquireDataDirLeaseInternal(dataDir, options = {}) {
  const leasePath = prepareDataDir(dataDir, options.legacyDataDir);
  if (options.guardDelegatedChild !== false) assertNoLiveDelegatedChild(dataDir);
  const owner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    createdAt: Date.now(),
    boot: bootSession(),
    uptime: uptimeMs(),
  };
  const candidatePath = `${leasePath}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidatePath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw leaseError("OpenMausBot cannot prepare its data-directory lease.", error);
  }

  let acquired = false;
  try {
    for (;;) {
      try {
        linkSync(candidatePath, leasePath);
        acquired = true;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw leaseError("OpenMausBot cannot acquire its data-directory lease.", error);
        }
      }

      const current = readOwner(leasePath);
      if (!current) continue;
      if (current.host !== owner.host) {
        throw leaseError(
          `This OpenMausBot data directory is already owned by a process on another machine. Lease record: ${JSON.stringify(leasePath)}.`,
        );
      }
      if (ownerIsAlive(current)) {
        throw leaseError(
          `OpenMausBot is already using this data directory (process ${current.pid}). Close the other instance first. If no OpenMausBot is running, delete this lease record and start again: ${JSON.stringify(leasePath)}.`,
        );
      }
      if (!retireDeadOwner(leasePath, current)) {
        throw leaseError("A stale OpenMausBot data-directory lease is already being recovered; try again shortly.");
      }
    }
  } finally {
    unlinkExact(candidatePath, "OpenMausBot could not remove its lease candidate.");
  }

  if (!acquired) throw leaseError("OpenMausBot could not acquire its data-directory lease.");
  let released = false;
  return Object.freeze({
    ownerPid: owner.pid,
    delegated: false,
    release() {
      if (released) return false;
      if (options.guardDelegatedChild !== false) assertNoLiveDelegatedChild(dataDir);
      const current = readOwner(leasePath);
      if (!current || current.pid !== owner.pid || current.host !== owner.host || current.token !== owner.token) {
        throw leaseError("OpenMausBot will not release a data-directory lease owned by another process.");
      }
      try {
        unlinkSync(leasePath);
      } catch (error) {
        throw leaseError("OpenMausBot could not release its data-directory lease.", error);
      }
      released = true;
      return true;
    },
    utilityServerLeaseEnvironment() {
      if (released) throw leaseError("OpenMausBot cannot delegate a released data-directory lease.");
      return Object.freeze({ [CHILD_LEASE_ENV]: capabilityFor(owner) });
    },
  });
}

/** Claim exclusive ownership of one persistent OpenMausBot data directory. */
export function acquireDataDirLease(dataDir, options = {}) {
  return acquireDataDirLeaseInternal(dataDir, options);
}

/**
 * Server entry-point API. A standalone server claims the lease; an Electron
 * utility child consumes and validates its parent's private capability.
 */
export function acquireDataDirLeaseForProcess(dataDir, environment = process.env) {
  const encoded = consumeChildCapability(environment);
  return encoded === null
    ? acquireDataDirLease(dataDir)
    : validateChildDelegation(dataDir, encoded);
}

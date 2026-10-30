import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

const LEASE_NAME = "openmausbot-server.lease";
const DELEGATED_CHILD_DIR = ".openmausbot-server-child";
// Internal parent-to-child capability, obtained only from utilityServerLeaseEnvironment(); never public configuration.
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
 * A pid does not survive a reboot: a low pid is often reused by a root daemon, whose EPERM reads as alive.
 * Boot identity and uptime may only prove a lease dead, never alive, and never use the wall clock (NTP moves it).
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
  }
  return null;
}

function normalizeBootId(value) {
  const id = String(value).trim();
  return id.length > 0 && id.length <= MAX_BOOT_ID && !/[^0-9A-Za-z:_.-]/.test(id) ? id : null;
}

/** Stable for one boot; Windows has no equivalent, so null there. */
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

/**
 * Containers on one host share its boot id, and each runs in a pid namespace of its own, where pids start again from 1:
 * a new container's server is often given the very pid its dead predecessor recorded. A pid means something only in
 * the namespace it was read in, so Linux records name theirs.
 */
let cachedPidNamespace;

function readPidNamespace() {
  if (process.platform !== "linux") return null;
  try {
    return /^pid:\[([1-9][0-9]{0,19})\]$/.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? null;
  } catch {
    return null;
  }
}

function pidNamespace() {
  if (cachedPidNamespace === undefined) cachedPidNamespace = readPidNamespace();
  return cachedPidNamespace;
}

function isPidNamespace(value) {
  return value === null || (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value));
}

/** Linux: when a process started, in clock ticks since boot (/proc/<pid>/stat field 22); null when unreadable. */
function processStartTicks(pid) {
  if (process.platform !== "linux") return null;
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // Field 2, the command name, is in parentheses and may itself hold spaces and parentheses.
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
}

function isStartTicks(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

/** Who this process is beyond its pid: its pid namespace and when it started, so a reused pid is never taken for it. */
function processIdentity() {
  return { ns: pidNamespace(), start: processStartTicks(process.pid) };
}

/** Unless the record provably predates this boot, one made in another pid namespace belongs to another container. */
function fromAnotherPidNamespace(record) {
  const current = bootSession();
  if (current !== null && typeof record.boot === "string" && record.boot !== current) return false;
  const ns = pidNamespace();
  return ns !== null && typeof record.ns === "string" && record.ns !== ns;
}

function ownerPredatesThisBoot(owner) {
  const current = bootSession();
  if (current !== null && typeof owner.boot === "string") return owner.boot !== current;
  // A since-boot clock never runs backwards within one boot, so a larger recorded uptime predates a reboot.
  if (Number.isInteger(owner.uptime)) return uptimeMs() < owner.uptime;
  return false;
}

/** The only liveness question this module should ever ask about a record. */
function ownerIsAlive(owner) {
  return !ownerPredatesThisBoot(owner) && processIsAlive(owner.pid) && ownerIdentityMatches(owner);
}

/** macOS renames the host on another network, so the same boot session (random per boot) also proves this machine. */
function sameMachine(record) {
  if (fromAnotherPidNamespace(record)) return false;
  if (record.host === hostname()) return true;
  const boot = bootSession();
  return boot !== null && typeof record.boot === "string" && record.boot === boot;
}

function otherMachineAdvice(path) {
  return ` If OpenMausBot is not running on another computer or container that shares this folder, quit OpenMausBot, delete ${JSON.stringify(path)} and start again.`;
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
    // Optional so an older build's lease stays readable during an upgrade.
    && (value.boot === undefined || isBootIdentity(value.boot))
    && (value.uptime === undefined || (Number.isInteger(value.uptime) && value.uptime >= 0))
    && (value.ns === undefined || isPidNamespace(value.ns))
    && (value.start === undefined || isStartTicks(value.start));
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

function parseWmiDateTime(value) {
  const raw = String(value).trim();
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/.exec(raw);
  if (!match) return null;
  const [_, year, month, day, hour, minute, second, micro, offset] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(Number(micro) / 1000),
  );
  const offsetMinutes = Number(offset);
  return ms - offsetMinutes * 60 * 1000;
}

function processCreationTimeMs(pid) {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/format:csv"],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lower === "node,creationdate" || lower.startsWith("node,")) continue;
      const parts = trimmed.split(",");
      const raw = parts[parts.length - 1].trim();
      const parsed = parseWmiDateTime(raw);
      if (parsed !== null) return parsed;
    }
  } catch {
  }
  return null;
}

/** Pids are reused within a boot: a process that started at another moment, or after the lease, is not its owner. */
function ownerIdentityMatches(owner) {
  if (process.platform === "linux") {
    if (!Number.isSafeInteger(owner.start) || typeof owner.ns !== "string" || owner.ns !== pidNamespace()) return true;
    const started = processStartTicks(owner.pid);
    return started === null || started === owner.start;
  }
  if (process.platform !== "win32") return true;
  const created = processCreationTimeMs(owner.pid);
  if (created === null) return true;
  return created < owner.createdAt;
}

function unlinkExact(path, message) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw leaseError(message, error);
  }
}

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

/** Election records are never unlinked, so no contender can delete a newer replacement between check and publish. */
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
      ...processIdentity(),
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
    if (!sameMachine(current)) {
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
  if (!sameMachine(current)) {
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
    // Before acquiring: creating the new directory first would turn the one-time legacy rename into a no-op.
    if (!existsSync(dataDir) && existsSync(legacyDataDir)) {
      try {
        renameSync(legacyDataDir, dataDir);
      } catch {
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
  if (!sameMachine(child)) {
    throw leaseError(
      `This OpenMausBot data directory still has a delegated server on another machine. Delegated server lease: ${JSON.stringify(childLeasePath)}.${otherMachineAdvice(childLeasePath)}`,
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
    && sameMachine(owner)
    && ownerIsAlive(owner));
  if (!matchesLiveParent(readOwner(parentLeasePath))) {
    throw invalid();
  }

  // The parent capability may serve a fallback port, but only one live utility server holds this subordinate lease.
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
    ...processIdentity(),
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
      if (!sameMachine(current)) {
        throw leaseError(
          `This OpenMausBot data directory is already owned by a process on another machine. Lease record: ${JSON.stringify(leasePath)}.${otherMachineAdvice(leasePath)}`,
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

export function acquireDataDirLease(dataDir, options = {}) {
  return acquireDataDirLeaseInternal(dataDir, options);
}

/**
 * For a data directory only one machine or container uses at a time (a Cloud home's volume, which its launcher holds
 * locked: server/cloud-home-start.ts), where a record another one wrote can never belong to a live process: removes every
 * lease, delegated-child lease and recovery record held by another machine or container and returns their holders.
 * Records from this one are left as they are: acquireDataDirLease() refuses a live one and recovers a dead one. Never
 * for a folder several computers share.
 */
export function clearRecordsFromOtherMachines(dataDir) {
  validateDataDir(dataDir);
  let entries;
  try {
    entries = readdirSync(dataDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw leaseError("OpenMausBot cannot read its data directory.", error);
  }
  const paths = [
    join(dataDir, LEASE_NAME),
    join(dataDir, DELEGATED_CHILD_DIR, LEASE_NAME),
    ...entries.filter((name) => name.startsWith(`${LEASE_NAME}.reap-`)).map((name) => join(dataDir, name)),
  ];
  const cleared = [];
  for (const path of paths) {
    const record = readOwner(path);
    if (!record || sameMachine(record)) continue;
    unlinkExact(path, "OpenMausBot could not remove the data-directory record another machine left.");
    cleared.push({ path, host: record.host, pid: record.pid });
  }
  return cleared;
}

export function acquireDataDirLeaseForProcess(dataDir, environment = process.env) {
  const encoded = consumeChildCapability(environment);
  return encoded === null
    ? acquireDataDirLease(dataDir)
    : validateChildDelegation(dataDir, encoded);
}

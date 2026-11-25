import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, uptime } from "node:os";
import { dirname, join, posix } from "node:path";

const LEASE_NAME = "openmausbot-server.lease";
const DELEGATED_CHILD_DIR = ".openmausbot-server-child";
// Internal parent-to-child capability, obtained only from utilityServerLeaseEnvironment(); never public configuration.
const CHILD_LEASE_ENV = "OPENMAUSBOT_INTERNAL_DATA_DIR_LEASE";
// Beside it, the parent's boot session and hashed machine id: its child runs on the same machine in the same boot, so it
// does not start `sysctl` and `ioreg` (macOS) or `reg.exe` (Windows) again before it can listen.
const CHILD_HOST_ENV = "OPENMAUSBOT_INTERNAL_DATA_DIR_HOST";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PID = 0x7fffffff;
const MAX_BOOT_ID = 128;
const MAX_REAPER_GENERATIONS = 128;
const MACHINE_ID = /^[0-9a-f]{32}$/;

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
      return normalizeBootId(commandOutput("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]));
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

/** This boot's id (Linux boot_id, macOS kern.bootsessionuuid), read once per process; null where there is none. */
export function hostBootSession() {
  return bootSession();
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

/** The only liveness question this module should ever ask about a record. `parentPid`: the pid of the process that started
 * this one, when the record is that parent's own (a delegated child checking the lease it was handed). */
function ownerIsAlive(owner, parentPid = null) {
  return !ownerPredatesThisBoot(owner) && processIsAlive(owner.pid) && ownerIdentityMatches(owner, parentPid);
}

/**
 * Whether a live pid must still be matched to the record by its creation time (Windows reuses pids). Not for the process
 * that started this one and handed it the record's own token: it is alive (it answered) and it is this process' parent,
 * and Chromium ends a utility process with its browser process. That query is `wmic`, or on Windows 11, where wmic is
 * gone, a PowerShell start that takes a second or more, run twice before the desktop's server could listen.
 */
export function creationTimeNeeded(platform, ownerPid, parentPid) {
  return platform === "win32" && !(isPid(parentPid) && ownerPid === parentPid);
}

/**
 * An install's own id, which outlives a reboot and a rename: macOS IOPlatformUUID, Windows MachineGuid, Linux machine-id.
 * Recorded hashed, never raw. A container's /etc/machine-id comes from its image, so every container (and every VM booted
 * from that image) shares one: Linux trusts it only when systemd, which generates it per install, is PID 1 outside a
 * container. Null wherever it cannot be read.
 */
let cachedMachineId;

/** A probe's stdout, its window hidden on Windows; throws when it fails or runs past `timeout`. */
function commandOutput(file, args, timeout = 5_000) {
  return execFileSync(file, args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}

function linuxInstallHasOwnMachineId() {
  // systemd writes /run/systemd/container inside LXC, nspawn and other containers it detects.
  if (["/.dockerenv", "/run/.containerenv", "/run/systemd/container"].some((marker) => existsSync(marker))) return false;
  try {
    return readFileSync("/proc/1/comm", "utf8").trim() === "systemd";
  } catch {
    return false;
  }
}

function readRawMachineId() {
  try {
    if (process.platform === "darwin") {
      return /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{32,36})"/.exec(commandOutput("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1] ?? null;
    }
    if (process.platform === "win32") {
      const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
      // /reg:64: a 32-bit process would otherwise read the WOW64 view, which has no MachineGuid.
      const output = commandOutput(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
      return /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{32,36})\s*$/m.exec(output)?.[1] ?? null;
    }
    if (process.platform === "linux" && linuxInstallHasOwnMachineId()) {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const id = readFileSync(path, "utf8").trim();
          if (/^[0-9A-Fa-f]{32}$/.test(id)) return id;
        } catch {
        }
      }
    }
  } catch {
  }
  return null;
}

function machineId() {
  if (cachedMachineId === undefined) {
    const raw = readRawMachineId();
    cachedMachineId = raw === null
      ? null
      : createHash("sha256").update(`openmausbot-machine:${raw.toLowerCase()}`).digest("hex").slice(0, 32);
  }
  return cachedMachineId;
}

/**
 * From `df -P <path>` and `mount`: whether the volume holding the path is mounted local, never a network share (smbfs,
 * nfs, afpfs, webdav). A mount point may itself hold " on " or " (", so df names it and only the line naming exactly
 * that mount point counts. False on any doubt.
 */
export function macMountIsLocal(dfOutput, mountTable) {
  const lines = String(dfOutput).trimEnd().split("\n");
  if (lines.length !== 2) return false;
  const point = /^.*?\s\d+\s+\d+\s+\d+\s+\d+%\s+(\/.*)$/.exec(lines[1])?.[1];
  if (!point) return false;
  const marker = ` on ${point} (`;
  const matches = String(mountTable).split("\n").filter((line) => line.includes(marker) && line.endsWith(")"));
  if (matches.length !== 1) return false;
  const line = matches[0];
  return line.slice(line.indexOf(marker) + marker.length, -1).split(", ").includes("local");
}

const MAC_SYNCED_FOLDERS = [["Library", "Mobile Documents"], ["Library", "CloudStorage"]];

/** iCloud Drive and File Provider sync folders (Dropbox, OneDrive, Google Drive) are local disks other Macs write to. Mac
 * paths, so joined with "/" on any host. */
export function inMacSyncedFolder(path, home) {
  const lower = path.toLowerCase();
  return MAC_SYNCED_FOLDERS.some((parts) => {
    const root = posix.join(home, ...parts).toLowerCase();
    return lower === root || lower.startsWith(`${root}/`);
  });
}

function onLocalUnsyncedMacVolume(dir) {
  try {
    const path = realpathSync(dir);
    const home = homedir();
    let realHome = home;
    try {
      realHome = realpathSync(home);
    } catch {
    }
    if (inMacSyncedFolder(path, home) || inMacSyncedFolder(path, realHome)) return false;
    return macMountIsLocal(commandOutput("/bin/df", ["-P", path]), commandOutput("/sbin/mount", []));
  } catch {
    return false;
  }
}

/**
 * macOS gives the host a new name on another network, and before boot sessions and machine ids were recorded nothing
 * else identified the Mac; such a record is this Mac's when it was written in an earlier boot on a folder only this Mac
 * mounts and no sync service mirrors. Known open risk: an older build on another Mac reaching this folder some other way.
 */
function olderBuildRecordFromEarlierMacBoot(record, dir) {
  if (process.platform !== "darwin" || dir === undefined || record.machine !== undefined) return false;
  const boot = bootSession();
  if (boot === null || typeof record.boot !== "string" || record.boot === boot) return false;
  return onLocalUnsyncedMacVolume(dir);
}

/**
 * Another machine id is another machine. The same id is this machine under any hostname only on macOS, which renames the
 * host on another network; Linux and Windows keep theirs, and a VM cloned from a template keeps the template's id. Then:
 * the same host, or the same boot session (random per boot), proves this machine. `dir`, the folder the record sits in,
 * admits an older build's record from an earlier boot of this Mac; without it that is never presumed, as when clearing a
 * single-machine volume.
 */
function sameMachine(record, dir) {
  if (fromAnotherPidNamespace(record)) return false;
  const machine = machineId();
  if (machine !== null && typeof record.machine === "string") {
    if (record.machine !== machine) return false;
    if (process.platform === "darwin") return true;
  }
  if (record.host === hostname()) return true;
  const boot = bootSession();
  if (boot !== null && typeof record.boot === "string" && record.boot === boot) return true;
  return olderBuildRecordFromEarlierMacBoot(record, dir);
}

function otherMachineAdvice(path, t) {
  if (t) return t("native.boot.sharedFolderAdvice", { path: JSON.stringify(path) });
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
    && (value.start === undefined || isStartTicks(value.start))
    && (value.machine === undefined || value.machine === null || (typeof value.machine === "string" && MACHINE_ID.test(value.machine)));
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
    if (error?.code === "EPERM") return process.platform !== "win32" || windowsProcessListed(pid) !== false;
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

/** Windows: when a process started, in ms since the epoch; null when it has exited or neither probe can read it. */
function processCreationTimeMs(pid) {
  if (process.platform !== "win32") return null;
  return wmicCreationTimeMs(pid) ?? cimCreationTimeMs(pid);
}

function wmicCreationTimeMs(pid) {
  try {
    const output = commandOutput("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/format:csv"], 5_000);
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

/**
 * Windows 11 no longer installs wmic, and without a creation time every reused pid reads as the lease's owner, so
 * the lease can never be recovered. Windows PowerShell ships with every Windows; named by full path, never via PATH.
 */
function cimCreationTimeMs(pid) {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const output = commandOutput(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`,
    ], 15_000);
    const ms = Number(output.trim());
    return output.trim() && Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Windows keeps an exited process' pid allocated while any handle to it stays open, and EPERM answers
 * for that dead object exactly as for a live process this account may not signal; only the process
 * list separates them. null when neither probe can read it, so the caller stays conservative.
 */
function windowsProcessListed(pid) {
  return tasklistHasPid(pid) ?? cimHasPid(pid);
}

/**
 * `tasklist /FI "PID eq <pid>" /FO CSV /NH`: a quoted CSV row when the pid runs, an INFO line (in the system's language)
 * when it does not; null for no output at all, which proves nothing, so the next probe answers.
 */
export function tasklistListsPid(output) {
  const lines = String(output).replace(/^﻿/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return lines.some((line) => line.startsWith('"'));
}

/** tasklist ships with every Windows and lists every running process, whatever account or session owns it. */
function tasklistHasPid(pid) {
  try {
    return tasklistListsPid(commandOutput("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 5_000));
  } catch {
    return null;
  }
}

function cimHasPid(pid) {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const output = commandOutput(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `if (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop) { '1' }`,
    ], 15_000);
    return output.trim() === "1";
  } catch {
    return null;
  }
}

/** Pids are reused within a boot: a process that started at another moment, or after the lease, is not its owner. */
function ownerIdentityMatches(owner, parentPid = null) {
  if (process.platform === "linux") {
    if (!Number.isSafeInteger(owner.start) || typeof owner.ns !== "string" || owner.ns !== pidNamespace()) return true;
    const started = processStartTicks(owner.pid);
    return started === null || started === owner.start;
  }
  if (process.platform !== "win32" || !creationTimeNeeded(process.platform, owner.pid, parentPid)) return true;
  return windowsCreationFitsLease(processCreationTimeMs(owner.pid), owner.createdAt);
}

/**
 * How far a process' creation time, as Windows reports it, may run past the createdAt its own Date.now() wrote. The two
 * clocks are read differently (the kernel's stamp at creation, JavaScript's clock in the process), so they disagree by
 * up to a timer tick or more, and NTP may step the wall clock between the two readings. Without slack a live owner that
 * wrote its lease moments after starting reads as a reused pid and its lease is taken over: two servers on one folder.
 * Erring this way only keeps a lease whose pid was reused within these seconds blocked while that process lives.
 */
const WINDOWS_CREATION_SLACK_MS = 5_000;

/** Windows: whether the process now holding the pid can be the lease's owner; unknown (null) creation time counts as yes. */
export function windowsCreationFitsLease(createdMs, leaseCreatedAt) {
  if (createdMs === null) return true;
  return createdMs < leaseCreatedAt + WINDOWS_CREATION_SLACK_MS;
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
      machine: machineId(),
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
    if (!sameMachine(current, dirname(leasePath))) {
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
  if (!sameMachine(current, dirname(leasePath))) {
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

function assertNoLiveDelegatedChild(dataDir, t) {
  const childLeasePath = join(dataDir, DELEGATED_CHILD_DIR, LEASE_NAME);
  const child = readOwner(childLeasePath);
  if (!child) return;
  if (!sameMachine(child, dataDir)) {
    throw leaseError(
      `This OpenMausBot data directory still has a delegated server on another machine. Delegated server lease: ${JSON.stringify(childLeasePath)}.${otherMachineAdvice(childLeasePath, t)}`,
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
    && sameMachine(owner, dataDir)
    && ownerIsAlive(owner, process.ppid));
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
  if (options.guardDelegatedChild !== false) assertNoLiveDelegatedChild(dataDir, options.t);
  const owner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    createdAt: Date.now(),
    boot: bootSession(),
    uptime: uptimeMs(),
    ...processIdentity(),
    machine: machineId(),
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
      if (!sameMachine(current, dataDir)) {
        throw leaseError(
          `This OpenMausBot data directory is already owned by a process on another machine. Lease record: ${JSON.stringify(leasePath)}.${otherMachineAdvice(leasePath, options.t)}`,
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
      return Object.freeze({ [CHILD_LEASE_ENV]: capabilityFor(owner), [CHILD_HOST_ENV]: hostIdentityFor(owner) });
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
  return clearRecords(dataDir, (record) => !sameMachine(record));
}

/**
 * For a container's entry as it starts (server/server-launcher.ts): a record this same container left in an earlier run
 * (its hostname, this boot, another pid namespace) belongs to a process that died with that run, since a container's
 * pid namespace and every process in it end together, and a restarted container gets a new one. Without this, a
 * server killed outright (out of memory, `kill -9`) was refused at every restart as "another machine". Removes those
 * records and returns their holders. Another container's records (another hostname, as Docker names each container)
 * stay, and acquireDataDirLease() refuses them as before.
 */
export function clearRecordsFromEarlierRunOfThisContainer(dataDir) {
  const boot = bootSession();
  const ns = pidNamespace();
  if (boot === null || ns === null) return [];
  return clearRecords(dataDir, (record) => record.host === hostname() && record.boot === boot && typeof record.ns === "string" && record.ns !== ns);
}

function clearRecords(dataDir, stale) {
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
    if (!record || !stale(record)) continue;
    unlinkExact(path, "OpenMausBot could not remove the data-directory record another machine left.");
    cleared.push({ path, host: record.host, pid: record.pid });
  }
  return cleared;
}

/**
 * Who holds the data directory's lease, read only (`openmausbot doctor`): "none"; "alive", a running process on this
 * machine; "dead", a process of this machine that is gone, which the next acquireDataDirLease() retires; "other-machine";
 * or "invalid", a record that cannot be read, which acquireDataDirLease() refuses. Never changes a file.
 */
export function describeDataDirLease(dataDir) {
  const path = join(validateDataDir(dataDir), LEASE_NAME);
  let owner;
  try {
    owner = readOwner(path);
  } catch {
    return { state: "invalid", path };
  }
  if (!owner) return { state: "none", path };
  const holder = { path, pid: owner.pid, host: owner.host, createdAt: owner.createdAt };
  if (!sameMachine(owner, dataDir)) return { state: "other-machine", ...holder };
  try {
    return { state: ownerIsAlive(owner) ? "alive" : "dead", ...holder };
  } catch {
    // Liveness that cannot be told is taken as alive, as acquiring would refuse it.
    return { state: "alive", ...holder };
  }
}

function hostIdentityFor(owner) {
  return `${owner.boot ?? "-"} ${owner.machine ?? "-"}`;
}

/** The parent's boot session and machine id, each kept only when well formed; read once and removed, like the capability. */
export function consumeHostIdentity(environment) {
  const value = environment[CHILD_HOST_ENV];
  if (value === undefined) return null;
  try { delete environment[CHILD_HOST_ENV]; } catch {}
  const [boot, machine, extra] = String(value).split(" ");
  if (extra !== undefined) return null;
  return {
    boot: boot === "-" ? null : normalizeBootId(boot) === boot ? boot : undefined,
    machine: machine === "-" ? null : MACHINE_ID.test(machine ?? "") ? machine : undefined,
  };
}

export function acquireDataDirLeaseForProcess(dataDir, environment = process.env) {
  const host = consumeHostIdentity(environment);
  const encoded = consumeChildCapability(environment);
  if (encoded !== null && host) {
    if (cachedBootSession === undefined && host.boot !== undefined) cachedBootSession = host.boot;
    if (cachedMachineId === undefined && host.machine !== undefined) cachedMachineId = host.machine;
  }
  return encoded === null
    ? acquireDataDirLease(dataDir)
    : validateChildDelegation(dataDir, encoded);
}

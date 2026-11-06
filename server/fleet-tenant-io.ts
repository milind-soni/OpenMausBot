import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { assertUnixUser } from "./fleet.ts";
import type { FleetUsageTotals } from "./fleet-cli.ts";

/** A month's distinct askers in one workspace, as the tenant-side helper reports them; the figures are tenant-reported. */
export interface PeopleResult {
  v: 1;
  month: string;
  turns: number;
  costUsd: number | null;
  ignoredLines: number;
  unattributedTurns: number;
  people: { id: string; kind: "email" | "device"; asked: number; attributed: number; costUsd: number | null }[];
  seats: { emails: number; domains: number };
}

// Tenant-controlled ancestors can be renamed between any two filesystem calls: the boundary is dropping ALL root authority
// before I/O, not a preceding lstat. The checks also reject visible symlinks, shared inodes and special files.
export const TENANT_IO = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const { uid, gid, home, file, action, content, mode } = request;
if (process.getuid() === 0) {
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
}
if (process.getuid() !== uid || process.getgid() !== gid || uid === 0 || gid === 0) throw Error("could not drop fleet file privileges");
const limit = 4 * 1024 * 1024;
const check = (stat, directory) => {
  if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw Error("unsafe workspace file or directory");
};
const totals = { turns: 0, costUsd: null, billableUsd: null };
let cursor = home;
try {
  check(fs.lstatSync(cursor), true);
  for (const part of path.relative(home, path.dirname(file)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    check(fs.lstatSync(cursor), true);
  }
} catch (error) {
  if (action !== "usage" || error.code !== "ENOENT") throw error;
  process.stdout.write(JSON.stringify(totals));
  process.exit(0);
}
let result = null;
if (action === "mkdir") {
  try { fs.mkdirSync(file, { mode }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  check(fs.lstatSync(file), true);
} else if (action === "read" || action === "usage") {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (fd !== undefined) {
    try {
      const stat = fs.fstatSync(fd);
      check(stat, false);
      if (stat.size > limit) throw Error("workspace file exceeds 4 MiB");
      const data = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < data.length) { const read = fs.readSync(fd, data, size, data.length - size, null); if (!read) break; size += read; }
      if (size > limit) throw Error("workspace file exceeds 4 MiB");
      result = data.subarray(0, size).toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  if (action === "usage") {
    const to = Date.parse(content);
    const date = new Date(to);
    const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    // Scan one bounded month's text without retaining rows or allocating groups.
    const text = result || "";
    for (let offset = 0; offset < text.length;) {
      const end = text.indexOf("\n", offset);
      const line = text.slice(offset, end < 0 ? text.length : end);
      offset = end < 0 ? text.length : end + 1;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== "object" || typeof row.at !== "string" || typeof row.botId !== "string" || typeof row.model !== "string" || typeof row.input !== "number" || typeof row.output !== "number" || !row.trigger || typeof row.trigger !== "object" || typeof row.trigger.kind !== "string") continue;
      const at = Date.parse(row.at);
      if (!(at >= from && at <= to)) continue;
      totals.turns++;
      if (typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0) {
        const sum = (totals.costUsd || 0) + row.costUsd;
        if (!Number.isFinite(sum)) throw Error("workspace usage total exceeds numeric range");
        totals.costUsd = sum;
      }
    }
    result = totals;
  }
} else if (action === "write") {
  if (Buffer.byteLength(content) > limit) throw Error("workspace file exceeds 4 MiB");
  try { check(fs.lstatSync(file), false); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = file + ".fleet-" + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
} else throw Error("unknown fleet file operation");
process.stdout.write(JSON.stringify(result));
`;

export function tenantIo(owner: string, file: string, action: "read" | "write" | "mkdir" | "usage", content?: string, mode?: number): string | null | FleetUsageTotals {
  assertUnixUser(owner);
  const options = { encoding: "utf8" as const, timeout: 5_000, killSignal: "SIGKILL" as const, cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  const account = execFileSync("/usr/bin/getent", ["passwd", owner], { ...options, maxBuffer: 8192 }).trim().split(":");
  const uid = Number(account[2]);
  const gid = Number(account[3]);
  const home = account[5];
  if (account.length !== 7 || account[0] !== owner || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 || !home?.startsWith("/") || posix.normalize(home) !== home || !file.startsWith(`${home}/`) || posix.normalize(file) !== file) {
    throw new Error(`unsafe filesystem identity or path for ${owner}`);
  }
  try {
    return JSON.parse(execFileSync(process.execPath, ["--eval", TENANT_IO], { ...options, maxBuffer: action === "usage" ? 8192 : 32 * 1024 * 1024, input: JSON.stringify({ uid, gid, home, file, action, content, mode }) })) as string | null | FleetUsageTotals;
  } catch {
    // Do not repeat helper stderr: tenant-controlled file contents may be secret.
    throw new Error(`could not ${action} workspace file as ${owner}: check ownership, links, file size and permissions`);
  }
}

export function meterTenantPeople(_dataDir: string, _owner: string, _month: string, _maxUsers?: number): Promise<PeopleResult> {
  return Promise.reject(new Error("metering a workspace's people is not implemented yet"));
}

export function parsePeopleResult(_raw: unknown): PeopleResult {
  throw new Error("parsing a people result is not implemented yet");
}

import { execFileSync, spawn } from "node:child_process";
import { posix } from "node:path";
import { assertUnixUser } from "./fleet.ts";
import type { FleetUsageTotals } from "./fleet-cli.ts";
import { checkMaxUsers, DEFAULT_MAX_USERS, hasControl, MAX_LEDGER_LINE_BYTES, MAX_PERSON_ID, monthWindow } from "./fleet-metering.ts";

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

const IO_OPTIONS = { encoding: "utf8" as const, timeout: 5_000, killSignal: "SIGKILL" as const, cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };

function tenantAccount(owner: string, files: string[]): { uid: number; gid: number; home: string } {
  assertUnixUser(owner);
  const account = execFileSync("/usr/bin/getent", ["passwd", owner], { ...IO_OPTIONS, maxBuffer: 8192 }).trim().split(":");
  const uid = Number(account[2]);
  const gid = Number(account[3]);
  const home = account[5];
  if (account.length !== 7 || account[0] !== owner || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 || !home?.startsWith("/") || posix.normalize(home) !== home || files.some((file) => !file.startsWith(`${home}/`) || posix.normalize(file) !== file)) {
    throw new Error(`unsafe filesystem identity or path for ${owner}`);
  }
  return { uid, gid, home };
}

export function tenantIo(owner: string, file: string, action: "read" | "write" | "mkdir" | "usage", content?: string, mode?: number): string | null | FleetUsageTotals {
  const { uid, gid, home } = tenantAccount(owner, [file]);
  try {
    return JSON.parse(execFileSync(process.execPath, ["--eval", TENANT_IO], { ...IO_OPTIONS, maxBuffer: action === "usage" ? 8192 : 32 * 1024 * 1024, input: JSON.stringify({ uid, gid, home, file, action, content, mode }) })) as string | null | FleetUsageTotals;
  } catch {
    // Do not repeat helper stderr: tenant-controlled file contents may be secret.
    throw new Error(`could not ${action} workspace file as ${owner}: check ownership, links, file size and permissions`);
  }
}

const PEOPLE_CHUNK_BYTES = 1024 * 1024;
const PEOPLE_FILE_LIMIT = 256 * 1024 * 1024;
const PEOPLE_CHILD_BUDGET_MS = 18_000;
export const PEOPLE_DEADLINE_MS = 20_000;
const PEOPLE_OUTPUT_LIMIT = 8 * 1024 * 1024;
const PEOPLE_REASONS = [
  /^unsafe workspace file or directory$/,
  /^workspace ledger exceeds 256 MiB$/,
  /^workspace ledger took too long$/,
  /^workspace usage total exceeds numeric range$/,
  /^more than \d{1,5} distinct people asked this workspace$/,
];

// Same privilege drop and descriptor checks as TENANT_IO. The ledger is read in 1 MiB chunks so a large month never sits
// in memory; every message the child can print is a fixed string, because a tenant controls the bytes it parses.
export const PEOPLE_IO = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const { uid, gid, home, file, config, start, end, month, maxUsers, chunkBytes, fileLimit, lineLimit, idLimit, budgetMs } = request;
class Fail extends Error {}
const fail = (message) => { throw new Fail(message); };
try {
  if (process.getuid() === 0) {
    process.setgroups([]);
    process.setgid(gid);
    process.setuid(uid);
  }
  if (process.getuid() !== uid || process.getgid() !== gid || uid === 0 || gid === 0) fail("unsafe workspace file or directory");
  const deadline = Date.now() + budgetMs;
  const check = (stat, directory) => {
    if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail("unsafe workspace file or directory");
  };
  const reach = (target) => {
    let cursor = home;
    try {
      check(fs.lstatSync(cursor), true);
      for (const part of path.relative(home, path.dirname(target)).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        check(fs.lstatSync(cursor), true);
      }
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  const open = (target) => {
    if (!reach(target)) return undefined;
    try { return fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  const lines = (target, upTo, onLine, onSkipped) => {
    const fd = open(target);
    if (fd === undefined) return 0;
    try {
      const stat = fs.fstatSync(fd);
      check(stat, false);
      if (stat.size > fileLimit) fail("workspace ledger exceeds 256 MiB");
      const chunk = Buffer.alloc(chunkBytes);
      let carry = Buffer.alloc(0);
      let skipping = false;
      let total = 0;
      while (total < upTo) {
        if (Date.now() > deadline) fail("workspace ledger took too long");
        const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, upTo - total), null);
        if (!read) break;
        total += read;
        if (total > fileLimit) fail("workspace ledger exceeds 256 MiB");
        const data = Buffer.concat([carry, chunk.subarray(0, read)]);
        let offset = 0;
        for (let end = data.indexOf(10, offset); end >= 0; end = data.indexOf(10, offset)) {
          if (skipping) skipping = false;
          else if (end - offset > lineLimit) onSkipped();
          else onLine(data.subarray(offset, end));
          offset = end + 1;
        }
        carry = skipping ? Buffer.alloc(0) : Buffer.from(data.subarray(offset));
        if (carry.length > lineLimit) { skipping = true; carry = Buffer.alloc(0); onSkipped(); }
      }
      if (!skipping && carry.length) onLine(carry);
      return total;
    } finally { fs.closeSync(fd); }
  };
  const seats = { emails: 0, domains: 0 };
  const fd = open(config);
  if (fd !== undefined) {
    try {
      const stat = fs.fstatSync(fd);
      check(stat, false);
      if (stat.size > 4 * 1024 * 1024) fail("unsafe workspace file or directory");
      const data = Buffer.alloc(stat.size);
      let size = 0;
      while (size < data.length) { const read = fs.readSync(fd, data, size, data.length - size, null); if (!read) break; size += read; }
      let parsed = null;
      try { parsed = JSON.parse(data.subarray(0, size).toString("utf8")); } catch {}
      const signIn = parsed && typeof parsed === "object" ? parsed.signIn : undefined;
      const entries = new Set();
      if (signIn && typeof signIn === "object") {
        for (const list of [signIn.admins, signIn.members]) {
          if (!Array.isArray(list)) continue;
          for (const item of list) if (typeof item === "string" && item.trim()) entries.add(item.trim().toLowerCase());
        }
      }
      for (const entry of entries) { if (entry.startsWith("@")) seats.domains++; else if (entry.includes("@")) seats.emails++; }
    } finally { fs.closeSync(fd); }
  }
  const emailShape = /^[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const control = /[\u0000-\u001f\u007f-\u009f]/;
  const emailOf = (value) => {
    if (typeof value !== "string") return undefined;
    const email = value.trim().toLowerCase();
    return email.length <= idLimit && email.indexOf("@") <= 64 && emailShape.test(email) ? email : undefined;
  };
  const deviceOf = (value) => {
    if (typeof value !== "string") return undefined;
    const label = value.normalize("NFKC").trim().toLowerCase();
    if (!label || control.test(label)) return undefined;
    return ("device:" + label).length <= idLimit ? "device:" + label : undefined;
  };
  const rowOf = (line) => {
    if (!line.length || !line.toString("utf8").trim()) return null;
    let row;
    try { row = JSON.parse(line.toString("utf8")); } catch { return undefined; }
    if (!row || typeof row !== "object" || typeof row.at !== "string" || typeof row.botId !== "string" || typeof row.model !== "string" || typeof row.input !== "number" || typeof row.output !== "number" || !row.trigger || typeof row.trigger !== "object" || typeof row.trigger.kind !== "string") return undefined;
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) return undefined;
    if (!(at >= start && at < end)) return null;
    const human = row.trigger.kind === "user";
    const ok = row.outcome === undefined || (Boolean(row.outcome) && typeof row.outcome === "object" && row.outcome.status === "ok");
    const key = human ? emailOf(row.trigger.email) || deviceOf(row.trigger.label) : emailOf(row.trigger.email);
    const cost = typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0 ? row.costUsd : null;
    return { human, ok, key, cost };
  };
  const add = (total, amount) => {
    if (amount === null) return total;
    const sum = (total === null ? 0 : total) + amount;
    if (!Number.isFinite(sum)) fail("workspace usage total exceeds numeric range");
    return sum;
  };
  const people = new Map();
  const result = { v: 1, month, turns: 0, costUsd: null, ignoredLines: 0, unattributedTurns: 0 };
  let deferred = 0;
  const first = lines(file, Infinity, (line) => {
    const row = rowOf(line);
    if (row === undefined) { result.ignoredLines++; return; }
    if (row === null) return;
    result.turns++;
    result.costUsd = add(result.costUsd, row.cost);
    if (row.human && row.ok) {
      if (!row.key) { result.unattributedTurns++; return; }
      let person = people.get(row.key);
      if (!person) {
        if (people.size >= maxUsers) fail("more than " + maxUsers + " distinct people asked this workspace");
        person = { kind: row.key.startsWith("device:") ? "device" : "email", asked: 0, attributed: 0, costUsd: null };
        people.set(row.key, person);
      }
      person.asked++;
      person.attributed++;
      person.costUsd = add(person.costUsd, row.cost);
    } else if (row.key) deferred++;
  }, () => { result.ignoredLines++; });
  if (deferred) {
    lines(file, first, (line) => {
      const row = rowOf(line);
      if (!row || !row.key || (row.human && row.ok)) return;
      const person = people.get(row.key);
      if (!person) return;
      person.attributed++;
      person.costUsd = add(person.costUsd, row.cost);
    }, () => {});
  }
  result.people = [...people].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, person]) => ({ id, ...person }));
  result.seats = seats;
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Fail ? error.message : "failed");
  process.exit(1);
}
`;

/** Counts a month's distinct human askers inside the workspace's own account, never returning a ledger row or the sign-in lists. */
export function meterTenantPeople(dataDir: string, owner: string, month: string, maxUsers?: number): Promise<PeopleResult> {
  const limit = checkMaxUsers(maxUsers);
  const { start, end } = monthWindow(month);
  const file = posix.join(dataDir, "usage", `${month}.jsonl`);
  const config = posix.join(dataDir, "config.json");
  let account: { uid: number; gid: number; home: string };
  try { account = tenantAccount(owner, [file, config]); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const refuse = (reason: string) => reject(new Error(`could not meter people as ${owner}: ${reason}`));
    let out = "";
    let err = "";
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
    const child = spawn(process.execPath, ["--eval", PEOPLE_IO], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], killSignal: "SIGKILL" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(() => refuse("workspace ledger took too long")); }, PEOPLE_DEADLINE_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > PEOPLE_OUTPUT_LIMIT) { child.kill("SIGKILL"); finish(() => refuse("the answer was larger than allowed")); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (err.length < 256) err += chunk; });
    child.once("error", () => finish(() => refuse("could not start the helper")));
    child.once("close", (code) => finish(() => {
      if (code !== 0) return refuse(PEOPLE_REASONS.some((reason) => reason.test(err)) ? err : "check ownership, links, file size and permissions");
      try { resolve(parsePeopleResult(JSON.parse(out), limit, month)); } catch { refuse("the helper's answer was not valid"); }
    }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...account, file, config, start, end, month, maxUsers: limit, chunkBytes: PEOPLE_CHUNK_BYTES, fileLimit: PEOPLE_FILE_LIMIT, lineLimit: MAX_LEDGER_LINE_BYTES, idLimit: MAX_PERSON_ID, budgetMs: PEOPLE_CHILD_BUDGET_MS }));
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a non-negative whole number`);
  return value;
};
const money = (value: unknown, what: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${what} must be a non-negative finite number or null`);
  return value;
};
function exact(value: unknown, what: string, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  const names = Object.keys(value);
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) throw new Error(`${what} has unexpected fields`);
  return value;
}

/** Throws on anything out of bounds; a result is whole or it is refused. */
export function parsePeopleResult(raw: unknown, maxUsers: number = DEFAULT_MAX_USERS, month?: string): PeopleResult {
  const limit = checkMaxUsers(maxUsers);
  const fields = exact(raw, "people result", ["v", "month", "turns", "costUsd", "ignoredLines", "unattributedTurns", "people", "seats"]);
  if (fields.v !== 1) throw new Error("people result has an unknown version");
  if (typeof fields.month !== "string") throw new Error("people result needs a month");
  monthWindow(fields.month);
  if (month !== undefined && fields.month !== month) throw new Error("people result is for another month");
  if (!Array.isArray(fields.people)) throw new Error("people must be a list");
  if (fields.people.length > limit) throw new Error(`more than ${limit} people`);
  const seen = new Set<string>();
  let asked = 0;
  const people = fields.people.map((item, index) => {
    const person = exact(item, `people[${index}]`, ["id", "kind", "asked", "attributed", "costUsd"]);
    const id = person.id;
    if (typeof id !== "string" || !id.length || id.length > MAX_PERSON_ID || hasControl(id)) throw new Error(`people[${index}].id must be 1 to ${MAX_PERSON_ID} characters without control characters`);
    if (person.kind !== "email" && person.kind !== "device") throw new Error(`people[${index}].kind must be email or device`);
    if ((person.kind === "device") !== id.startsWith("device:") || (person.kind === "email" && (!id.includes("@") || id !== id.toLowerCase()))) throw new Error(`people[${index}].id does not match its kind`);
    if (seen.has(id)) throw new Error(`people[${index}].id repeats`);
    seen.add(id);
    const entry = { id, kind: person.kind as "email" | "device", asked: count(person.asked, `people[${index}].asked`), attributed: count(person.attributed, `people[${index}].attributed`), costUsd: money(person.costUsd, `people[${index}].costUsd`) };
    asked += entry.asked;
    return entry;
  });
  const seats = exact(fields.seats, "seats", ["emails", "domains"]);
  const turns = count(fields.turns, "turns");
  const unattributedTurns = count(fields.unattributedTurns, "unattributedTurns");
  if (asked + unattributedTurns > turns) throw new Error("people result counts more turns than it holds");
  return {
    v: 1,
    month: fields.month,
    turns,
    costUsd: money(fields.costUsd, "costUsd"),
    ignoredLines: count(fields.ignoredLines, "ignoredLines"),
    unattributedTurns,
    people,
    seats: { emails: count(seats.emails, "seats.emails"), domains: count(seats.domains, "seats.domains") },
  };
}

// The cap engine over the usage ledger: what has been used this UTC day and month, by the server and by each bot, in
// estimated dollars and in tokens, and which caps that use has reached. The open caps (`usageCaps`) and the licensed
// monthly budget (spend.ts) both read their totals here.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

import { directTurnKind } from "./agents-turn.ts";
import { isUsageRow, usageFileFor, usageRowKey, type UsageRow } from "./usage-ledger.ts";
import type { CapLimits, UsageCapsConfig } from "./usage-caps-config.ts";

export { usageCapsSchema, type CapLimits, type UsageCapsConfig } from "./usage-caps-config.ts";

export const CAP_WARN_PERCENT = 80;
const CACHE_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;

export type CapPeriod = "day" | "month";
export type CapUnit = "usd" | "tokens";
export type CapStops = "unattended" | "everything";

export const CAP_FIELDS = [
  { field: "dailyUsd", period: "day", unit: "usd", env: "OMB_USAGE_CAP_DAILY_USD" },
  { field: "monthlyUsd", period: "month", unit: "usd", env: "OMB_USAGE_CAP_MONTHLY_USD" },
  { field: "dailyTokens", period: "day", unit: "tokens", env: "OMB_USAGE_CAP_DAILY_TOKENS" },
  { field: "monthlyTokens", period: "month", unit: "tokens", env: "OMB_USAGE_CAP_MONTHLY_TOKENS" },
] as const satisfies ReadonlyArray<{ field: keyof CapLimits; period: CapPeriod; unit: CapUnit; env: string }>;
export const CAP_STOPS_ENV = "OMB_USAGE_CAP_STOPS";

export interface Used { usd: number; tokens: number }
export interface UsageTotals {
  month: string;
  day: string;
  server: Record<CapPeriod, Used>;
  bots: Map<string, Record<CapPeriod, Used>>;
}

type Entry = { at: string; botId: string; usd: number; tokens: number };
type Sums = { server: Record<CapPeriod, Used>; bots: Map<string, Record<CapPeriod, Used>> };
/** One month file as far as it was read: running sums for its month and for `day`, and how many bytes they cover. The
 * ledger only grows by whole lines, so a later look reads just what was appended, and only when the file changed. */
type Read = {
  at: number; day: string; month: string; size: number; mtimeMs: number; sums: Sums;
  /** Every row counted, by ledger key. */
  keys: Set<string>;
  /** Rows counted from memory when their append landed, which the file has not yet been read past. */
  fromMemory: Set<string>;
};
const cache = new Map<string, Read>();
// Rows whose async ledger append may not have landed yet: a long turn would otherwise re-read the month without its own row.
const unwritten = new Map<string, Map<string, Entry>>();

const positive = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The tokens a cap counts: fresh input plus output, the same sum the Usage page's bars show. */
export function capTokens(row: Pick<UsageRow, "input" | "output" | "cachedInput">): number {
  const input = positive(row.input);
  return Math.max(0, input - Math.min(positive(row.cachedInput), input)) + positive(row.output);
}

const entryOf = (row: Pick<UsageRow, "at" | "botId" | "costUsd" | "input" | "output" | "cachedInput">): Entry =>
  ({ at: row.at, botId: row.botId, usd: positive(row.costUsd), tokens: capTokens(row) });

export const dayKey = (now: Date): string => now.toISOString().slice(0, 10);
export const monthKeyOf = (now: Date): string => now.toISOString().slice(0, 7);

/** When the period that holds `now` rolls over, in UTC. */
export function periodEnd(period: CapPeriod, now: Date): number {
  return period === "day"
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

const zero = (): Record<CapPeriod, Used> => ({ day: { usd: 0, tokens: 0 }, month: { usd: 0, tokens: 0 } });

function addTo(sums: Sums, entry: Entry, month: string, day: string): void {
  if (!entry.at.startsWith(month)) return;
  const bot = sums.bots.get(entry.botId) ?? zero();
  sums.bots.set(entry.botId, bot);
  for (const used of entry.at.startsWith(day) ? [sums.server.month, bot.month, sums.server.day, bot.day] : [sums.server.month, bot.month]) {
    used.usd += entry.usd;
    used.tokens += entry.tokens;
  }
}

/** Counts the whole lines of `bytes`; returns how many bytes they span (a line still being written is left for later). */
function countLines(read: Read, bytes: Buffer): number {
  const end = bytes.lastIndexOf(10) + 1;
  for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isUsageRow(value)) continue;
    const key = usageRowKey(value);
    if (read.fromMemory.delete(key)) continue;
    read.keys.add(key);
    addTo(read.sums, entryOf(value), read.month, read.day);
  }
  return end;
}

function statOf(file: string): { size: number; mtimeMs: number } {
  try {
    const { size, mtimeMs } = statSync(file);
    return { size, mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

/** Reads the month file from the start. */
function readMonth(dataDir: string, now: Date): Read {
  const read: Read = { at: now.getTime(), day: dayKey(now), month: monthKeyOf(now), size: 0, mtimeMs: 0, sums: { server: zero(), bots: new Map() }, keys: new Set(), fromMemory: new Set() };
  const file = usageFileFor(dataDir, now);
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return read; }
  read.mtimeMs = statOf(file).mtimeMs;
  read.size = countLines(read, bytes);
  return read;
}

/** Brings a read up to date: nothing when the file is as it was, the appended bytes when it grew, all of it otherwise. */
function refresh(dataDir: string, read: Read, now: Date): Read {
  const file = usageFileFor(dataDir, now);
  const { size, mtimeMs } = statOf(file);
  read.at = now.getTime();
  if (size === read.size && mtimeMs === read.mtimeMs) return read;
  if (size < read.size) return readMonth(dataDir, now);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const bytes = Buffer.alloc(size - read.size);
    const got = readSync(fd, bytes, 0, bytes.length, read.size);
    read.size += countLines(read, bytes.subarray(0, got));
    read.mtimeMs = mtimeMs;
    return read;
  } catch {
    return readMonth(dataDir, now);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

export function usageTotals(dataDir: string, now = new Date()): UsageTotals {
  const month = monthKeyOf(now), day = dayKey(now);
  let read = cache.get(dataDir);
  if (!read || read.day !== day) read = readMonth(dataDir, now);
  else if (now.getTime() - read.at >= CACHE_MS) read = refresh(dataDir, read, now);
  cache.set(dataDir, read);
  const totals: UsageTotals = {
    month, day, server: { day: { ...read.sums.server.day }, month: { ...read.sums.server.month } },
    bots: new Map([...read.sums.bots].map(([botId, used]) => [botId, { day: { ...used.day }, month: { ...used.month } }])),
  };
  for (const [key, entry] of unwritten.get(dataDir) ?? []) if (!read.keys.has(key)) addTo(totals, entry, month, day);
  return totals;
}

/** Counts a booked row from memory until its append lands, so the next cap check already sees it. */
export function noteUsage(dataDir: string, row: Pick<UsageRow, "at" | "threadId" | "botId" | "costUsd" | "input" | "output" | "cachedInput">, written: Promise<boolean>): void {
  const entry = entryOf(row);
  if (!entry.usd && !entry.tokens) return;
  const key = usageRowKey(row);
  const entries = unwritten.get(dataDir) ?? new Map<string, Entry>();
  unwritten.set(dataDir, entries);
  entries.set(key, entry);
  void written.then((landed) => {
    entries.delete(key);
    if (entries.size === 0 && unwritten.get(dataDir) === entries) unwritten.delete(dataDir);
    const read = cache.get(dataDir);
    if (landed && read && !read.keys.has(key) && entry.at.startsWith(read.month)) {
      read.keys.add(key);
      read.fromMemory.add(key);
      addTo(read.sums, entry, read.month, read.day);
    }
  });
}

export function resetUsageTotalsForTests(): void {
  cache.clear();
  unwritten.clear();
}

/** One limit measured against its use: the arithmetic every cap shares. */
export function measure(limit: number, used: number, warnAtPercent = CAP_WARN_PERCENT): { percent: number; warn: boolean; reached: boolean } {
  const percent = Math.min(999, Math.round((used / limit) * 100));
  return { percent, warn: percent >= warnAtPercent, reached: used >= limit };
}

export interface CapState {
  /** `server:day:usd`, or `bot:<id>:month:tokens`: stable for one cap, whatever its limit. */
  id: string;
  scope: "server" | "bot";
  botId?: string;
  period: CapPeriod;
  unit: CapUnit;
  limit: number;
  used: number;
  percent: number;
  warn: boolean;
  reached: boolean;
  /** The UTC day or month the use was counted in. */
  periodKey: string;
  /** When that period rolls over and the cap counts from zero again. */
  resetsAt: number;
}

function numberFrom(raw: string | undefined, whole: boolean): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && (!whole || Number.isInteger(value)) ? value : undefined;
}

/** A headless server's caps: `OMB_USAGE_CAP_DAILY_USD`, `…_MONTHLY_USD`, `…_DAILY_TOKENS`, `…_MONTHLY_TOKENS` set the
 * server's caps and `OMB_USAGE_CAP_STOPS` what they stop. A value that is not a number is ignored. */
export function capsFromEnv(env: NodeJS.ProcessEnv = process.env): { stops?: CapStops; server: CapLimits } {
  const server: CapLimits = {};
  for (const { field, unit, env: name } of CAP_FIELDS) {
    const value = numberFrom(env[name], unit === "tokens");
    if (value !== undefined) server[field] = value;
  }
  const stops = env[CAP_STOPS_ENV]?.trim().toLowerCase();
  return { ...(stops === "unattended" || stops === "everything" ? { stops } : {}), server };
}

/** The caps in force: what the environment sets wins over `config.json`, field by field. */
export function effectiveCaps(saved: UsageCapsConfig | undefined, env: NodeJS.ProcessEnv = process.env): { stops: CapStops; server: CapLimits; bots: Record<string, CapLimits> } {
  const fromEnv = capsFromEnv(env);
  return { stops: fromEnv.stops ?? saved?.stops ?? "unattended", server: { ...saved?.server, ...fromEnv.server }, bots: saved?.bots ?? {} };
}

function statesOf(scope: "server" | "bot", botId: string | undefined, limits: CapLimits | undefined, used: Record<CapPeriod, Used> | undefined, now: Date): CapState[] {
  const states: CapState[] = [];
  for (const { field, period, unit } of CAP_FIELDS) {
    const limit = limits?.[field];
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) continue;
    const spent = used?.[period][unit] ?? 0;
    states.push({
      id: `${scope === "bot" ? `bot:${botId}` : "server"}:${period}:${unit}`, scope, ...(botId ? { botId } : {}), period, unit, limit, used: spent,
      ...measure(limit, spent), periodKey: period === "day" ? dayKey(now) : monthKeyOf(now), resetsAt: periodEnd(period, now),
    });
  }
  return states;
}

/** Every cap that is set, with its use now. `botId` narrows it to the caps that count that bot's work. */
export function capStates(saved: UsageCapsConfig | undefined, dataDir: string, now = new Date(), env: NodeJS.ProcessEnv = process.env, botId?: string): CapState[] {
  const caps = effectiveCaps(saved, env);
  const bots = Object.entries(caps.bots).filter(([id]) => botId === undefined || id === botId);
  if (!bots.length && !CAP_FIELDS.some(({ field }) => (caps.server[field] ?? 0) > 0)) return [];
  const totals = usageTotals(dataDir, now);
  return [...statesOf("server", undefined, caps.server, totals.server, now), ...bots.flatMap(([id, limits]) => statesOf("bot", id, limits, totals.bots.get(id), now))];
}

/** The reached cap that keeps this work from starting, or null. A person's own message is stopped only by `everything`.
 * Of several reached caps, the one that resets last: the work cannot start before it does. */
export function reachedCap(saved: UsageCapsConfig | undefined, dataDir: string, work: { botId?: string; personWaiting: boolean }, now = new Date(), env: NodeJS.ProcessEnv = process.env): CapState | null {
  if (work.personWaiting && effectiveCaps(saved, env).stops !== "everything") return null;
  const reached = capStates(saved, dataDir, now, env, work.botId ?? "").filter((state) => state.reached);
  return reached.sort((a, b) => b.resetsAt - a.resetsAt)[0] ?? null;
}

/** What the harness already knows of the conversation a turn runs in. */
export interface ThreadStanding {
  /** Marked unattended by the turn that last ran there. */
  unattended: boolean;
  /** The trigger of the request the conversation is working on, when a routine, webhook, app event or API call started it. */
  automation: string | undefined;
  /** Whether that request traces to a person's own typed line. */
  origin: "user" | "outside" | undefined;
}

/** Whether a person is waiting on this turn. Their own message always is. A run started by hand is; a routine, webhook,
 * app event or Bot API call is not. A hand-off counts as theirs when it traces to a person's own typed line, and a
 * continuation when the conversation it continues is not an automation's. */
export function personWaiting(turn: Parameters<typeof directTurnKind>[0] & { origin?: { kind: "user" | "outside" } }, thread: ThreadStanding): boolean {
  const kind = directTurnKind(turn);
  if (kind === "person") return true;
  if (kind === "routine") return turn.automationSource === "manual";
  if (kind === "webhook" || kind === "api") return false;
  if (turn.unattended || (turn.peerAsk as { unattended?: boolean } | undefined)?.unattended || thread.unattended) return false;
  if (kind === "handoff") return (turn.origin?.kind ?? thread.origin) === "user";
  return thread.automation === undefined || thread.automation === "manual";
}

/** A room turn: a person is waiting unless the run is known to have been started by something else (a webhook's or
 * the API's line, work handed on from outside), or it is a routine's own run that nobody started by hand. */
export function personWaitingInRoom(run: { personStarted?: boolean } | undefined, routineTrigger: string | undefined): boolean {
  return run?.personStarted !== false && (routineTrigger === undefined || routineTrigger === "manual");
}

// The cap engine over the usage ledger: what has been used this UTC day and month, by the server and by each bot, in
// estimated dollars and in tokens, and which caps that use has reached. The open caps (`usageCaps`) and the licensed
// monthly budget (spend.ts) both read their totals here.
import { directTurnKind } from "./agents-turn.ts";
import { readUsage, usageRowKey, type UsageRow } from "./usage-ledger.ts";
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
const cache = new Map<string, { at: number; day: string; rows: Entry[]; keys: Set<string> }>();
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

export function usageTotals(dataDir: string, now = new Date()): UsageTotals {
  const month = monthKeyOf(now), day = dayKey(now);
  let read = cache.get(dataDir);
  if (!read || read.day !== day || now.getTime() - read.at >= CACHE_MS) {
    const rows = readUsage(dataDir, { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now });
    read = { at: now.getTime(), day, rows: rows.map(entryOf), keys: new Set(rows.map(usageRowKey)) };
    cache.set(dataDir, read);
  }
  const totals: UsageTotals = { month, day, server: { day: { usd: 0, tokens: 0 }, month: { usd: 0, tokens: 0 } }, bots: new Map() };
  const add = (entry: Entry) => {
    if (!entry.at.startsWith(month)) return;
    const bot = totals.bots.get(entry.botId) ?? { day: { usd: 0, tokens: 0 }, month: { usd: 0, tokens: 0 } };
    totals.bots.set(entry.botId, bot);
    for (const used of entry.at.startsWith(day) ? [totals.server.month, bot.month, totals.server.day, bot.day] : [totals.server.month, bot.month]) {
      used.usd += entry.usd;
      used.tokens += entry.tokens;
    }
  };
  for (const entry of read.rows) add(entry);
  for (const [key, entry] of unwritten.get(dataDir) ?? []) if (!read.keys.has(key)) add(entry);
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
    if (landed && read && !read.keys.has(key) && entry.at.startsWith(read.day.slice(0, 7))) {
      read.rows.push(entry);
      read.keys.add(key);
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

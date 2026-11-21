// A Cloud home's health for the Admin's signed poll (server/routes/cloud-signed.ts). Privacy invariant: the report carries
// only fixed codes, counts, times, versions, engine kinds, random ids, connector slugs, booleans and machine numbers. Never
// a failure's words, a bot's name, a thread's title, a prompt, a URL, an address, a token or an engine's account.
import { accessSync, constants, readFileSync, statfsSync } from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { PLACE_STATES } from "../shared/place-view.ts";
import { trialCreditKind } from "../shared/trial-credit.ts";
import type { BoxReport } from "./bot-box/box.ts";
import type { RoomReport } from "./engine-memory.ts";
import type { FirstHourReport } from "./host/first-hour.ts";
import type { ValueReport } from "./host/value-ledger.ts";
import type { ProviderSnapshot, RuntimeEvent } from "./contracts.ts";
import { createCloudSpeed, type CloudSpeed } from "./cloud-speed.ts";
import { doctorSummary } from "./doctor/start.ts";
import { classifyError } from "./drivers/retry.ts";
import type { PerfHealth } from "./perf/perf-report.ts";
import type { RoutineHealth } from "./routine-health.ts";
import type { ScheduleSection } from "./routine-schedule-report.ts";
import type { Message, StoreChange } from "./store.ts";

/** The report's largest JSON body; incidents past it wait for the next poll. */
export const CLOUD_HEALTH_MAX_BYTES = 64 * 1024;
export const HEALTH_BUCKET_CAP = 200;
const ROUTINE_CAP = 100, CONNECTOR_CAP = 100, THREAD_CAP = 2_000, PENDING_CAP = 500;
/** A failed row waits this long for its turn's stop reason before it is filed under its own cause. */
const PENDING_SETTLE_MS = 5_000;
/** A turn that ends in an engine stop with no failed row of its own counts once, unless its thread just wrote one. */
const ROW_DEDUPE_MS = 60_000;
const CONNECTORS_TTL_MS = 30 * 60_000, LOOKUP_TIMEOUT_MS = 30_000;
const MINUTE = 60_000, WINDOW_15M = 15, WINDOW_24H = 24 * 60;

const CODE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[\w.+-]{1,64}$/;
const IMAGE = /^[\w./:@+-]{1,300}$/;
const match = (pattern: RegExp, value: unknown): string | null => typeof value === "string" && pattern.test(value) ? value : null;

/** Stop reasons a driver settles a failed turn with. Free text never becomes a code. */
const STOP_CODES = new Set(["auth_required", "rpc_error", "shutdown_timeout", "provider_safety", "update_required", "spawn_error", "quota",
  "tool_error", "exit_before_result", "error_during_execution", "error", "failed"]);
/** Stops that say only that something failed: the cause's own class, when known, says more. */
const GENERIC_STOPS = new Set(["rpc_error", "error", "failed", "error_during_execution", "exit_before_result"]);
/** Engine stops that count as a failure even when no failed row was written for them. */
const ROWLESS_STOPS = new Set(["shutdown_timeout", "auth_required", "update_required", "spawn_error", "rpc_error"]);
/** Causes the server writes itself, by fixed code. */
const FIXED_CAUSES: ReadonlyArray<[RegExp, string]> = [
  [/ran out of memory while \d+ tasks? ran at once/, "out_of_memory"],
  [/^Ran out of room, so I (closed the browser|stopped this task) to keep everything else running\./, "out_of_memory"],
  [/^no activity for \d+ minutes — the turn was stopped$/, "stalled"],
  [/^turn interrupted — OpenMausBot restarted$/, "restart"],
  [/could not start — /, "could_not_start"],
  [/^the problem report could not reach /, "incident_undelivered"],
  [/^could not deliver approval to the provider/, "approval_undelivered"],
  [/^Canonical event history is incomplete/, "event_log"],
];
const PLACES: ReadonlySet<string> = new Set(PLACE_STATES);

export type HealthIncidentKind = "turn" | "place";
export interface HealthIncident {
  kind: HealthIncidentKind; code: string; engine: string | null;
  count: number; firstAt: number; lastAt: number; botId: string | null; threadId: string | null; seq: number;
}
export type { RoutineHealth };
export interface TurnRates { started15m: number; failed15m: number; started24h: number; failed24h: number }
interface Pending { at: number; botId: string | null; engine: string | null; fallback: string }

/** A cause the server words itself, or the trial credit's refusal: its code needs no stop reason. */
export function fixedCode(cause: string): string | null {
  for (const [pattern, code] of FIXED_CAUSES) if (pattern.test(cause)) return code;
  const trial = trialCreditKind(cause);
  return trial ? `trial_${trial}` : null;
}

export const classifiedCode = (cause: string): string => match(CODE, classifyError({ text: cause }).reason) ?? "unknown";

/** A specific stop reason wins; a generic one only when the cause has no known class. */
export function stoppedCode(stopReason: string | null | undefined, fallback: string): string {
  const stop = stopReason && STOP_CODES.has(stopReason) ? stopReason : null;
  if (stop && !GENERIC_STOPS.has(stop)) return stop;
  return fallback !== "unknown" ? fallback : stop ?? "unknown";
}

const remember = <K, V>(map: Map<K, V>, key: K, value: V, cap: number) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value as K);
};

/**
 * Failed turns since boot, bucketed by kind, code and engine. Fed by one tap on the store (every failed-turn row, the one
 * place they are written) and the runtime bus (turn starts, stop reasons, engine kinds).
 */
export function createCloudHealthLedger(options: { botOf?: (threadId: string) => string | null; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const bootedAt = now();
  let seq = 0;
  const buckets = new Map<string, HealthIncident>();
  const pending = new Map<string, Pending>();
  const lastRowAt = new Map<string, number>();
  const engines = new Map<string, string>();
  const minutes = new Map<number, { started: number; failed: number }>();

  const tally = (at: number, field: "started" | "failed") => {
    const minute = Math.floor(at / MINUTE);
    const slot = minutes.get(minute) ?? { started: 0, failed: 0 };
    slot[field] += 1;
    minutes.set(minute, slot);
    for (const key of minutes.keys()) if (key <= Math.floor(now() / MINUTE) - WINDOW_24H) minutes.delete(key);
  };
  const record = (kind: HealthIncidentKind, code: string, engine: string | null, at: number, botId: string | null, threadId: string | null) => {
    const key = `${kind}\u0000${code}\u0000${engine ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= HEALTH_BUCKET_CAP) {
        const oldest = [...buckets.entries()].reduce((a, b) => (b[1].lastAt < a[1].lastAt ? b : a));
        buckets.delete(oldest[0]);
      }
      bucket = { kind, code, engine, count: 0, firstAt: at, lastAt: at, botId: null, threadId: null, seq: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.firstAt = Math.min(bucket.firstAt, at);
    bucket.lastAt = Math.max(bucket.lastAt, at);
    bucket.botId = match(ID, botId);
    bucket.threadId = match(ID, threadId);
    bucket.seq = ++seq;
    tally(at, "failed");
  };
  const settle = (threadId: string, stopReason?: string | null) => {
    const row = pending.get(threadId);
    if (!row) return;
    pending.delete(threadId);
    record("turn", stoppedCode(stopReason, row.fallback), row.engine, row.at, row.botId, threadId);
  };
  const settleStale = () => {
    const before = now() - PENDING_SETTLE_MS;
    for (const [threadId, row] of pending) if (row.at <= before) settle(threadId);
  };

  return {
    bootedAt,
    /** Every message the store appends; only failed-turn rows count. */
    noteMessage(threadId: string, message: Pick<Message, "at" | "tool" | "from">) {
      const cause = message.tool?.ok === false ? failedTurnCause(message.tool.name) : null;
      if (cause === null) return;
      settle(threadId);
      const botId = message.from?.botId ?? options.botOf?.(threadId) ?? null, engine = engines.get(threadId) ?? null;
      remember(lastRowAt, threadId, message.at, THREAD_CAP);
      const place = message.tool?.place?.state;
      if (place && PLACES.has(place)) return record("place", place, engine, message.at, botId, threadId);
      const fixed = fixedCode(cause);
      if (fixed) return record("turn", fixed, engine, message.at, botId, threadId);
      if (pending.size >= PENDING_CAP) settle(pending.keys().next().value as string);
      pending.set(threadId, { at: message.at, botId, engine, fallback: classifiedCode(cause) });
    },
    noteEvent(event: RuntimeEvent) {
      if (event.type === "turn.started") {
        settle(event.threadId);
        const kind = match(KIND, event.provider);
        if (kind) remember(engines, event.threadId, kind, THREAD_CAP);
        tally(now(), "started");
      } else if (event.type === "turn.completed") {
        if (pending.has(event.threadId)) return settle(event.threadId, event.stopReason);
        if (event.ok || !event.stopReason || !ROWLESS_STOPS.has(event.stopReason)) return;
        const at = now();
        if (at - (lastRowAt.get(event.threadId) ?? -Infinity) < ROW_DEDUPE_MS) return;
        remember(lastRowAt, event.threadId, at, THREAD_CAP);
        record("turn", event.stopReason, engines.get(event.threadId) ?? match(KIND, event.provider), at, options.botOf?.(event.threadId) ?? null, event.threadId);
      }
    },
    /** Buckets changed after `after` (a cursor from an earlier read of this boot; anything else reads from the start), oldest change first. */
    read(after: string | null | undefined) {
      settleStale();
      const cursor = /^(\d{1,15})\.(\d{1,15})$/.exec(after ?? "");
      const since = cursor && Number(cursor[1]) === bootedAt && Number(cursor[2]) <= seq ? Number(cursor[2]) : 0;
      const incidents = [...buckets.values()].filter((bucket) => bucket.seq > since).sort((a, b) => a.seq - b.seq).map((bucket) => ({ ...bucket }));
      const current = Math.floor(now() / MINUTE);
      const turns: TurnRates = { started15m: 0, failed15m: 0, started24h: 0, failed24h: 0 };
      for (const [minute, slot] of minutes) {
        if (minute <= current - WINDOW_24H) continue;
        turns.started24h += slot.started; turns.failed24h += slot.failed;
        if (minute > current - WINDOW_15M) { turns.started15m += slot.started; turns.failed15m += slot.failed; }
      }
      return { since, seq, incidents, turns };
    },
    cursor: (at: number) => `${bootedAt}.${at}`,
  };
}
export type CloudHealthLedger = ReturnType<typeof createCloudHealthLedger>;

/** A lookup that may be slow (a provider call): the last answer at once, refreshed in the background when stale. */
function backgroundLookup<T>(load: () => Promise<T> | null, ttlMs: number, now: () => number) {
  let value: T | null = null, checkedAt: number | null = null, failed = false, running = false;
  return () => {
    if (!running && (checkedAt === null || now() - checkedAt >= ttlMs)) {
      const started = load();
      if (started) {
        running = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS); timer.unref?.(); });
        void Promise.race([started, timeout]).then((answer) => { value = answer; failed = false; }, () => { failed = true; })
          .finally(() => { clearTimeout(timer); checkedAt = now(); running = false; });
      }
    }
    return { value, checkedAt, failed };
  };
}

function memoryBytes(): { totalBytes: number; availableBytes: number } {
  const totalBytes = totalmem();
  try {
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
    if (available) return { totalBytes, availableBytes: Number(available) * 1024 };
  } catch {}
  return { totalBytes, availableBytes: freemem() };
}

function diskBytes(dir: string): { totalBytes: number; freeBytes: number } | null {
  try {
    const stats = statfsSync(dir);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch { return null; }
}

function writable(dir: string): boolean {
  try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
}

export interface CloudHealthDeps {
  store: { onChange(listener: (change: StoreChange) => void): () => void; botByThread(threadId: string): { id: string } | null; bots: ReadonlyArray<{ modelSelection?: { instanceId: string } }> };
  bus: { subscribe(listener: (event: RuntimeEvent) => void): () => void };
  engines: () => ReadonlyArray<{ instanceId: string; driverKind: string; snapshot: ProviderSnapshot | undefined }>;
  dataDir: string;
  eventsDir: string;
  version: string;
  image: string | undefined;
  /** Null when connected apps are not set up here. */
  connectors: () => Promise<Record<string, { connected: boolean; pending?: boolean }>> | null;
  browser: () => { available: boolean; installing: boolean; interrupted: number };
  /** The bot box (server/bot-box): whether turns run boxed here, and the last self-check's count. */
  box?: () => BoxReport;
  /** A personal Cloud's milestones since its first boot, and the work its Chief did: times and counts only. */
  firstHour?: () => { firstHour?: FirstHourReport; value?: ValueReport };
  /** The last day's memory pressure (engine-memory.ts), where this home watches it. */
  room?: () => RoomReport;
  /** Each routine's newest ended run and its failures in a row, from the saved run rows (routine-health.ts), at most `cap`. */
  routines?: (cap: number) => RoutineHealth[];
  /** What is due, what has not started and what last did (routine-schedule-report.ts), read from the scheduler each time; null while there is none. */
  schedule?: () => ScheduleSection | null;
  /** CPU steal and pressure, boot and wake times, and how long messages wait for their engine. */
  speed?: CloudSpeed;
  /** Turn phase timings, usage-limit holds, process buckets and event-loop lag: at most PERF_HEALTH_MAX_BYTES. A throw
   * reads as null: the Admin restarts a home whose health read fails, so this optional part never fails it. */
  perf?: () => PerfHealth | null;
  log?: (line: string) => void;
  now?: () => number;
}

/** Fixed codes and counts only: the box kind, why it is off, and the self-check's `passed/total` with the failed check ids. */
export function boxSummary(report: BoxReport | undefined): { box: BoxReport["box"]; reason: BoxReport["reason"]; checks: string | null; failed: string[]; boxed: number; refused: BoxReport["refused"]; broker: BoxReport["broker"]; hardening: BoxReport["hardening"] } | null {
  if (!report) return null;
  const failed = report.checks?.failed.filter((id) => CODE.test(id)).slice(0, 50) ?? [];
  const broker = { ...report.broker, unbrokered: report.broker.unbrokered.filter((name) => KIND.test(name)).slice(0, 50) };
  return { box: report.box, reason: report.reason, checks: report.checks ? `${report.checks.passed}/${report.checks.total}` : null, failed, boxed: report.boxed, refused: report.refused, broker, hardening: report.hardening };
}

/** The doctor's last run, as fixed codes and counts. */
function doctorHealth() {
  const summary = doctorSummary();
  if (!summary) return null;
  const ids = (list: string[]) => list.filter((id) => CODE.test(id)).slice(0, 20);
  return { at: Date.parse(summary.at) || null, version: match(VERSION, summary.version), checked: summary.checked, fixed: ids(summary.fixed), problems: ids(summary.problems), thisStart: summary.thisStart };
}

/** What the scheduler says of itself, or `fallback` when asking it throws: the rest of the report is still answered. The log names no cause, which could quote a routine. */
function guarded<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { console.error("cloud health: the scheduler's part of the report could not be read"); return fallback; }
}

/** The report's body, at most CLOUD_HEALTH_MAX_BYTES of JSON. */
export function createCloudHealth(deps: CloudHealthDeps) {
  const now = deps.now ?? Date.now;
  const ledger = createCloudHealthLedger({ botOf: (threadId) => deps.store.botByThread(threadId)?.id ?? null, now });
  const speed = deps.speed ?? createCloudSpeed({ now });
  deps.store.onChange((change) => { if (change.type === "message") { ledger.noteMessage(change.threadId, change.message); speed.noteMessage(change.threadId, change.message); } });
  deps.bus.subscribe((event) => { ledger.noteEvent(event); speed.noteEvent(event); });
  const connectors = backgroundLookup(deps.connectors, CONNECTORS_TTL_MS, now);
  const version = match(VERSION, deps.version) ?? "unknown", image = match(IMAGE, deps.image);
  let perfWarnedAt = -Infinity;
  const perf = () => {
    try { return deps.perf?.() ?? null; } catch (error) {
      if (now() - perfWarnedAt >= 60_000) { perfWarnedAt = now(); (deps.log ?? console.warn)(`cloud health: perf left out: ${error instanceof Error ? error.name : "error"}`); }
      return null;
    }
  };

  const engines = () => {
    const used = new Set(deps.store.bots.flatMap((bot) => bot.modelSelection ? [bot.modelSelection.instanceId] : []));
    return deps.engines().flatMap(({ instanceId, driverKind, snapshot }) => {
      const kind = match(KIND, driverKind);
      return kind ? [{ kind, used: used.has(instanceId), available: snapshot ? snapshot.state === "available" : null,
        authenticated: typeof snapshot?.authenticated === "boolean" ? snapshot.authenticated : null, version: match(VERSION, snapshot?.version) }] : [];
    });
  };
  const connectorState = () => {
    const { value, checkedAt, failed } = connectors();
    if (checkedAt === null && value === null) return null;
    const items = Object.entries(value ?? {}).flatMap(([slug, state]) => match(KIND, slug) && !state.pending ? [{ slug, connected: state.connected === true }] : []);
    return { checkedAt, failed, items: items.slice(0, CONNECTOR_CAP) };
  };

  return {
    ledger,
    speed,
    report(after: string | null | undefined) {
      const read = ledger.read(after);
      const memory = memoryBytes(), browser = deps.browser(), first = deps.firstHour?.();
      const base = {
        v: 1 as const, version, image, bootedAt: ledger.bootedAt, at: now(),
        turns: read.turns, routines: guarded(() => deps.routines?.(ROUTINE_CAP) ?? [], []).filter((routine) => match(ID, routine.routineId)), schedule: guarded(() => deps.schedule?.() ?? null, null),
        engines: engines(), connectors: connectorState(),
        browser: { available: browser.available, installing: browser.installing, interrupted: browser.interrupted },
        box: boxSummary(deps.box?.()),
        firstHour: first?.firstHour ?? null, value: first?.value ?? null, room: deps.room?.() ?? null, speed: speed.report(), perf: perf(),
        // The data checks of this version's first start: check ids and counts (server/doctor/start.ts).
        doctor: doctorHealth(),
        system: { ...memory, rssBytes: process.memoryUsage.rss(), load1: loadavg()[0] ?? 0, cpus: availableParallelism(), disk: diskBytes(deps.dataDir), eventLogWritable: writable(deps.eventsDir) },
      };
      let budget = CLOUD_HEALTH_MAX_BYTES - JSON.stringify({ ...base, cursor: ledger.cursor(read.seq), truncated: true, incidents: [] }).length;
      const incidents: HealthIncident[] = [];
      for (const incident of read.incidents) {
        budget -= JSON.stringify(incident).length + 1;
        if (budget < 0) break;
        incidents.push(incident);
      }
      const truncated = incidents.length < read.incidents.length;
      return { ...base, cursor: ledger.cursor(truncated ? incidents.at(-1)?.seq ?? read.since : read.seq), truncated, incidents };
    },
  };
}
export type CloudHealth = ReturnType<typeof createCloudHealth>;

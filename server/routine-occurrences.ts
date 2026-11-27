// Keeps the occurrence ledger (routine-ledger.ts) in step with the run rows. Every save of routines.json hands its rows
// here, and each scheduled row's record is made again from the row and the record before it: the row says what
// happened, the record remembers how often the occurrence started and when it first did. An occurrence's key is what
// makes its start happen once: the scheduler asks `decided` before it makes a row for an occurrence and
// `startedElsewhere` before it starts one, and a start is written and flushed here before its turn begins.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { ROUTINE_SUPERSEDED } from "./routine-execution.ts";
import { occurrenceEnded, occurrenceLastAt, RoutineLedger, type Occurrence, type OccurrenceLease, type OccurrenceReason, type OccurrenceState } from "./routine-ledger.ts";
import type { Routine, RoutineRun } from "./routines.ts";

/** How long a started occurrence's lease lasts without being renewed, and how often it is renewed while its run lives. */
export const LEASE_MS = 3 * 60_000;
export const LEASE_BEAT_MS = 60_000;
/** A first start later than this after the scheduled time counts as late. */
export const LATE_START_MS = 5 * 60_000;
export const ROUTINE_TURN_GONE = "its turn ended without reporting back";
/** How many scheduler passes a start is held back for a ledger that cannot be written, before it starts unrecorded. */
export const UNRECORDED_START_PASSES = 3;

export interface OccurrenceCounts { ran: number; failed: number; missed: number; late: number; retried: number }

type Row = Pick<RoutineRun, "id" | "routineId" | "scheduledFor" | "status" | "manual" | "triggerSource" | "checkKey" | "webhookId" | "startedAt" | "finishedAt" | "createdAt" |
  "retried" | "skipped" | "error" | "errorCode" | "errorParams" | "attentionCode">;
type Scheduled = Pick<Routine, "id" | "enabled" | "nextRunAt" | "updatedAt">;

/** A run its schedule started (its checks included): not one a person, a start-up or an outside event started. */
export const isScheduledRun = (run: Pick<RoutineRun, "manual" | "triggerSource">): boolean => (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule";

/** A run row made for a scheduled occurrence: not one a person, a start-up, an event or a routine's checks made. */
export const isOccurrenceRun = (run: Pick<RoutineRun, "manual" | "triggerSource" | "checkKey" | "webhookId">): boolean =>
  isScheduledRun(run) && run.checkKey === undefined && run.webhookId === undefined;

const ACTIVE = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);
const signature = (run: Row) => [run.status, run.startedAt, run.finishedAt, run.attentionCode, run.errorCode, run.error === undefined ? "" : run.error.length, run.skipped?.count, run.skipped?.lastAt].join("|");

/** How often the occurrence has started, from its record and what its row says now. A start the server took back, or
 * its bot refused as busy, was no attempt. */
function starts(run: Row, before: Occurrence | undefined): Pick<Occurrence, "attempts" | "startedAt" | "lastStartAt"> {
  const busyOnly = run.errorCode === "routines.server.stillBusy" || run.errorCode === "routines.server.busyTooLong";
  if (!before) {
    if (run.startedAt == null || busyOnly) return { attempts: 0 };
    return { attempts: run.retried !== undefined && run.status !== "queued" ? 2 : 1, startedAt: run.startedAt, ...(run.status === "queued" ? {} : { lastStartAt: run.startedAt }) };
  }
  const { startedAt, lastStartAt } = before;
  const refused = run.status === "queued" ? run.startedAt == null || run.attentionCode === "routines.server.waitingToStart" : busyOnly;
  if (run.status === "queued" || (refused && lastStartAt !== undefined)) {
    const attempts = refused && lastStartAt !== undefined ? Math.max(0, before.attempts - 1) : before.attempts;
    return { attempts, ...(attempts > 0 && startedAt !== undefined ? { startedAt } : {}) };
  }
  const startedNow = run.status === "running" ? run.startedAt !== lastStartAt : before.attempts === 0 && (run.status === "waiting" || run.status === "completed");
  if (run.startedAt != null && startedNow) return { attempts: before.attempts + 1, startedAt: startedAt ?? run.startedAt, lastStartAt: run.startedAt };
  return { attempts: before.attempts, ...(startedAt === undefined ? {} : { startedAt }), ...(lastStartAt === undefined ? {} : { lastStartAt }) };
}

function stateOf(run: Row, attempts: number): OccurrenceState {
  if (run.status === "queued") return attempts > 0 ? "running" : "queued";
  if (run.status === "running" || run.status === "waiting") return "running";
  if (run.status === "completed") return "ran";
  if (run.skipped) return run.skipped.behind.startsWith("down:") ? "missed" : "skipped";
  if (String(run.errorParams?.why ?? "").endsWith("heldUp")) return "skipped";
  return attempts > 0 ? "failed" : run.status === "cancelled" ? "skipped" : "missed";
}

function reasonOf(run: Row, state: OccurrenceState): OccurrenceReason | undefined {
  if (state === "queued" || state === "running" || state === "ran") return undefined;
  const behind = run.skipped?.behind, code = run.errorCode, why = String(run.errorParams?.why ?? "");
  if (behind?.startsWith("late:") || why.endsWith("heldUp")) return "scheduler-late";
  if (behind) return behind.startsWith("no-start:") ? "computer-no-start" : behind.startsWith("down:cloud") ? "cloud-down" : behind.startsWith("down:") ? "computer-off" : behind.startsWith("restored:") ? "restored" : "previous-run-active";
  if (code === "routines.server.missedTooLate" || code === "routines.server.missedOne" || code === "routines.server.missedMany") return why.endsWith("cloudDown") ? "cloud-down" : "computer-off";
  if (code === "routines.server.busyTooLong" || code === "routines.server.stillBusy") return "bot-busy";
  if (code === "routines.server.overLimit") return "run-limit";
  if (code === "routines.server.restored") return "restored";
  if (run.error === ROUTINE_SUPERSEDED) return "superseded";
  if (String(run.errorParams?.failure ?? run.error ?? "").includes(ROUTINE_TURN_GONE)) return "turn-gone";
  if (run.status === "cancelled") return "cancelled";
  return state === "failed" ? "failed" : "not-started";
}

/** The record with nothing in it after `end`: a span is shortened to there, and one that begins later is void. */
function cutAt(record: Occurrence, end: number): Occurrence {
  const { count, lastAt, ...rest } = record, last = Math.min(lastAt ?? record.dueAt, end);
  const ended = { ...rest, cut: end, ...(record.endedAt === undefined ? {} : { endedAt: Math.min(record.endedAt, Math.max(0, end)) }) };
  if (record.dueAt > end) return { ...ended, void: true };
  const kept = count === undefined || lastAt === undefined || lastAt <= record.dueAt ? 1 : Math.max(1, Math.round(count * (last - record.dueAt) / (lastAt - record.dueAt)));
  return kept > 1 && last > record.dueAt ? { ...ended, count: kept, lastAt: last } : ended;
}

function recordOf(run: Row, before: Occurrence | undefined, now: number, holder: Omit<OccurrenceLease, "until">): Occurrence {
  const started = starts(run, before), state = stateOf(run, started.attempts), reason = reasonOf(run, state);
  const held = run.status === "running" || run.status === "waiting";
  const lease = !held ? undefined : before?.lease?.boot === holder.boot ? before.lease : { ...holder, until: now + LEASE_MS };
  const record: Occurrence = {
    routineId: run.routineId, dueAt: before?.dueAt ?? run.skipped?.firstAt ?? run.scheduledFor, state, ...(reason ? { reason } : {}), ...started,
    madeAt: before?.madeAt ?? run.createdAt, ...(ACTIVE.has(run.status) ? {} : { endedAt: run.finishedAt ?? now }),
    ...(run.skipped && run.skipped.count > 1 ? { count: run.skipped.count, lastAt: run.skipped.lastAt } : {}),
    runIds: before?.runIds.includes(run.id) ? before.runIds : [run.id], ...(lease ? { lease } : {}),
  };
  if (ACTIVE.has(run.status) || started.attempts > 0) return record;
  // A row closed without starting says nothing about a time after the one it was cut at, or, read with no record, after now.
  const cut = before ? before.cut : now;
  return cut !== undefined && (before?.cut !== undefined || occurrenceLastAt(record) > cut) ? cutAt(record, cut) : record;
}

/** Field by field, whatever order they are in: a record read back from the file lists them in its own. */
const ordered = (record: Occurrence) => JSON.stringify(Object.entries(record).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : 1));
const same = (a: Occurrence, b: Occurrence) => ordered(a) === ordered(b);
const machineName = (value: string | undefined) => (value ?? hostname()).replace(/[^\w:-]/g, "-").slice(0, 64) || "local";

export class Occurrences {
  readonly ledger: RoutineLedger;
  /** Since this process started. */
  readonly counts: OccurrenceCounts = { ran: 0, failed: 0, missed: 0, late: 0, retried: 0 };
  /** Occurrences that already had a record and were not made or started a second time, since this process started. */
  duplicates = 0;
  /** After a restore from a backup: until when the schedule it replaced had been alive. Null otherwise. */
  restoredThrough: number | null;
  private readonly holder: Omit<OccurrenceLease, "until">;
  private readonly now: () => number;
  private readonly signatures = new Map<string, string>();
  private rowIds = new Set<string>();
  private fingerprint: string | undefined;
  private unreadable = false;
  /** The ledger cannot be written, and runs start without it: routines.json alone keeps a run from starting twice. */
  degraded = false;
  private failing = false;
  private refused = 0;
  private held: { version: number; records: Occurrence[] } = { version: -1, records: [] };

  constructor(routinesFile: string, now: () => number, machine?: string) {
    this.now = now;
    this.holder = { machine: machineName(machine), boot: randomUUID() };
    this.ledger = new RoutineLedger(routinesFile, now);
    this.restoredThrough = this.ledger.open().restoredThrough;
  }

  /** Works out every scheduled row's record from the rows about to be saved. A change that holds a start is written at
   * once, before the turn begins; any other by the function returned, which the caller runs once routines.json itself
   * is saved, so the ledger never says more than the rows do. A write that fails is logged once and made again with
   * the next save: it never fails the save, or the start. `counting` false at start, when the rows are older than this
   * process and nothing they say happened in it. */
  observe(routines: readonly Scheduled[], runs: readonly Row[], counting = true): () => void {
    this.trim();
    const now = this.now(), rows = runs.filter(isOccurrenceRun), ids = new Set(rows.map((run) => run.id));
    const put = new Map<string, { before: Occurrence | undefined; after: Occurrence }>(), seen = new Map<string, string>();
    let starting = false;
    // Rows that count skipped occurrences come last: a row that ran keeps the record of its own time.
    for (const run of [...rows.filter((row) => !row.skipped), ...rows.filter((row) => row.skipped)]) {
      const mark = signature(run);
      if (this.signatures.get(run.id) === mark) continue;
      seen.set(run.id, mark);
      const before = this.ledger.ofRun(run.id);
      if (!before) {
        const dueAt = run.skipped?.firstAt ?? run.scheduledFor, key = `${run.routineId}\n${dueAt}`;
        const taken = put.get(key)?.after ?? this.standing(run.routineId, dueAt);
        // A second row for an occurrence that has its record gets none of its own, and is never started.
        if (taken && (put.has(key) || !this.unclaimed(taken, ids))) continue;
      }
      const after = recordOf(run, before, now, this.holder);
      if (before && same(before, after)) continue;
      if (counting && run.status === "running" && after.attempts > (before?.attempts ?? 0)) starting = true;
      put.set(`${after.routineId}\n${after.dueAt}`, { before, after });
    }
    const remove: Occurrence[] = [];
    for (const record of this.ledger.all()) {
      if (occurrenceEnded(record) || record.runIds.some((id) => ids.has(id)) || put.has(`${record.routineId}\n${record.dueAt}`)) continue;
      // Its row is gone. One that never started was never saved and is dropped; one that started stays decided.
      if (record.attempts === 0) remove.push(record);
      else put.set(`${record.routineId}\n${record.dueAt}`, { before: record, after: { ...record, state: "failed", reason: "cancelled", endedAt: now, lease: undefined } });
    }
    const fingerprint = routines.map((routine) => `${routine.id}:${routine.enabled ? 1 : 0}:${routine.nextRunAt}:${routine.updatedAt}`).join(",");
    // At start the routines are as the last process left them: with no record to change, nothing is written.
    if (put.size === 0 && remove.length === 0 && (fingerprint === this.fingerprint || !counting)) { this.rowIds = ids; this.fingerprint = fingerprint; return () => {}; }
    const write = () => {
      try { this.ledger.write([...put.values()].map(({ after }) => JSON.parse(JSON.stringify(after)) as Occurrence), remove); }
      catch (error) { return this.failed(error); }
      this.written();
      this.rowIds = ids;
      this.fingerprint = fingerprint;
      for (const [id, mark] of seen) this.signatures.set(id, mark);
      for (const id of this.signatures.keys()) if (!ids.has(id)) this.signatures.delete(id);
      if (counting) for (const { before, after } of put.values()) this.count(before, after);
    };
    if (!starting) return write;
    write();
    // The start goes ahead whether or not it was recorded; unrecorded, the report says so until the ledger takes a write.
    if (this.failing && !this.degraded) { this.degraded = true; console.error(`routines: the run ledger ${this.ledger.file} cannot be written; scheduled runs start without it until it can`); }
    return () => {};
  }

  /** Whether a queued run may start now. A scheduled occurrence waits while the ledger cannot take its start, for
   * UNRECORDED_START_PASSES passes; after that it starts unrecorded, and so does every other until the ledger can be
   * written again: a run that starts matters more than its record. Any other run never waits. */
  ready(run: Row): boolean {
    if (!isOccurrenceRun(run) || this.degraded) return true;
    if (this.ledger.writable()) { this.refused = 0; return true; }
    this.refused += 1;
    if (this.refused <= UNRECORDED_START_PASSES) return false;
    this.degraded = true;
    console.error(`routines: the run ledger ${this.ledger.file} cannot be written; scheduled runs start without it until it can`);
    return true;
  }

  private failed(error: unknown): void {
    if (!this.failing) console.error("routines: could not write the run ledger; each save tries again", error);
    this.failing = true;
  }

  private written(): void {
    if (this.degraded) console.error("routines: the run ledger can be written again");
    this.failing = false; this.degraded = false; this.refused = 0;
  }

  /** The occurrence already has a record that stands, so no row is made for it again: it ran, was closed, or is another
   * row's. The file is read again first when another process has written to it. */
  decided(routineId: string, dueAt: number): boolean {
    this.refresh();
    this.trim(routineId, dueAt);
    const record = this.standing(routineId, dueAt);
    if (!record || this.unclaimed(record, this.rowIds)) return false;
    this.duplicates += 1;
    console.warn("routines: a scheduled occurrence that already has its record was not made again");
    return true;
  }

  /** A queued row whose occurrence belongs to another row's record: starting it would start the occurrence twice. */
  startedElsewhere(run: Row): boolean {
    if (!isOccurrenceRun(run)) return false;
    this.refresh();
    if (this.ledger.ofRun(run.id)) return false;
    const record = this.standing(run.routineId, run.skipped?.firstAt ?? run.scheduledFor);
    if (!record || this.unclaimed(record, new Set([...this.rowIds].filter((id) => id !== run.id)))) return false;
    this.duplicates += 1;
    return true;
  }

  /** When a run cut by a restart may start again: not before the lease another machine holds on it has lapsed. Undefined when nothing holds it back. */
  retryAfterBoot(run: Pick<RoutineRun, "id">): number | undefined {
    const lease = this.ledger.ofRun(run.id)?.lease;
    return lease && lease.machine !== this.holder.machine && lease.until > this.now() ? lease.until + 1_000 : undefined;
  }

  private mine(): Occurrence[] {
    if (this.held.version !== this.ledger.version) this.held = { version: this.ledger.version, records: [...this.ledger.all()].filter((record) => record.lease?.boot === this.holder.boot && !occurrenceEnded(record)) };
    return this.held.records;
  }

  /** When the leases this process holds are next renewed; null while it holds none. */
  beatDueAt(): number | null {
    const due = this.mine().map((record) => record.lease!.until - (LEASE_MS - LEASE_BEAT_MS));
    return due.length ? Math.min(...due) : null;
  }

  /** Renews this process's leases that are due. */
  beat(): void {
    const now = this.now(), due = this.mine().filter((record) => record.lease!.until - now <= LEASE_MS - LEASE_BEAT_MS);
    if (due.length === 0) return;
    try { this.ledger.write(due.map((record) => ({ ...record, lease: { ...this.holder, until: now + LEASE_MS } })), [], false); }
    catch (error) { this.failed(error); }
  }

  /** At shutdown: the leases are given up, so whichever process starts next on this data need not wait for them. */
  close(): void {
    const leased = this.mine();
    if (leased.length === 0) return;
    try { this.ledger.write(leased.map(({ lease: _lease, ...record }) => record), [], false); }
    catch (error) { console.error("routines: could not give up a run's lease", error); }
  }

  /** The ledger's sequence number, raised first when whether routines.json can be read has changed since it was last asked. */
  sequence(unreadable: boolean): number {
    if (unreadable !== this.unreadable) {
      try { this.ledger.write([]); this.unreadable = unreadable; }
      catch (error) { this.failed(error); }
    }
    return this.ledger.seq;
  }

  /** The record that stands for the occurrence, leaving out one closed for a time that had not come. */
  private standing(routineId: string, dueAt: number): Occurrence | undefined {
    const record = this.ledger.covering(routineId, dueAt);
    return record?.void ? undefined : record;
  }

  /** A record that reaches past now was written while the clock was ahead. One closed without starting is cut back to
   * now; and since nothing says when the clock was put right, one already cut is cut again to just before `due` when
   * that occurrence of its routine is asked about, so an occurrence that has not had its time is still made. One that
   * ran keeps its key, and only its end time is brought back. */
  private trim(routineId?: string, due?: number): void {
    const now = this.now(), end = Math.min(now, (due ?? Infinity) - 1), put: Occurrence[] = [];
    for (const record of routineId === undefined ? this.ledger.all() : this.ledger.ofRoutine(routineId)) {
      if (!occurrenceEnded(record) || record.void) continue;
      const last = occurrenceLastAt(record), ahead = last > now || (record.cut !== undefined && last > end);
      if (record.attempts === 0 && ahead) put.push(cutAt(record, end));
      else if (record.attempts > 0 && (record.endedAt ?? 0) > now) put.push({ ...record, endedAt: now });
    }
    if (put.length === 0) return;
    try { this.ledger.write(put.map((record) => JSON.parse(JSON.stringify(record)) as Occurrence)); this.signatures.clear(); }
    catch (error) { this.failed(error); }
  }

  private refresh(): void {
    if (this.ledger.sync()) this.signatures.clear();
  }

  /** A record no row stands behind and that never started: its row was never saved, so the occurrence is still to be made. */
  private unclaimed(record: Occurrence, rows: ReadonlySet<string>): boolean {
    return record.attempts === 0 && !occurrenceEnded(record) && !record.runIds.some((id) => rows.has(id));
  }

  private count(before: Occurrence | undefined, after: Occurrence): void {
    const was = before?.attempts ?? 0, closed = (record: Occurrence | undefined) => record && !record.void && record.reason !== "scheduler-late" && (record.state === "missed" || record.state === "skipped") ? record.count ?? 1 : 0;
    if (after.state === "ran" && before?.state !== "ran") this.counts.ran += 1;
    if (after.state === "failed" && before?.state !== "failed") this.counts.failed += 1;
    this.counts.missed += Math.max(0, closed(after) - closed(before));
    const late = (record: Occurrence | undefined) => record !== undefined && record.attempts > 0 && record.startedAt !== undefined && record.startedAt - record.dueAt > LATE_START_MS ? 1 : 0;
    this.counts.late = Math.max(0, this.counts.late + late(after) - late(before));
    this.counts.retried = Math.max(0, this.counts.retried + Math.max(1, after.attempts) - Math.max(1, was));
  }
}

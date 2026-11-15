// Keeps the occurrence ledger (routine-ledger.ts) in step with the run rows. Every save of routines.json hands its rows
// here, and each scheduled row's record is made again from the row and the record before it: the row says what
// happened, the record remembers how often the occurrence started and when it first did. An occurrence's key is what
// makes its start happen once: the scheduler asks `decided` before it makes a row for an occurrence and
// `startedElsewhere` before it starts one, and a start is written and flushed here before its turn begins.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { ROUTINE_SUPERSEDED } from "./routine-execution.ts";
import { occurrenceEnded, RoutineLedger, type Occurrence, type OccurrenceLease, type OccurrenceReason, type OccurrenceState } from "./routine-ledger.ts";
import type { Routine, RoutineRun } from "./routines.ts";

/** How long a started occurrence's lease lasts without being renewed, and how often it is renewed while its run lives. */
export const LEASE_MS = 3 * 60_000;
export const LEASE_BEAT_MS = 60_000;
/** A first start later than this after the scheduled time counts as late. */
export const LATE_START_MS = 5 * 60_000;
export const ROUTINE_TURN_GONE = "its turn ended without reporting back";

export interface OccurrenceCounts { ran: number; failed: number; missed: number; late: number; retried: number }

type Row = Pick<RoutineRun, "id" | "routineId" | "scheduledFor" | "status" | "manual" | "triggerSource" | "checkKey" | "webhookId" | "startedAt" | "finishedAt" | "createdAt" |
  "retried" | "skipped" | "error" | "errorCode" | "errorParams" | "attentionCode">;
type Scheduled = Pick<Routine, "id" | "enabled" | "nextRunAt" | "updatedAt">;

/** A run row made for a scheduled occurrence: not one a person, a start-up, an event or a routine's checks made. */
export const isOccurrenceRun = (run: Pick<RoutineRun, "manual" | "triggerSource" | "checkKey" | "webhookId">): boolean =>
  (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule" && run.checkKey === undefined && run.webhookId === undefined;

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
  return attempts > 0 ? "failed" : run.status === "cancelled" ? "skipped" : "missed";
}

function reasonOf(run: Row, state: OccurrenceState): OccurrenceReason | undefined {
  if (state === "queued" || state === "running" || state === "ran") return undefined;
  const behind = run.skipped?.behind, code = run.errorCode, why = String(run.errorParams?.why ?? "");
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

function recordOf(run: Row, before: Occurrence | undefined, now: number, holder: Omit<OccurrenceLease, "until">): Occurrence {
  const started = starts(run, before), state = stateOf(run, started.attempts), reason = reasonOf(run, state);
  const held = run.status === "running" || run.status === "waiting";
  const lease = !held ? undefined : before?.lease?.boot === holder.boot ? before.lease : { ...holder, until: now + LEASE_MS };
  return {
    routineId: run.routineId, dueAt: before?.dueAt ?? run.skipped?.firstAt ?? run.scheduledFor, state, ...(reason ? { reason } : {}), ...started,
    madeAt: before?.madeAt ?? run.createdAt, ...(ACTIVE.has(run.status) ? {} : { endedAt: run.finishedAt ?? now }),
    ...(run.skipped && run.skipped.count > 1 ? { count: run.skipped.count, lastAt: run.skipped.lastAt } : {}),
    runIds: before?.runIds.includes(run.id) ? before.runIds : [run.id], ...(lease ? { lease } : {}),
  };
}

const same = (a: Occurrence, b: Occurrence) => JSON.stringify(a) === JSON.stringify(b);
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
  private held: { version: number; records: Occurrence[] } = { version: -1, records: [] };

  constructor(routinesFile: string, now: () => number, machine?: string) {
    this.now = now;
    this.holder = { machine: machineName(machine), boot: randomUUID() };
    this.ledger = new RoutineLedger(routinesFile, now);
    this.restoredThrough = this.ledger.open().restoredThrough;
  }

  /** Works out every scheduled row's record from the rows about to be saved. A change that holds a start is written at
   * once, and throws when it cannot be: a turn never begins before its start is on disk. Any other change is written by
   * the function returned, which the caller runs once routines.json itself is saved, so the ledger never says more
   * than the rows do; a write that fails there is made again with the next save. `counting` false at start, when the
   * rows are older than this process and nothing they say happened in it. */
  observe(routines: readonly Scheduled[], runs: readonly Row[], counting = true): () => void {
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
        const taken = put.get(key)?.after ?? this.ledger.covering(run.routineId, dueAt);
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
      this.ledger.write([...put.values()].map(({ after }) => JSON.parse(JSON.stringify(after)) as Occurrence), remove);
      this.rowIds = ids;
      this.fingerprint = fingerprint;
      for (const [id, mark] of seen) this.signatures.set(id, mark);
      for (const id of this.signatures.keys()) if (!ids.has(id)) this.signatures.delete(id);
      if (counting) for (const { before, after } of put.values()) this.count(before, after);
    };
    if (starting) { write(); return () => {}; }
    return () => {
      try { write(); } catch (error) { console.error("routines: could not write the run ledger; the next save writes it", error); }
    };
  }

  /** The occurrence already has a record that stands, so no row is made for it again: it ran, was closed, or is another
   * row's. The file is read again first when another process has written to it. */
  decided(routineId: string, dueAt: number): boolean {
    this.refresh();
    const record = this.ledger.covering(routineId, dueAt);
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
    const record = this.ledger.covering(run.routineId, run.skipped?.firstAt ?? run.scheduledFor);
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
    catch (error) { console.error("routines: could not renew a run's lease", error); }
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
      catch (error) { console.error("routines: could not write the run ledger; the next save writes it", error); }
    }
    return this.ledger.seq;
  }

  private refresh(): void {
    if (this.ledger.sync()) this.signatures.clear();
  }

  /** A record no row stands behind and that never started: its row was never saved, so the occurrence is still to be made. */
  private unclaimed(record: Occurrence, rows: ReadonlySet<string>): boolean {
    return record.attempts === 0 && !occurrenceEnded(record) && !record.runIds.some((id) => rows.has(id));
  }

  private count(before: Occurrence | undefined, after: Occurrence): void {
    const was = before?.attempts ?? 0, closed = (record: Occurrence | undefined) => record && (record.state === "missed" || record.state === "skipped") ? record.count ?? 1 : 0;
    if (after.state === "ran" && before?.state !== "ran") this.counts.ran += 1;
    if (after.state === "failed" && before?.state !== "failed") this.counts.failed += 1;
    this.counts.missed += Math.max(0, closed(after) - closed(before));
    const late = (record: Occurrence | undefined) => record !== undefined && record.attempts > 0 && record.startedAt !== undefined && record.startedAt - record.dueAt > LATE_START_MS ? 1 : 0;
    this.counts.late = Math.max(0, this.counts.late + late(after) - late(before));
    this.counts.retried = Math.max(0, this.counts.retried + Math.max(1, after.attempts) - Math.max(1, was));
  }
}

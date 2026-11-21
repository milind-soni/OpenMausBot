// The occurrence ledger's file: one record per scheduled occurrence of each routine, keyed by the routine's id and the
// scheduled-for time. It sits beside routines.json as JSON lines, appended and flushed one change at a time (a start is
// on disk before its turn begins) and rewritten whole, atomically, when it has grown past its records. A record holds
// ids, times, counts and fixed words only: nothing of a routine's name, prompt or output. A second small file, the mark,
// keeps the sequence number and time of this folder's last change, so a ledger brought back from a backup is recognised and a
// lost ledger never starts its sequence again from zero.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export type OccurrenceState = "queued" | "running" | "ran" | "failed" | "missed" | "skipped";
export const OCCURRENCE_STATES: readonly OccurrenceState[] = ["queued", "running", "ran", "failed", "missed", "skipped"];

/** Why an occurrence ended as it did, as a fixed word. */
export const OCCURRENCE_REASONS = [
  "previous-run-active", "computer-no-start", "bot-busy", "computer-off", "cloud-down", "scheduler-late", "restored", "run-limit",
  "superseded", "restarted", "turn-gone", "cancelled", "failed", "not-started",
] as const;
export type OccurrenceReason = typeof OCCURRENCE_REASONS[number];

/** Who is running a started occurrence, renewed while its run lives: another machine holding the same data waits for it to lapse. */
export interface OccurrenceLease { machine: string; boot: string; until: number }

export interface Occurrence {
  routineId: string;
  /** Its scheduled-for time; on a record that stands for several occurrences, the first of them. */
  dueAt: number;
  state: OccurrenceState;
  reason?: OccurrenceReason;
  /** Starts so far. */
  attempts: number;
  /** When its first attempt started. */
  startedAt?: number;
  /** The start counted last, so one start is never counted twice. */
  lastStartAt?: number;
  madeAt: number;
  endedAt?: number;
  /** The occurrences it stands for, when more than one, and the scheduled-for time of the last. */
  count?: number;
  lastAt?: number;
  /** A record written while the clock was ahead stands for nothing after this time, however far its row says it reaches. */
  cut?: number;
  /** Closed for a time that had not come: it stands for no occurrence, and one due at its time is still made. */
  void?: true;
  /** The run rows it produced. */
  runIds: string[];
  lease?: OccurrenceLease;
}

/** Records that have ended are kept this long whatever their number, so the last day's counts are whole. */
export const LEDGER_KEEP_ALL_MS = 48 * 60 * 60_000;
/** Older than that, each routine keeps its newest ended records up to this many, for this long. */
export const LEDGER_KEEP_PER_ROUTINE = 200;
export const LEDGER_KEEP_MS = 90 * 24 * 60 * 60_000;
export const LEDGER_MAX_RECORDS = 10_000;
const COMPACT_SLACK_LINES = 500;
const MAX_SEQ = 1e15, MAX_TIME = 1e15;
const ID = /^[\w:-]{1,64}$/;
const ENDED = new Set<OccurrenceState>(["ran", "failed", "missed", "skipped"]);

export const occurrenceEnded = (occurrence: Pick<Occurrence, "state">) => ENDED.has(occurrence.state);
/** The scheduled-for time of the newest occurrence the record stands for. */
export const occurrenceLastAt = (occurrence: Pick<Occurrence, "dueAt" | "lastAt">) => occurrence.lastAt ?? occurrence.dueAt;

export function ledgerPaths(routinesFile: string): { ledger: string; mark: string } {
  const stem = join(dirname(routinesFile), basename(routinesFile, ".json"));
  return { ledger: `${stem}.ledger.jsonl`, mark: `${stem}.ledger.mark` };
}

const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TIME;
const optionalTime = (value: unknown): number | undefined => time(value) ? value : undefined;

/** A record as the file may hold it; anything out of shape is dropped whole. */
export function loadOccurrence(value: unknown): Occurrence | null {
  const saved = value as Partial<Occurrence> | null;
  if (!saved || typeof saved !== "object" || typeof saved.routineId !== "string" || !ID.test(saved.routineId) || !time(saved.dueAt) || !time(saved.madeAt) ||
    !OCCURRENCE_STATES.includes(saved.state as OccurrenceState) || !Number.isSafeInteger(saved.attempts) || saved.attempts! < 0 || saved.attempts! > 1_000_000 ||
    !Array.isArray(saved.runIds) || saved.runIds.length > 50 || !saved.runIds.every((id) => typeof id === "string" && ID.test(id))) return null;
  const lease = saved.lease, counted = Number.isSafeInteger(saved.count) && saved.count! > 1 && time(saved.lastAt) && saved.lastAt >= saved.dueAt;
  return {
    routineId: saved.routineId, dueAt: saved.dueAt, state: saved.state!, attempts: saved.attempts!, madeAt: saved.madeAt, runIds: [...saved.runIds],
    ...(OCCURRENCE_REASONS.includes(saved.reason as OccurrenceReason) ? { reason: saved.reason } : {}),
    ...(optionalTime(saved.startedAt) === undefined ? {} : { startedAt: saved.startedAt }),
    ...(optionalTime(saved.lastStartAt) === undefined ? {} : { lastStartAt: saved.lastStartAt }),
    ...(optionalTime(saved.endedAt) === undefined ? {} : { endedAt: saved.endedAt }),
    ...(counted ? { count: saved.count, lastAt: saved.lastAt } : {}),
    ...(optionalTime(saved.cut) === undefined ? {} : { cut: saved.cut }), ...(saved.void === true ? { void: true as const } : {}),
    ...(lease && typeof lease.machine === "string" && ID.test(lease.machine) && typeof lease.boot === "string" && ID.test(lease.boot) && time(lease.until)
      ? { lease: { machine: lease.machine, boot: lease.boot, until: lease.until } } : {}),
  };
}

interface LedgerMark { seq: number; at: number }

/** One line of the file: a sequence number, with a record to keep (`o`) or the key of one to drop (`x`). Null for a torn or damaged line. */
function parseLine(line: string): { s: number; o?: unknown; x?: unknown } | null {
  try {
    const entry = JSON.parse(line) as { s?: unknown; o?: unknown; x?: unknown } | null;
    return entry && typeof entry === "object" && Number.isSafeInteger(entry.s) && (entry.s as number) >= 0 && (entry.s as number) <= MAX_SEQ ? { ...entry, s: entry.s as number } : null;
  } catch { return null; }
}

export interface LedgerOpened {
  /** missing: no ledger yet. damaged: some of it could not be read, and what could is kept. */
  state: "ok" | "missing" | "damaged";
  /** The ledger is older than the last one this folder wrote, which was alive until this time: it came from a backup. */
  restoredThrough: number | null;
}

export class RoutineLedger {
  readonly file: string;
  private readonly mark: string;
  private readonly now: () => number;
  private readonly byRoutine = new Map<string, Map<number, Occurrence>>();
  private readonly byRun = new Map<string, Occurrence>();
  private sequence = 0;
  private lines = 0;
  private bytes = 0;
  private endsMidLine = false;
  private total = 0;
  private changes = 0;
  private readonly slack: number;

  /** `slack`: how many more lines than records the file may hold before it is rewritten. */
  constructor(routinesFile: string, now: () => number, slack = COMPACT_SLACK_LINES) {
    ({ ledger: this.file, mark: this.mark } = ledgerPaths(routinesFile));
    this.now = now;
    this.slack = slack;
  }

  get seq(): number { return this.sequence; }
  /** Goes up whenever the records in memory may have changed. */
  get version(): number { return this.changes; }
  get size(): number { return this.total; }

  open(): LedgerOpened {
    const mark = this.readMark(), text = this.text(), state = text === undefined ? "damaged" : this.read(text);
    const restored = state === "ok" && mark !== null && this.sequence < mark.seq;
    // The mark is written with every change, so it holds the last sequence number even when the ledger itself is lost.
    if (!restored && mark) this.sequence = Math.min(MAX_SEQ, Math.max(this.sequence, state === "ok" ? mark.seq : mark.seq + 1));
    if (state === "damaged" && text !== undefined) this.compact();
    return { state, restoredThrough: restored ? mark.at : null };
  }

  get(routineId: string, dueAt: number): Occurrence | undefined { return this.byRoutine.get(routineId)?.get(dueAt); }
  ofRun(runId: string): Occurrence | undefined { return this.byRun.get(runId); }
  ofRoutine(routineId: string): Occurrence[] { return [...this.byRoutine.get(routineId)?.values() ?? []]; }
  *all(): IterableIterator<Occurrence> { for (const records of this.byRoutine.values()) yield* records.values(); }

  /** The record that stands for the occurrence at `dueAt`: its own, or one counting a span of occurrences that holds it. */
  covering(routineId: string, dueAt: number): Occurrence | undefined {
    const records = this.byRoutine.get(routineId), own = records?.get(dueAt);
    if (own || !records) return own;
    for (const record of records.values()) if (record.lastAt !== undefined && record.dueAt <= dueAt && dueAt <= record.lastAt) return record;
    return undefined;
  }

  /** Appends the changes and flushes them before anything in memory changes: a failed write leaves the ledger as it
   * was, and throws. `counted` false writes without raising the sequence (a renewed lease changes nothing a reader counts). */
  write(put: readonly Occurrence[], remove: readonly Occurrence[] = [], counted = true): void {
    if (put.length === 0 && remove.length === 0 && !counted) return;
    let seq = this.sequence;
    const step = () => counted ? (seq = Math.min(MAX_SEQ, seq + 1)) : seq;
    const lines = [...put.map((o) => JSON.stringify({ s: step(), o })), ...remove.map((gone) => JSON.stringify({ s: step(), x: [gone.routineId, gone.dueAt] }))];
    if (lines.length === 0) lines.push(JSON.stringify({ s: step() }));
    const text = `${this.endsMidLine ? "\n" : ""}${lines.join("\n")}\n`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, text, { mode: 0o600, flush: true });
    } catch (error) {
      this.endsMidLine = true;
      throw error;
    }
    this.endsMidLine = false;
    this.sequence = seq;
    this.bytes += Buffer.byteLength(text);
    this.lines += lines.length;
    this.changes += 1;
    for (const gone of remove) this.drop(gone);
    for (const record of put) this.keep(record);
    if (this.lines > this.total + this.slack) this.compact();
    if (counted) this.writeMark();
  }

  /** Whether the file can be opened for appending now. Windows opens a folder of that name without complaint, so what was opened is looked at too. */
  writable(): boolean {
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      fd = openSync(this.file, "a", 0o600);
      return fstatSync(fd).isFile();
    } catch { return false; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing was written through it */ } }
  }

  /** Reads the file again when something else has written to it since this process last did. True when it had. A
   * file that cannot be read just now leaves what is in memory as it is. */
  sync(): boolean {
    let size: number;
    try { size = statSync(this.file).size; } catch { size = 0; }
    if (size === this.bytes) return false;
    const text = this.text(), seq = this.sequence;
    if (text === undefined) return false;
    this.read(text);
    this.sequence = Math.max(seq, this.sequence);
    return true;
  }

  /** The file's text; null when there is no file, undefined when it is there and cannot be read. */
  private text(): string | null | undefined {
    try { return readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.error(`routines: the run ledger ${this.file} cannot be read`);
      return undefined;
    }
  }

  private keep(record: Occurrence): void {
    const records = this.byRoutine.get(record.routineId) ?? new Map<number, Occurrence>();
    this.byRoutine.set(record.routineId, records);
    const before = records.get(record.dueAt);
    if (!before) this.total += 1;
    for (const id of before?.runIds ?? []) if (this.byRun.get(id) === before) this.byRun.delete(id);
    records.set(record.dueAt, record);
    for (const id of record.runIds) this.byRun.set(id, record);
  }

  private drop(gone: Pick<Occurrence, "routineId" | "dueAt">): void {
    const records = this.byRoutine.get(gone.routineId), record = records?.get(gone.dueAt);
    if (!records || !record) return;
    records.delete(gone.dueAt);
    this.total -= 1;
    if (records.size === 0) this.byRoutine.delete(gone.routineId);
    for (const id of record.runIds) if (this.byRun.get(id) === record) this.byRun.delete(id);
  }

  private read(text: string | null): LedgerOpened["state"] {
    this.byRoutine.clear(); this.byRun.clear(); this.changes += 1;
    this.sequence = 0; this.lines = 0; this.bytes = 0; this.total = 0; this.endsMidLine = false;
    // An empty file holds no ledger: it is made again from the rows, like one that is not there.
    if (text === null || text.trim() === "") { this.bytes = text === null ? 0 : Buffer.byteLength(text); this.endsMidLine = Boolean(text) && !text!.endsWith("\n"); return "missing"; }
    this.bytes = Buffer.byteLength(text);
    this.endsMidLine = text.length > 0 && !text.endsWith("\n");
    let damaged = this.endsMidLine;
    for (const line of text.split("\n")) {
      if (!line) continue;
      this.lines += 1;
      const entry = parseLine(line);
      if (!entry) { damaged = true; continue; }
      this.sequence = Math.max(this.sequence, entry.s);
      if (Array.isArray(entry.x)) this.drop({ routineId: String(entry.x[0]), dueAt: Number(entry.x[1]) });
      else if (entry.o !== undefined) {
        const record = loadOccurrence(entry.o);
        if (record) this.keep(record); else damaged = true;
      }
    }
    return damaged ? "damaged" : "ok";
  }

  /** Ended records past their keep, oldest first. A record that has not ended is never dropped here. */
  private expired(): Occurrence[] {
    const now = this.now(), gone: Occurrence[] = [], kept: Occurrence[] = [];
    // Never later than now: a time stamped while the clock was ahead does not keep a record past its keep.
    const endedAt = (record: Occurrence) => Math.min(now, record.endedAt ?? occurrenceLastAt(record));
    for (const records of this.byRoutine.values()) {
      const ended = [...records.values()].filter(occurrenceEnded).sort((a, b) => occurrenceLastAt(b) - occurrenceLastAt(a));
      ended.forEach((record, index) => {
        const age = now - endedAt(record);
        (age > LEDGER_KEEP_MS || (age > LEDGER_KEEP_ALL_MS && index >= LEDGER_KEEP_PER_ROUTINE) ? gone : kept).push(record);
      });
    }
    const over = this.total - gone.length - LEDGER_MAX_RECORDS;
    if (over > 0) gone.push(...kept.sort((a, b) => endedAt(a) - endedAt(b)).slice(0, over));
    return gone;
  }

  /** Rewrites the file as one line per record. A rewrite that fails leaves the longer file, which reads the same. */
  private compact(): void {
    for (const record of this.expired()) this.drop(record);
    const text = `${[JSON.stringify({ v: 1, s: this.sequence }), ...[...this.all()].map((o) => JSON.stringify({ s: this.sequence, o }))].join("\n")}\n`;
    try {
      writeFileAtomic(this.file, text, { mode: 0o600 });
      this.bytes = Buffer.byteLength(text);
      this.lines = this.total + 1;
      this.endsMidLine = false;
    } catch (error) {
      this.lines = this.total;
      console.error("routines: could not rewrite the run ledger; it stays as it is and is rewritten later", error);
    }
  }

  private readMark(): LedgerMark | null {
    try {
      const saved = JSON.parse(readFileSync(this.mark, "utf8")) as Partial<LedgerMark> | null;
      return saved && Number.isSafeInteger(saved.seq) && saved.seq! >= 0 && saved.seq! <= MAX_SEQ && time(saved.at) ? { seq: saved.seq!, at: saved.at } : null;
    } catch { return null; }
  }

  private writeMark(): void {
    try { writeFileAtomic(this.mark, JSON.stringify({ v: 1, seq: this.sequence, at: this.now() } satisfies LedgerMark & { v: 1 }), { mode: 0o600, durable: false }); }
    catch (error) { console.error("routines: could not write the run ledger's mark", error); }
  }
}

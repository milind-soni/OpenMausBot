// Span lines beside the usage ledger, <data>/usage/spans/<YYYY-MM-DD>.jsonl (0600): one line per AI step or tool call, keyed by
// an id built from the engine's own ids, so a replayed or repeated event rewrites its span and the last line for an id wins.
// Lines carry names, times, token counts and one clipped, redacted detail; never arguments, outputs, prompts or replies.
// Writes are buffered and appended in batches off the turn's path; a failed write is dropped, never the turn.
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TraceStatus, TraceTokens } from "../../shared/usage-trace.ts";

export interface StepSpan {
  kind: "step";
  id: string;
  threadId: string;
  turnId: string;
  startedAt: number;
  endedAt?: number;
  tokens?: TraceTokens;
  contextTokens?: number;
  contextWindow?: number;
}

export interface ToolSpan {
  kind: "tool";
  id: string;
  threadId: string;
  turnId: string;
  name: string;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  status: TraceStatus;
  error?: string;
  timedBy: "engine" | "omb";
}

export type SpanRecord = StepSpan | ToolSpan;

export const SPAN_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
const BATCH_MS = 1_000;
const DIR = join("usage", "spans");
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const spanDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function spansDir(dataDir: string): string {
  return join(dataDir, DIR);
}

/** Every UTC day from `from` to `to`, inclusive. */
export function daysBetween(from: number, to: number): string[] {
  const days: string[] = [];
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day <= to; day += DAY_MS) days.push(spanDay(day));
  return days;
}

interface Writer {
  pending: Map<string, string[]>;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  prunedDay: string | null;
}

const writers = new Map<string, Writer>();

function writerFor(dataDir: string): Writer {
  let writer = writers.get(dataDir);
  if (!writer) {
    writer = { pending: new Map(), timer: null, chain: Promise.resolve(), prunedDay: null };
    writers.set(dataDir, writer);
  }
  return writer;
}

async function prune(dataDir: string, today: string): Promise<void> {
  const oldest = spanDay(Date.parse(today) - SPAN_RETENTION_DAYS * DAY_MS);
  const names = await readdir(spansDir(dataDir)).catch(() => [] as string[]);
  for (const name of names) {
    const day = DAY_FILE.exec(name)?.[1];
    if (day && day < oldest) await unlink(join(spansDir(dataDir), name)).catch(() => {});
  }
}

function drain(dataDir: string, writer: Writer): Promise<void> {
  if (writer.timer) clearTimeout(writer.timer);
  writer.timer = null;
  const batch = writer.pending;
  if (!batch.size) return writer.chain;
  writer.pending = new Map();
  const today = spanDay(Date.now());
  const pruneToday = writer.prunedDay !== today;
  writer.prunedDay = today;
  writer.chain = writer.chain.then(async () => {
    await mkdir(spansDir(dataDir), { recursive: true, mode: 0o700 });
    for (const [day, lines] of batch) await appendFile(join(spansDir(dataDir), `${day}.jsonl`), lines.join(""), { mode: 0o600 });
    if (pruneToday) await prune(dataDir, today);
  }).catch(() => {});
  return writer.chain;
}

/** Queues spans for the next batch; `now` writes the batch at once (a turn just ended). */
export function appendSpans(dataDir: string, spans: readonly SpanRecord[], now = false): void {
  if (!spans.length) return;
  const writer = writerFor(dataDir);
  for (const span of spans) {
    const day = spanDay(span.startedAt);
    const lines = writer.pending.get(day);
    const line = JSON.stringify(span) + "\n";
    if (lines) lines.push(line); else writer.pending.set(day, [line]);
  }
  if (now) void drain(dataDir, writer);
  else if (!writer.timer) {
    writer.timer = setTimeout(() => void drain(dataDir, writer), BATCH_MS);
    writer.timer.unref?.();
  }
}

export function flushSpans(dataDir: string): Promise<void> {
  const writer = writers.get(dataDir);
  return writer ? drain(dataDir, writer) : Promise.resolve();
}

const isSpan = (value: unknown): value is SpanRecord => {
  if (!value || typeof value !== "object") return false;
  const span = value as Partial<SpanRecord>;
  return (span.kind === "step" || span.kind === "tool") && typeof span.id === "string" && typeof span.threadId === "string" &&
    typeof span.turnId === "string" && typeof span.startedAt === "number" && Number.isFinite(span.startedAt);
};

/** Spans of the turns in `turns` (`threadId:turnId`) from the given days' files, streamed, the last line per id winning. */
export async function readSpans(dataDir: string, days: Iterable<string>, turns: ReadonlySet<string>): Promise<Map<string, SpanRecord[]>> {
  const latest = new Map<string, SpanRecord>();
  for (const day of new Set(days)) {
    const stream = createReadStream(join(spansDir(dataDir), `${day}.jsonl`), { encoding: "utf8" });
    const opened = await new Promise<boolean>((resolve) => {
      stream.once("open", () => resolve(true));
      stream.once("error", () => resolve(false));
    });
    if (!opened) continue;
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line) continue;
      const key = /"threadId":"([^"]*)","turnId":"([^"]*)"/.exec(line);
      if (key && !turns.has(`${key[1]}:${key[2]}`)) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isSpan(value) || !turns.has(`${value.threadId}:${value.turnId}`)) continue;
        latest.delete(value.id);
        latest.set(value.id, value);
      } catch {
      }
    }
  }
  const byTurn = new Map<string, SpanRecord[]>();
  for (const span of latest.values()) {
    const key = `${span.threadId}:${span.turnId}`;
    const list = byTurn.get(key);
    if (list) list.push(span); else byTurn.set(key, [span]);
  }
  return byTurn;
}

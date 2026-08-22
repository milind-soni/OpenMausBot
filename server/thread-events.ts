// The inspector's data: what a thread's turn actually looked like on the
// wire. Nothing new is captured here — the harness already tees two logs
// per thread, and this just reads them back:
//
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream the bus
//                               publishes (server/harness/bus.ts)
//   native/<threadId>.ndjson  — the provider's own protocol messages,
//                               verbatim and secret-redacted
//                               (server/drivers/native.ts)
//
// Merged by timestamp so a tool call and the raw message behind it sit
// next to each other. Newest-`limit` only: a long-lived thread has
// thousands of native lines and the panel wants the recent ones first.
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "./contracts.ts";

/** One line of native/<threadId>.ndjson (server/drivers/native.ts). */
export interface NativeRecord {
  at: string;
  dir: "in" | "out";
  source: string;
  msg: unknown;
}

export type InspectorEntry =
  | { kind: "runtime"; at: string; data: RuntimeEvent }
  | { kind: "native"; at: string; data: NativeRecord };

export interface InspectorPage {
  entries: InspectorEntry[];
  /** line counts before the cap, so the UI can say "showing 200 of 1,687" */
  total: { runtime: number; native: number };
}

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
const READ_CHUNK = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

interface LineCount {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  complete: number;
  trailing: boolean;
}
type FileStat = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;

// Counts are incremental per append-only log. The first request scans bytes
// once (without decoding or parsing every JSON record); later requests inspect
// only bytes appended since the cached size. Keep this bounded across threads.
const lineCounts = new Map<string, LineCount>();
const LINE_COUNT_CACHE_MAX = 256;

/** Thread ids are uuids the harness minted; anything else is not a file we
 * should be reading. */
function assertThreadId(threadId: string) {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

function countLines(fd: number, file: string, stat: FileStat): number {
  const previous = lineCounts.get(file);
  const appended =
    previous &&
    previous.dev === stat.dev &&
    previous.ino === stat.ino &&
    stat.size >= previous.size &&
    (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
  if (appended && stat.size === previous.size) return previous.complete + Number(previous.trailing);

  let offset = appended ? previous.size : 0;
  let complete = appended ? previous.complete : 0;
  let trailing = appended ? previous.trailing : false;
  while (offset < stat.size) {
    const length = Math.min(READ_CHUNK, stat.size - offset);
    const chunk = Buffer.allocUnsafe(length);
    const read = readSync(fd, chunk, 0, length, offset);
    if (read <= 0) break;
    for (let i = 0; i < read; i++) {
      if (chunk[i] === 0x0a) {
        if (trailing) complete++;
        trailing = false;
      } else if (chunk[i] !== 0x0d) {
        trailing = true;
      }
    }
    offset += read;
  }
  const next = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, complete, trailing };
  lineCounts.delete(file);
  lineCounts.set(file, next);
  while (lineCounts.size > LINE_COUNT_CACHE_MAX) lineCounts.delete(lineCounts.keys().next().value!);
  return complete + Number(trailing);
}

type RecordGuard<T> = (value: unknown) => value is T;

function parseRecent<T>(text: string, includeFirst: boolean, limit: number, valid: RecordGuard<T>): T[] {
  const lines = text.split("\n");
  if (!includeFirst) lines.shift();
  const out: T[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (valid(value)) out.push(value);
    } catch {
      // A torn line during a write, or a hand-edited record. Keep looking
      // farther back until we still have `limit` valid recent entries.
    }
  }
  return out.slice(-limit);
}

function readRecentLines<T>(file: string, limit: number, valid: RecordGuard<T>): { lines: T[]; total: number } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], total: 0 };
  }
  try {
    const stat = fstatSync(fd);
    const total = countLines(fd, file, stat);
    let position = stat.size;
    let bytes = Buffer.alloc(0);
    let lines: T[] = [];
    while (position > 0 && bytes.length < MAX_TAIL_BYTES) {
      const remaining = MAX_TAIL_BYTES - bytes.length;
      const start = Math.max(0, position - Math.min(READ_CHUNK, remaining));
      const length = position - start;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, start);
      if (read <= 0) break;
      bytes = Buffer.concat([chunk.subarray(0, read), bytes]);
      position = start;
      // The first line is partial until we reach byte zero. Parse only once
      // enough complete candidates exist; corrupt candidates make us keep
      // walking backwards rather than returning fewer valid rows.
      const text = bytes.toString("utf8");
      if (position === 0 || text.split("\n").length - 1 >= limit) {
        lines = parseRecent(text, position === 0, limit, valid);
        if (lines.length >= limit || position === 0) break;
      }
    }
    if (lines.length === 0 && bytes.length > 0) {
      lines = parseRecent(bytes.toString("utf8"), position === 0, limit, valid);
    }
    return { lines, total };
  } finally {
    closeSync(fd);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrMissing = (value: unknown) => value === undefined || typeof value === "string";
const stringOrNullOrMissing = (value: unknown) => value === undefined || value === null || typeof value === "string";
const numberOrNullOrMissing = (value: unknown) => value === undefined || value === null || typeof value === "number";
const stringsOrMissing = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.type !== "string" ||
    !stringOrMissing(value.providerInstanceId) ||
    !stringOrMissing(value.turnId) ||
    !stringOrMissing(value.itemId) ||
    !stringOrMissing(value.requestId)
  ) return false;
  switch (value.type) {
    case "session.started":
      return (value.sessionId === null || typeof value.sessionId === "string") && stringOrNullOrMissing(value.model);
    case "session.exited":
      return stringOrMissing(value.reason);
    case "turn.started":
      return true;
    case "turn.completed":
      return (
        typeof value.ok === "boolean" &&
        stringOrNullOrMissing(value.stopReason) &&
        numberOrNullOrMissing(value.cost) &&
        stringsOrMissing(value.denials) &&
        (value.usage === undefined ||
          (isRecord(value.usage) && typeof value.usage.input === "number" && typeof value.usage.output === "number"))
      );
    case "item.started":
      return (value.itemType === "tool" || value.itemType === "reasoning") && stringOrMissing(value.title);
    case "item.updated":
      return (value.itemType === "tool" || value.itemType === "reasoning") && numberOrNullOrMissing(value.tokens);
    case "item.completed":
      return value.itemType === "assistant_text" ? typeof value.text === "string" : value.itemType === "tool" && typeof value.ok === "boolean";
    case "content.delta":
      return (value.streamKind === "assistant_text" || value.streamKind === "reasoning_text") && typeof value.delta === "string";
    case "request.opened":
      return (
        (value.requestType === "permission" || value.requestType === "question") &&
        typeof value.tool === "string" &&
        typeof value.summary === "string" &&
        stringsOrMissing(value.choices)
      );
    case "request.resolved":
      return (
        (value.behavior === "allow" || value.behavior === "deny" || value.behavior === "answer") &&
        (value.source === "user" ||
          value.source === "auto" ||
          value.source === "timeout" ||
          value.source === "system" ||
          value.source === "unavailable" ||
          value.source === "peer")
      );
    case "thread.token-usage.updated":
      return typeof value.input === "number" && typeof value.output === "number";
    case "runtime.error":
      return typeof value.message === "string" && (value.setup === undefined || typeof value.setup === "boolean");
    default:
      return false;
  }
}

function isNativeRecord(value: unknown): value is NativeRecord {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    (value.dir === "in" || value.dir === "out") &&
    typeof value.source === "string" &&
    Object.hasOwn(value, "msg")
  );
}

export function readThreadEvents(input: {
  eventsDir: string;
  nativeDir: string;
  threadId: string;
  limit?: number;
}): InspectorPage {
  const { eventsDir, nativeDir, threadId } = input;
  assertThreadId(threadId);
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), MAX_LIMIT)) : DEFAULT_LIMIT;

  const runtime = readRecentLines(join(eventsDir, `${threadId}.ndjson`), limit, isRuntimeEvent);
  const native = readRecentLines(join(nativeDir, `${threadId}.ndjson`), limit, isNativeRecord);

  // cap each log on its own, then merge: the native tee is several times
  // chattier than the runtime stream, and one shared cap would leave the
  // Events lens with a handful of rows behind hundreds of raw ones
  const merged: InspectorEntry[] = [
    ...runtime.lines.map((data): InspectorEntry => ({ kind: "runtime", at: data.createdAt, data })),
    ...native.lines.map((data): InspectorEntry => ({ kind: "native", at: data.at, data })),
  ];
  // stable sort: ties keep file order, which is emit order
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    entries: merged,
    total: { runtime: runtime.total, native: native.total },
  };
}

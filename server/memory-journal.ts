// What changed about what the bot believes — and a way back.
//
// Every change to a memory file that goes through the server becomes one
// row here: the person's edits (routes), the bot's (memory_update or its
// own file tools), imports, reverts. Bot writes have no hook to tap — a
// file tool is a process writing to disk — so the turn boundary is the
// hook: the last text this module saw of every memory file is kept as a
// baseline, and at turn end whatever differs from it is the bot's work.
//
// The journal lives OUTSIDE the workspace on purpose, at
// DATA_DIR/memory-journal/<botId>.ndjson. The workspace is the bot's desk —
// it has file tools pointed at it and acceptEdits on. An audit trail the
// audited party can rewrite is not an audit trail.
//
// Same discipline as profile-versions.ts: 0600, through redactSecrets,
// serialized per bot, fire-and-forget — a journal write must never take
// down the change it records, and a turn must never fail because an audit
// line did.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import {
  MEMORY_INDEX,
  MemoryStoreError,
  type MemoryDoc,
  deleteMemoryDoc,
  hashMemoryText,
  memoryOverview,
  readMemoryDoc,
  writeMemoryDoc,
} from "./memory-store.ts";
import { redactSecretsInText } from "./redact.ts";

export type MemoryActor = "bot" | "person" | "import";
export type MemoryChangeKind = "created" | "edited" | "deleted";

export interface MemoryJournalEntry {
  id: string;
  /** Milliseconds since the epoch, like every other history row the UI shows. */
  at: number;
  botId: string;
  path: string;
  actor: MemoryActor;
  /** How it got there: "ui", "api", "turn", "disk" (changed outside the
   * app between turns — an editor, Obsidian), "revert", "import". */
  via: string;
  threadId?: string;
  kind: MemoryChangeKind;
  beforeHash: string | null;
  afterHash: string | null;
  /** The full prior text, redacted — a revert must not depend on replaying
   * a capped diff. Null for a created file. */
  before: string | null;
  /** Unified diff, capped at DIFF_CAP characters. */
  diff: string;
  added: number;
  removed: number;
  canRevert: boolean;
  revertUnavailableReason?: string;
}

export const JOURNAL_DIR = join(DATA_DIR, "memory-journal");
/** A diff is for reading in a list, not for replay; past this it is noise. */
export const DIFF_CAP = 8_000;
/** Past this the prior text is not kept, so the row cannot be reverted. Far
 * above what the store lets anyone write (256KB); only a bot's own file
 * tools can make a memory file this large. */
export const BEFORE_CAP = 512 * 1024;
const MAX_JOURNAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 500;
/** Beyond this many line pairs the LCS table is not worth building; the
 * diff degrades to "everything removed, everything added". */
const LCS_CELL_CAP = 4_000_000;
const CONTEXT = 2;

export function journalFile(botId: string): string {
  return join(JOURNAL_DIR, `${botId}.ndjson`);
}

// ── unified diff ──────────────────────────────────────────────────────

type Op = { tag: " " | "-" | "+"; line: string };

function editScript(a: string[], b: string[]): Op[] {
  if (a.length * b.length > LCS_CELL_CAP) {
    return [...a.map((line) => ({ tag: "-" as const, line })), ...b.map((line) => ({ tag: "+" as const, line }))];
  }
  // classic LCS lengths table, then walk back from the corner
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ tag: "-", line: a[i++] });
    } else {
      ops.push({ tag: "+", line: b[j++] });
    }
  }
  while (i < a.length) ops.push({ tag: "-", line: a[i++] });
  while (j < b.length) ops.push({ tag: "+", line: b[j++] });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // a trailing newline is not an extra empty line for diff purposes
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface UnifiedDiff {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/** A plain unified diff with two lines of context, the shape every
 * developer tool renders. Exported so the row can be checked in tests. */
export function unifiedDiff(before: string, after: string, path: string, cap = DIFF_CAP): UnifiedDiff {
  if (before === after) return { text: "", added: 0, removed: 0, truncated: false };
  const ops = editScript(splitLines(before), splitLines(after));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.tag === "+") added++;
    else if (op.tag === "-") removed++;
  }
  // hunks: runs of changes with CONTEXT equal lines on either side; two
  // runs whose context would touch or overlap share one hunk
  const changes: number[] = [];
  ops.forEach((op, k) => {
    if (op.tag !== " ") changes.push(k);
  });
  const hunks: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < changes.length) {
    let lastChange = changes[index];
    let next = index + 1;
    while (next < changes.length && changes[next] - lastChange <= CONTEXT * 2 + 1) lastChange = changes[next++];
    hunks.push({ start: Math.max(0, changes[index] - CONTEXT), end: Math.min(ops.length - 1, lastChange + CONTEXT) });
    index = next;
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const hunk of hunks) {
    for (; cursor < hunk.start; cursor++) {
      if (ops[cursor].tag !== "+") oldLine++;
      if (ops[cursor].tag !== "-") newLine++;
    }
    const slice = ops.slice(hunk.start, hunk.end + 1);
    const oldCount = slice.filter((op) => op.tag !== "+").length;
    const newCount = slice.filter((op) => op.tag !== "-").length;
    // an empty side is conventionally anchored on the line before it
    lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of slice) lines.push(`${op.tag}${op.line}`);
    for (; cursor <= hunk.end; cursor++) {
      if (ops[cursor].tag !== "+") oldLine++;
      if (ops[cursor].tag !== "-") newLine++;
    }
  }
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > cap) {
    text = `${text.slice(0, cap)}\n… (diff cut here)`;
    truncated = true;
  }
  return { text, added, removed, truncated };
}

// ── the append-only file ──────────────────────────────────────────────

const writeQueues = new Map<string, Promise<void>>();

function enqueue(botId: string, entry: MemoryJournalEntry): void {
  const previous = writeQueues.get(botId) ?? Promise.resolve();
  const queued = previous
    .then(async () => {
      mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
      await appendFile(journalFile(botId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    })
    .catch((error: unknown) => {
      // fire-and-forget: the change this row records already happened
      console.error(`memory-journal: could not append for ${botId}:`, error instanceof Error ? error.message : error);
    });
  writeQueues.set(botId, queued);
  void queued.finally(() => {
    if (writeQueues.get(botId) === queued) writeQueues.delete(botId);
  });
}

/** Test/route seam: a GET right after a write must see the row. */
export async function flushMemoryJournal(botId: string): Promise<void> {
  await writeQueues.get(botId);
}

/** Shutdown seam. Each queued promise swallows its own error, so this
 * never rejects either. */
export async function flushAllMemoryJournals(): Promise<void> {
  await Promise.allSettled(writeQueues.values());
}

function isEntry(value: unknown): value is MemoryJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  // SAFETY: shape probe on a parsed JSON line; the fields the panel keys on are checked below
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.at === "number" && typeof row.path === "string" && typeof row.kind === "string";
}

/** Newest first, bounded to MAX_ROWS from the newest 8 MiB of the file, so
 * an old bot with a long history does not make the panel load all of it. */
export function readMemoryJournal(botId: string, limit = 50): MemoryJournalEntry[] {
  let text: string;
  let offset: number;
  try {
    const fd = openSync(journalFile(botId), "r");
    try {
      const size = fstatSync(fd).size;
      offset = Math.max(0, size - MAX_JOURNAL_READ_BYTES);
      const buffer = Buffer.alloc(size - offset);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, offset + length);
        if (!count) break;
        length += count;
      }
      text = buffer.subarray(0, length).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const rows: MemoryJournalEntry[] = [];
  const lines = text.split("\n");
  const maxRows = Math.min(MAX_ROWS, Math.max(1, limit));
  // when the window starts mid-file its first line is a fragment: skip it
  for (let index = lines.length - 1; index >= (offset > 0 ? 1 : 0) && rows.length < maxRows; index--) {
    const line = lines[index];
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isEntry(value)) rows.push(value);
    } catch {
      // a torn final line from a crash mid-append is skipped, not fatal
    }
  }
  return rows;
}

// ── recording a change ────────────────────────────────────────────────

export interface MemoryChangeInput {
  path: string;
  actor: MemoryActor;
  via: string;
  threadId?: string;
  before: string | null;
  after: string | null;
}

/** The last text this module saw for each memory file of each bot. What
 * the turn-boundary diff compares against, and what a route write
 * advances — so a person's save between two turns is never re-journaled
 * as the bot's work when the turn ends. */
const baselines = new Map<string, Map<string, string>>();

function baselineFor(botId: string): Map<string, string> {
  let baseline = baselines.get(botId);
  if (!baseline) {
    baseline = new Map();
    baselines.set(botId, baseline);
  }
  return baseline;
}

function advanceBaseline(botId: string, path: string, after: string | null): void {
  const baseline = baselineFor(botId);
  if (after === null) baseline.delete(path);
  else baseline.set(path, after);
}

/** Builds and queues one row. Never throws: hashing and diffing are pure,
 * and the append is queued behind a catch. Returns the row so a route can
 * answer with it. */
export function recordMemoryChange(botId: string, change: MemoryChangeInput): MemoryJournalEntry | null {
  const { before, after } = change;
  if (before === after) return null;
  advanceBaseline(botId, change.path, after);
  const kind: MemoryChangeKind = before === null ? "created" : after === null ? "deleted" : "edited";
  const diff = unifiedDiff(before ?? "", after ?? "", change.path);
  let keptBefore: string | null = null;
  let canRevert = true;
  let revertUnavailableReason: string | undefined;
  if (before !== null) {
    if (Buffer.byteLength(before, "utf8") > BEFORE_CAP) {
      canRevert = false;
      revertUnavailableReason = "The earlier version was too large to keep, so this change cannot be reverted.";
    } else {
      keptBefore = redactSecretsInText(before);
      if (keptBefore !== before) {
        // a redacted body is not the body that was there; restoring it
        // would write our marker into the bot's memory as if it were text
        canRevert = false;
        revertUnavailableReason = "The earlier version contained sensitive text that was hidden, so it cannot be restored exactly.";
      }
    }
  }
  const entry: MemoryJournalEntry = {
    id: randomUUID(),
    at: Date.now(),
    botId,
    path: change.path,
    actor: change.actor,
    via: change.via,
    kind,
    beforeHash: before === null ? null : hashMemoryText(before),
    afterHash: after === null ? null : hashMemoryText(after),
    before: keptBefore,
    diff: redactSecretsInText(diff.text),
    added: diff.added,
    removed: diff.removed,
    canRevert,
  };
  if (change.threadId) entry.threadId = change.threadId;
  if (revertUnavailableReason) entry.revertUnavailableReason = revertUnavailableReason;
  enqueue(botId, entry);
  return entry;
}

export interface JournaledWriteOptions {
  actor: MemoryActor;
  via: string;
  threadId?: string;
  expectedHash?: string;
}

/** The write every route uses: store first (it may refuse — 409, 413,
 * containment), journal second. */
export function journalMemoryWrite(
  botId: string,
  path: string,
  text: string,
  opts: JournaledWriteOptions,
): { doc: MemoryDoc; entry: MemoryJournalEntry | null } {
  const result = writeMemoryDoc(botId, path, text, { expectedHash: opts.expectedHash });
  const entry = recordMemoryChange(botId, {
    path,
    actor: opts.actor,
    via: opts.via,
    threadId: opts.threadId,
    before: result.before,
    after: result.after,
  });
  return { doc: { path, text: result.after, hash: result.hash, exists: true }, entry };
}

export function journalMemoryDelete(botId: string, path: string, opts: Omit<JournaledWriteOptions, "expectedHash">): MemoryJournalEntry | null {
  const result = deleteMemoryDoc(botId, path);
  return recordMemoryChange(botId, { path, actor: opts.actor, via: opts.via, threadId: opts.threadId, before: result.before, after: null });
}

export type RevertResult =
  | { ok: true; entry: MemoryJournalEntry | null; doc: MemoryDoc }
  | { ok: false; status: number; error: string };

/** Puts the file back to the text the row recorded and journals that as
 * its own change, so a revert is itself revertible. Unconditional on
 * purpose: reverting an older row over newer ones is the person's call,
 * and the row this writes carries the newer text should they change their
 * mind. */
export function revertMemoryChange(botId: string, entryId: string, opts: { threadId?: string } = {}): RevertResult {
  const entry = readMemoryJournal(botId, MAX_ROWS).find((row) => row.id === entryId);
  if (!entry) return { ok: false, status: 404, error: "no such memory change" };
  if (!entry.canRevert) return { ok: false, status: 400, error: entry.revertUnavailableReason ?? "this change cannot be reverted" };
  try {
    if (entry.kind === "created") {
      // MEMORY.md is never deleted (the store refuses); emptying it is the
      // same end state for the bot
      if (entry.path === MEMORY_INDEX) {
        const written = journalMemoryWrite(botId, entry.path, "", { actor: "person", via: "revert", threadId: opts.threadId });
        return { ok: true, entry: written.entry, doc: written.doc };
      }
      const removed = journalMemoryDelete(botId, entry.path, { actor: "person", via: "revert", threadId: opts.threadId });
      return { ok: true, entry: removed, doc: { path: entry.path, text: "", hash: hashMemoryText(""), exists: false } };
    }
    const written = journalMemoryWrite(botId, entry.path, entry.before ?? "", { actor: "person", via: "revert", threadId: opts.threadId });
    return { ok: true, entry: written.entry, doc: written.doc };
  } catch (error) {
    if (error instanceof MemoryStoreError) return { ok: false, status: error.status, error: error.message };
    throw error;
  }
}

// ── the turn boundary ─────────────────────────────────────────────────

/** Bots with a turn in flight on each thread. A set, not one id: a room
 * thread can have more than one member speaking on it. */
const turnBots = new Map<string, Set<string>>();

function currentDocs(botId: string): Map<string, string> {
  const docs = new Map<string, string>();
  const overview = memoryOverview(botId);
  for (const path of [MEMORY_INDEX, ...overview.topics.map((t) => t.path), ...overview.logs.map((l) => l.path)]) {
    const doc = readMemoryDoc(botId, path);
    if (doc.exists) docs.set(path, doc.text);
  }
  return docs;
}

/** Everything on disk that differs from the baseline becomes a row under
 * `actor`/`via`, and the baseline moves up to match. A path the baseline
 * has never seen is a first sighting at turn start (the server may just
 * have booted; what is already there is nobody's change now) and a
 * creation at turn end (begin seeded everything, so anything new since
 * is the turn's) — `unknownIsNew` says which. */
function reconcile(botId: string, actor: MemoryActor, via: string, threadId: string | undefined, unknownIsNew: boolean): MemoryJournalEntry[] {
  const baseline = baselineFor(botId);
  const docs = currentDocs(botId);
  const rows: MemoryJournalEntry[] = [];
  for (const [path, text] of docs) {
    const known = baseline.get(path);
    if (known === text) continue;
    if (known === undefined && !unknownIsNew) {
      baseline.set(path, text);
      continue;
    }
    const row = recordMemoryChange(botId, { path, actor, via, threadId, before: known ?? null, after: text });
    if (row) rows.push(row);
  }
  // deleting the current key mid-iteration is defined for a Map
  for (const path of baseline.keys()) {
    if (docs.has(path)) continue;
    const row = recordMemoryChange(botId, { path, actor, via, threadId, before: baseline.get(path) ?? null, after: null });
    if (row) rows.push(row);
  }
  return rows;
}

/** Call at dispatch, after ensureWorkspace. A file seen for the first
 * time seeds the baseline silently; a file that changed since the last
 * look was edited outside the app between turns — an editor, Obsidian, a
 * sync client — and is journaled as the person's, via "disk". */
export function beginMemoryTurn(botId: string, threadId: string): void {
  try {
    let bots = turnBots.get(threadId);
    if (!bots) {
      bots = new Set();
      turnBots.set(threadId, bots);
    }
    bots.add(botId);
    reconcile(botId, "person", "disk", undefined, false);
  } catch (error) {
    // a hashing or read failure must not stop the turn from dispatching
    console.error(`memory-journal: could not snapshot ${botId}:`, error instanceof Error ? error.message : error);
  }
}

/** Call at turn.completed (and session.exited — a turn that died may still
 * have written). Whatever moved since the baseline is the bot's work. */
export function endMemoryTurn(threadId: string): MemoryJournalEntry[] {
  const bots = turnBots.get(threadId);
  if (!bots) return [];
  turnBots.delete(threadId);
  const rows: MemoryJournalEntry[] = [];
  for (const botId of bots) {
    try {
      rows.push(...reconcile(botId, "bot", "turn", threadId, true));
    } catch (error) {
      console.error(`memory-journal: could not diff ${botId}:`, error instanceof Error ? error.message : error);
    }
  }
  return rows;
}

/** Test seam: forget every baseline and in-flight turn. */
export function resetMemoryJournalState(): void {
  baselines.clear();
  turnBots.clear();
}

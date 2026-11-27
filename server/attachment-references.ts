// Which stored uploads no remaining message names, for the clean-ups that remove uploads after a delete
// (host/delete-leftovers.ts, host/team-member-left.ts). Asking SQLite once per name (instr over every row's JSON) is a
// full read of the transcripts per name: thousands of them, on the main thread, held a large Cloud's server for minutes.
// Here one pass over the rows checks every name at once, with the same rule as instr (the name anywhere in the row's
// JSON), in short slices that give the event loop back between them; the files then go a batch at a time.
//
// One pass runs at a time: names asked for while one runs wait, together, for the next. Nothing is kept on disk, so a
// restart replays nothing (an upload a restart cut off stays, as any upload a message still names does).
//
// Safety: unsure means kept. A pass that fails, or finds messages.db reopened under it, removes nothing; a message
// written while the pass or its removals run is checked too (message-writes.ts); a name found once stays found.
import type { StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";

import { prepared } from "./message-db.ts";
import { watchMessageWrites } from "./message-writes.ts";

export interface MessageRow { rowid: number; json: string }
/** At most `limit` message rows with a rowid above `after`, in rowid order. */
export type MessageRows = (after: number, limit: number) => readonly MessageRow[];

export interface AttachmentReferencesDeps {
  /** A reader for one pass. The default reads messages.db, and throws when the database was reopened during the pass. */
  rows?: () => MessageRows;
  watchWrites?: (listener: (json: string) => void) => () => void;
  now?: () => number;
  /** Gives the event loop back between slices. */
  pause?: () => Promise<void>;
  /** How long one slice of the pass may hold the event loop. */
  sliceMs?: number;
  rowsPerRead?: number;
  /** Names handed to one removal call. */
  batch?: number;
}

/** Removes the names given (none a remaining message names, as of the call); answers how many went. Must not throw. */
export type RemoveBatch = (names: readonly string[]) => number;

export interface AttachmentReferences {
  /** Hands `remove` every one of `names` no message names, a batch at a time, after one pass over the rows. Resolves with
   * how many went; rejects, having removed nothing, when the pass could not finish. */
  removeUnreferenced(names: Iterable<string>, remove: RemoveBatch): Promise<number>;
  /** Passes run so far. */
  readonly passes: number;
}

const ROWS_SQL = "SELECT rowid, json FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?";
/** Matcher tables above this many entries are split, so a long list of names never takes much memory at once. */
const MAX_TABLE_ENTRIES = 8_000_000;

/** messages.db read a slice at a time; throws when the database was reopened since this reader's first read. */
export function messageDbRows(): MessageRows {
  let first: StatementSync | undefined;
  return (after, limit) => {
    const statement = prepared(ROWS_SQL);
    if ((first ??= statement) !== statement) throw new Error("messages.db was reopened during the check");
    return statement.all(after, limit) as unknown as MessageRow[];
  };
}

/** Every name of a list found anywhere in a text, in one read of the text (Aho-Corasick, as one table per character). */
class NameMatcher {
  private readonly symbols = new Uint16Array(65_536);
  private readonly width: number;
  private readonly next: Int32Array;
  /** The name ending at each state, or -1; and the nearest shorter state that ends a name, or 0. */
  private readonly ends: Int32Array;
  private readonly shorter: Int32Array;
  private readonly names: readonly string[];

  constructor(names: readonly string[]) {
    this.names = names;
    let width = 1;
    let states = 1;
    for (const name of names) {
      states += name.length;
      for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (!this.symbols[code]) this.symbols[code] = width++;
      }
    }
    this.width = width;
    const next = this.next = new Int32Array(states * width).fill(-1);
    const ends = this.ends = new Int32Array(states).fill(-1);
    const shorter = this.shorter = new Int32Array(states);
    let made = 1;
    names.forEach((name, index) => {
      let state = 0;
      for (let i = 0; i < name.length; i++) {
        const at = state * width + this.symbols[name.charCodeAt(i)]!;
        if (next[at] === -1) next[at] = made++;
        state = next[at]!;
      }
      ends[state] = index;
    });
    // Breadth first: a state's fallback (its longest proper suffix that is also a prefix) is settled before its children.
    const fallback = new Int32Array(made);
    const queue = new Int32Array(made);
    let head = 0, tail = 0;
    for (let symbol = 0; symbol < width; symbol++) {
      const child = next[symbol]!;
      if (child === -1) next[symbol] = 0;
      else if (child !== 0) queue[tail++] = child;
    }
    while (head < tail) {
      const state = queue[head++]!;
      const back = fallback[state]!;
      shorter[state] = ends[back]! >= 0 ? back : shorter[back]!;
      for (let symbol = 0; symbol < width; symbol++) {
        const at = state * width + symbol;
        const child = next[at]!;
        if (child === -1) { next[at] = next[back * width + symbol]!; continue; }
        fallback[child] = next[back * width + symbol]!;
        queue[tail++] = child;
      }
    }
    // A character no name has leads back to the start.
    for (let state = 0; state < made; state++) next[state * width] = 0;
  }

  /** Adds to `found` each name `text` holds. */
  read(text: string, found: Set<string>): void {
    const { next, width, symbols, ends, shorter, names } = this;
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      state = next[state * width + symbols[text.charCodeAt(i)]!]!;
      for (let at = state; at !== 0; at = shorter[at]!) if (ends[at]! >= 0) found.add(names[ends[at]!]!);
    }
  }
}

/** One matcher per part of the list that fits MAX_TABLE_ENTRIES. */
function matchers(names: readonly string[]): NameMatcher[] {
  const characters = new Set<number>();
  for (const name of names) for (let i = 0; i < name.length; i++) characters.add(name.charCodeAt(i));
  const width = characters.size + 1;
  const parts: string[][] = [];
  let part: string[] = [];
  let entries = 0;
  for (const name of names) {
    const cost = name.length * width;
    if (part.length && entries + cost > MAX_TABLE_ENTRIES) { parts.push(part); part = []; entries = 0; }
    part.push(name);
    entries += cost;
  }
  if (part.length) parts.push(part);
  return parts.map((list) => new NameMatcher(list));
}

interface Request { names: string[]; remove: RemoveBatch; resolve: (removed: number) => void; reject: (error: unknown) => void }

export function createAttachmentReferences(deps: AttachmentReferencesDeps = {}): AttachmentReferences {
  const rowsFor = deps.rows ?? messageDbRows;
  const watchWrites = deps.watchWrites ?? watchMessageWrites;
  const now = deps.now ?? (() => performance.now());
  const pause = deps.pause ?? (() => nextTurn());
  const sliceMs = deps.sliceMs ?? 15;
  const rowsPerRead = deps.rowsPerRead ?? 64;
  const batch = deps.batch ?? 25;
  let waiting: Request[] = [];
  let running = false;
  let passes = 0;

  /** Reads every row once, a slice at a time, until each name is found or the rows run out. */
  async function scan(all: readonly string[], read: (text: string) => void, found: ReadonlySet<string>): Promise<void> {
    const rows = rowsFor();
    let after = 0;
    // Rows read but not yet checked when a slice ran out of time; a row changed meanwhile is checked again as written.
    let slice: readonly MessageRow[] = [];
    let at = 0;
    for (;;) {
      await pause();
      const started = now();
      do {
        if (at === slice.length) {
          slice = rows(after, rowsPerRead);
          at = 0;
          if (!slice.length) return;
        }
        const row = slice[at++]!;
        read(row.json);
        after = row.rowid;
        if (found.size === all.length) return;
      } while (now() - started < sliceMs);
    }
  }

  async function pass(requests: readonly Request[]): Promise<void> {
    passes++;
    const all = [...new Set(requests.flatMap((request) => request.names))];
    const found = new Set<string>();
    const readers = matchers(all);
    const read = (text: string) => { for (const reader of readers) reader.read(text, found); };
    const stop = watchWrites(read);
    try {
      try {
        await scan(all, read, found);
      } catch (error) {
        for (const request of requests) request.reject(error);
        return;
      }
      let started = now();
      for (const request of requests) {
        const left = request.names.filter((name) => !found.has(name));
        let removed = 0;
        for (let at = 0; at < left.length; at += batch) {
          if (now() - started >= sliceMs) { await pause(); started = now(); }
          const going = left.slice(at, at + batch).filter((name) => !found.has(name));
          try { if (going.length) removed += request.remove(going); } catch { /* the remover warns for itself */ }
        }
        request.resolve(removed);
      }
    } finally {
      stop();
    }
  }

  async function drain(): Promise<void> {
    running = true;
    try {
      while (waiting.length) {
        const requests = waiting;
        waiting = [];
        await pass(requests).catch((error: unknown) => { for (const request of requests) request.reject(error); });
      }
    } finally {
      running = false;
    }
  }

  return {
    removeUnreferenced(names, remove) {
      const list = [...new Set(names)].filter((name) => name !== "");
      if (!list.length) return Promise.resolve(0);
      return new Promise<number>((resolve, reject) => {
        waiting.push({ names: list, remove, resolve, reject });
        if (!running) void drain();
      });
    },
    get passes() { return passes; },
  };
}

/** The server's one: every clean-up shares it, so only one pass over messages.db runs at a time. */
export const attachmentReferences = createAttachmentReferences();

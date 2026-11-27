// Which conversations' messages name a stored upload (message-db.ts threadsReferencing). Asking SQLite once per name
// (instr over every row's JSON) is a full read of messages.db per name, on the main thread: a 740k-row install held its
// server for 79 s per refused hand-off file. This in-memory index answers the question per name without
// reading any row.
//
// saveFile/saveImage/saveAudio only ever store `${uuid}${extension}`, so every name these queries ask for is one shape:
// a lowercase uuid with an extension. threadsFor answers only that shape; anything else falls back to the SQL scan in
// message-db.ts, which is the answer instr gives. Exactness rule: a name is indexed where it appears in a row's JSON as
// a whole token (the character after the extension is not alphanumeric, as it never is in a path the server writes).
// instr also matches a name inside a longer token (its ".png" inside a ".png2"); no reference the server writes does
// that, so a lookup sees every row instr would.
//
// The index is built on the first uuid-shaped query: one pass over the rows, the read threadsReferencing already did,
// with no write able to interleave (the build holds the only thread that writes). Rows written before it are covered by
// the pass; rows written after go through written; row removals through threadsDeleted. A reopened database resets the
// index, and the next query rebuilds it from the rows that are there then.
import type { StatementSync } from "node:sqlite";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** A name saveFile/saveImage/saveAudio store: `${uuid}${extension}`. Uppercase uuids (a client may send one) never
 * match here and take the scan, where instr is case-exact too. */
export const STORED_UPLOAD_NAME = new RegExp(`^${UUID}\\.[A-Za-z0-9]{1,10}$`);

const NAME_IN_JSON = new RegExp(`(?<![0-9A-Za-z])${UUID}\\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])`, "g");

const ROWS_SQL = "SELECT rowid, thread_id, id, json FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?";
/** Rows per build slice, so one pass never holds a large transcript's JSON in memory at once. */
const ROWS_PER_PASS = 512;

export interface AttachmentNameRow { rowid: number; thread_id: string; id: string; json: string }
export type AttachmentNameRows = (after: number, limit: number) => readonly AttachmentNameRow[];

export interface AttachmentNameIndex {
  /** Records the names `json` holds now, replacing what this row held before. Nothing until the first build. */
  written(threadId: string, messageId: string, json: string): void;
  /** Forgets every row of the threads given. */
  threadsDeleted(threadIds: readonly string[]): void;
  /** The threads whose messages name `name`, a stored upload name; builds the index first. */
  threadsFor(name: string): string[];
  /** Forgets everything; the next query rebuilds from the rows that are there then. */
  reset(): void;
  /** Builds so far. */
  readonly builds: number;
}

export function createAttachmentNameIndex(deps: { prepare: (sql: string) => StatementSync }): AttachmentNameIndex {
  /** name → threadId → the message ids of that thread that hold the name. */
  const byName = new Map<string, Map<string, Set<string>>>();
  /** threadId → messageId → the names that message holds. */
  const byThread = new Map<string, Map<string, ReadonlySet<string>>>();
  let built = false;
  let builds = 0;

  function namesIn(json: string): ReadonlySet<string> {
    const found = new Set<string>();
    for (const match of json.matchAll(NAME_IN_JSON)) found.add(match[0]);
    return found;
  }

  function drop(threadId: string, messageId: string, names: ReadonlySet<string>): void {
    for (const name of names) {
      const threads = byName.get(name)!;
      const messages = threads.get(threadId)!;
      messages.delete(messageId);
      if (!messages.size) threads.delete(threadId);
      if (!threads.size) byName.delete(name);
    }
  }

  function record(threadId: string, messageId: string, names: ReadonlySet<string>): void {
    const thread = byThread.get(threadId);
    const previous = thread?.get(messageId);
    if (previous) drop(threadId, messageId, previous);
    if (!names.size) {
      if (previous) {
        thread!.delete(messageId);
        if (!thread!.size) byThread.delete(threadId);
      }
      return;
    }
    const messages = thread ?? new Map<string, ReadonlySet<string>>();
    if (!thread) byThread.set(threadId, messages);
    messages.set(messageId, names);
    for (const name of names) {
      let threads = byName.get(name);
      if (!threads) byName.set(name, threads = new Map());
      let ids = threads.get(threadId);
      if (!ids) threads.set(threadId, ids = new Set());
      ids.add(messageId);
    }
  }

  function build(): void {
    byName.clear();
    byThread.clear();
    let first: StatementSync | undefined;
    const read: AttachmentNameRows = (after, limit) => {
      const statement = deps.prepare(ROWS_SQL);
      if ((first ??= statement) !== statement) throw new Error("messages.db was reopened during the attachment-name index build");
      return statement.all(after, limit) as unknown as AttachmentNameRow[];
    };
    let after = 0;
    for (;;) {
      const slice = read(after, ROWS_PER_PASS);
      if (!slice.length) break;
      for (const row of slice) record(row.thread_id, row.id, namesIn(row.json));
      after = slice[slice.length - 1]!.rowid;
    }
    built = true;
    builds++;
  }

  return {
    written(threadId, messageId, json) {
      if (!built) return;
      record(threadId, messageId, namesIn(json));
    },
    threadsDeleted(threadIds) {
      if (!built) return;
      for (const threadId of threadIds) {
        const thread = byThread.get(threadId);
        if (!thread) continue;
        for (const [messageId, names] of thread) drop(threadId, messageId, names);
        byThread.delete(threadId);
      }
    },
    threadsFor(name) {
      if (!built) build();
      return [...(byName.get(name)?.keys() ?? [])];
    },
    reset() {
      built = false;
      byName.clear();
      byThread.clear();
    },
    get builds() { return builds; },
  };
}

// A delete of conversations holding thousands of uploads, against a transcript store of tens of thousands of rows: the
// check of which uploads a remaining message still names is one pass over the rows in short slices, so the server keeps
// answering while it runs, and it keeps and removes exactly the files the old per-name check did.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAttachmentReferences, messageDbRows } from "../attachment-references.ts";
import { deleteAttachments } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import * as mdb from "../message-db.ts";
import type { Message } from "../store.ts";
import { createDeleteLeftovers, type DeleteLeftoversDeps } from "./delete-leftovers.ts";

const NAMES = 2_000;
const DELETED_THREADS = 20;
const REMAINING_THREADS = 100;
const ROWS_PER_THREAD = 500;
const FILLER = "lorem ipsum dolor sit amet, ".repeat(45);
const MEMBER = "p_bobbobbobbobbobbobbobb";

const name = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000.png`;
const names = Array.from({ length: NAMES }, (_, i) => name(i));
/** Every third name stays named by a remaining conversation, in one of the ways a message names a file. */
const referenced = new Set(names.filter((_, i) => i % 3 === 0));
const kept = new Set(names.filter((_, i) => i % 3 !== 0 && i % 40 === 1));
const pictured = new Set(names.filter((_, i) => i % 3 !== 0 && i % 40 === 2));
const ways = [
  (file: string) => `![image](/api/attachments/${file})`,
  (file: string) => `the file ${file} from before`,
  (file: string) => `copy-of-${file}.bak`,
  (file: string) => `<attached-file path="C:\\data\\attachments\\${file}" />`,
];

let rowCount = 0;
const message = (thread: string, row: number, text: string): Message =>
  ({ id: `${thread}-m${row}`, at: 1_700_000_000_000 + row, role: row % 2 ? "bot" : "user", kind: "text", text, detail: FILLER }) as unknown as Message;

beforeAll(() => {
  mkdirSync(join(DATA_DIR, "attachments"), { recursive: true });
  for (const file of names) writeFileSync(join(DATA_DIR, "attachments", file), "x");
  mkdirSync(join(DATA_DIR, "people", MEMBER), { recursive: true });
  writeFileSync(join(DATA_DIR, "people", MEMBER, "profile.json"), JSON.stringify({ name: "Bob", avatarUrl: `/api/attachments/${[...pictured][0]}`, more: [...pictured].map((file) => `/api/attachments/${file}`) }));
  const naming = [...referenced];
  for (let t = 0; t < REMAINING_THREADS; t++) {
    const thread = `keep${t}`;
    mdb.importThread(thread, Array.from({ length: ROWS_PER_THREAD }, (_, row) => {
      const at = t * ROWS_PER_THREAD + row;
      const file = at % 75 === 0 ? naming[(at / 75) % naming.length] : undefined;
      return message(thread, row, file ? ways[at % ways.length]!(file) : `line ${at}`);
    }), null);
  }
  rowCount = REMAINING_THREADS * ROWS_PER_THREAD;
  // A box uploads folder for many conversations, each with a copy of some uploads and a file of its own.
  for (let t = 0; t < 300; t++) {
    const folder = join(DATA_DIR, "box-uploads", "scout", `other${t}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "own.txt"), "x");
    for (let i = t; i < NAMES; i += 150) writeFileSync(join(folder, name(i)), "x");
  }
}, 120_000);

afterAll(() => {
  mdb.closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("deleting conversations that hold thousands of uploads", () => {
  it("never holds the event loop for long, reads each remaining row once, and removes exactly what the old check removed", async () => {
    expect(referenced.size).toBe(Math.ceil(NAMES / 3));
    // Every name planted in the remaining rows is there; the old check would keep it.
    expect(rowCount).toBe(50_000);
    const conversations = new Map<string, unknown[]>();
    for (let t = 0; t < DELETED_THREADS; t++) {
      const thread = `gone${t}`;
      const held = names.filter((_, i) => i % DELETED_THREADS === t);
      const rows = held.map((file, row) => message(thread, row, `![image](/api/attachments/${file})`));
      mdb.importThread(thread, rows, null);
      conversations.set(thread, rows);
    }
    let reads = 0, read = 0, pauses = 0;
    const references = createAttachmentReferences({
      rows: () => { const inner = messageDbRows(); return (after, limit) => { reads++; const slice = inner(after, limit); read += slice.length; return slice; }; },
      pause: () => new Promise((done) => { pauses++; setImmediate(done); }),
    });
    let listener: (change: { type: string; threadId?: string }) => void = () => {};
    const store: DeleteLeftoversDeps["store"] = { bots: [], messagesFor: (threadId) => conversations.get(threadId) ?? [], onChange: (added) => { listener = added; }, threadsGoing: () => {} };
    const warnings: string[] = [];
    const leftovers = createDeleteLeftovers({
      dataDir: DATA_DIR,
      store,
      references,
      keptAttachments: () => kept,
      deleteAttachments: (files) => deleteAttachments(files.map((file) => join(DATA_DIR, "attachments", file))),
      engineFolders: () => ({ claude: [], codex: [], pi: [] }),
      layers: { journalFile: (layer) => join(DATA_DIR, "memory-journal", `${layer}.ndjson`), forget: () => {} },
      defer: () => {},
      warn: (line) => { warnings.push(line); },
    });
    const gone = [...conversations.keys()];
    store.threadsGoing(gone);
    mdb.deleteThreads(gone);
    for (const thread of gone) listener({ type: "thread.deleted", threadId: thread });

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    await leftovers.flush();
    delay.disable();
    const longestMs = delay.max / 1e6;

    expect(warnings).toEqual([]);
    // One pass: every remaining row read once, in many short reads with the event loop given back between slices.
    expect(references.passes).toBe(1);
    expect(read).toBe(rowCount);
    expect(reads).toBeGreaterThan(rowCount / 64);
    expect(pauses).toBeGreaterThan(10);
    // Loose on purpose (slow disks on CI): the old check held it for minutes in one turn; the counts above are the hard part.
    expect(longestMs).toBeLessThan(10_000);

    const stored = (file: string) => existsSync(join(DATA_DIR, "attachments", file));
    const expected = (file: string) => referenced.has(file) || kept.has(file) || pictured.has(file);
    expect(names.filter((file) => stored(file) !== expected(file))).toEqual([]);
    expect(names.filter((file) => !stored(file)).length).toBe(NAMES - referenced.size - kept.size - pictured.size);
    // The old per-name check agrees, on a sample of both kinds.
    for (const file of [...names.filter((f) => referenced.has(f)).slice(0, 20), ...names.filter((f) => !expected(f)).slice(0, 20)]) {
      expect(mdb.threadsReferencing(file).length > 0, file).toBe(referenced.has(file));
    }
    // A removed upload's copies go from every box uploads folder; a kept one's and the folders' own files stay.
    const copies = (i: number) => existsSync(join(DATA_DIR, "box-uploads", "scout", `other${i % 150}`, name(i)));
    expect(names.map((_, i) => i).filter((i) => copies(i) !== expected(name(i)))).toEqual([]);
    expect(existsSync(join(DATA_DIR, "box-uploads", "scout", "other7", "own.txt"))).toBe(true);
  }, 300_000);
});

// Who each thread is for, when a signed-in person can be named: the person
// who opened it from a session, or — for a thread a bot opened while working
// on someone's request — the person that request came from. One small
// server-private file (<data>/thread-starters.json, 0600), never sent to a
// client and never part of a bot or room record, so no wire projection can
// leak it. It decides one thing only: on a workspace several people share,
// whose session may answer the cards raised in that thread
// (server/index.ts cardAnswerRefusal). A thread with no entry names nobody,
// and then anyone who may chat may answer, as before.
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";

const KEY = /^p_[\w-]{22}$/;
const THREAD = /^[\w-]{1,128}$/;
/** Oldest entries go first past this; a thread that old has long settled. */
const MAX_ENTRIES = 50_000;

export class ThreadStarters {
  private readonly starters = new Map<string, string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // absent or unreadable: nobody is named, which is today's behaviour
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [threadId, person] of Object.entries(raw)) {
      if (THREAD.test(threadId) && typeof person === "string" && KEY.test(person)) this.starters.set(threadId, person);
    }
  }

  get(threadId: string): string | undefined {
    return this.starters.get(threadId);
  }

  /** Record once; a thread keeps the person it was first opened for. */
  set(threadId: string, person: string | undefined): void {
    if (!person || !KEY.test(person) || !THREAD.test(threadId) || this.starters.has(threadId)) return;
    this.starters.set(threadId, person);
    while (this.starters.size > MAX_ENTRIES) this.starters.delete(this.starters.keys().next().value!);
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.starters)) + "\n", { mode: 0o600 });
    } catch (error) {
      // Kept in memory for this run; after a restart the thread names nobody.
      console.warn(`thread starters: could not save ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

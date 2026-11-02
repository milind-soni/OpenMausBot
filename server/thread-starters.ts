// Who each thread is for (server-private, 0600, never on the wire): decides whose session may answer its cards on a shared workspace.
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";

const KEY = /^p_[\w-]{22}$/;
const THREAD = /^[\w-]{1,128}$/;
const MAX_ENTRIES = 50_000;

export class ThreadStarters {
  private starters = new Map<string, string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [threadId, person] of Object.entries(raw)) {
      if (THREAD.test(threadId) && typeof person === "string" && KEY.test(person)) this.starters.set(threadId, person);
    }
  }

  get(threadId: string): string | undefined {
    return this.starters.get(threadId);
  }

  threadsOf(person: string, limit: number): string[] {
    const threads: string[] = [];
    for (const [threadId, starter] of [...this.starters].reverse()) {
      if (starter !== person) continue;
      threads.push(threadId);
      if (threads.length >= limit) break;
    }
    return threads;
  }

  people(): Set<string> {
    return new Set(this.starters.values());
  }

  reassign(move: (person: string) => boolean, to: string): string[] {
    if (!KEY.test(to)) return [];
    const starters = new Map(this.starters);
    const moved: string[] = [];
    for (const [threadId, person] of this.starters) {
      if (person === to || !move(person)) continue;
      starters.set(threadId, to);
      moved.push(threadId);
    }
    if (moved.length) this.save(starters);
    return moved;
  }

  /** Record once; a thread keeps the person it was first opened for. */
  set(threadId: string, person: string | undefined): void {
    if (!person || !KEY.test(person) || !THREAD.test(threadId) || this.starters.has(threadId)) return;
    if (this.starters.size >= MAX_ENTRIES) throw new Error("Thread owner registry is full");
    const starters = new Map(this.starters);
    starters.set(threadId, person);
    this.save(starters);
  }

  private save(starters: Map<string, string>): void {
    writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(starters)) + "\n", { mode: 0o600 });
    this.starters = starters;
  }
}

// Which bot each engine process runs for, on every host. engine-memory.ts tracks engines only where turns wait for room;
// this record is kept everywhere so the per-bot footprint (perf/bot-footprint.ts) can name a bot's processes on the
// desktop and on a server without limits too. An engine is recorded when spawnCli starts it inside a turn (the turn's
// scope, crash-guard.ts, names the bot and conversation), and a shared engine process (ACP's) gains and loses
// conversations as their sessions attach and detach. An engine that exits stays on record while anything it started still
// runs in its process group or session, so what outlived its turn is still counted against its bot.
import { currentTurn } from "./crash-guard.ts";

/** One engine process: the conversations it serves now (conversation id to bot id, "" where the turn named none). */
export interface EngineOwner {
  pid: number;
  /** Its start time as the process list shows it (Linux's start tick), where read at spawn: a reused pid is not it. */
  start: string | null;
  threads: ReadonlyMap<string, string>;
  exited: boolean;
  /** Other conversations may join it (a shared ACP process). */
  shareable: boolean;
}

const MAX_ENTRIES = 4_096;

interface Entry { pid: number; start: string | null; threads: Map<string, string>; exited: boolean; seenSinceExit: number; shareable: boolean }

export class EngineOwners {
  readonly #entries = new Map<number, Entry>();

  /** An engine process spawnCli just started for a bot. Outside a turn (a keep-warm ping, a probe) it serves no
   * conversation yet: it counts as shared until one attaches. */
  track(child: { pid?: number; once(event: "exit", listener: () => void): unknown }, start: string | null): void {
    const pid = child.pid;
    if (!pid) return;
    const turn = currentTurn();
    const entry: Entry = { pid, start, threads: new Map(turn?.threadId ? [[turn.threadId, turn.botId ?? ""]] : []), exited: false, seenSinceExit: 0, shareable: false };
    this.#entries.set(pid, entry);
    // Where no process list ever prunes it (no sampler runs), the oldest exited engines go first.
    if (this.#entries.size > MAX_ENTRIES) for (const [other, old] of this.#entries) { if (this.#entries.size <= MAX_ENTRIES) break; if (old.exited) this.#entries.delete(other); }
    child.once("exit", () => { if (this.#entries.get(pid) === entry) entry.exited = true; });
  }

  /** A conversation's session now runs in this engine process too (a shared ACP process). */
  attach(child: { pid?: number }, threadId: string): void {
    const entry = child.pid ? this.#entries.get(child.pid) : undefined;
    if (!entry || entry.threads.has(threadId)) return;
    const turn = currentTurn();
    entry.threads.set(threadId, turn?.threadId === threadId ? turn.botId ?? "" : "");
  }

  /** Other conversations may join this engine process (a shared ACP process): the memory cap never stops it. */
  shareable(child: { pid?: number }): void {
    const entry = child.pid ? this.#entries.get(child.pid) : undefined;
    if (entry) entry.shareable = true;
  }

  detach(child: { pid?: number }, threadId: string): void {
    if (child.pid) this.#entries.get(child.pid)?.threads.delete(threadId);
  }

  list(): EngineOwner[] {
    return [...this.#entries.values()].map((entry) => ({ pid: entry.pid, start: entry.start, threads: entry.threads, exited: entry.exited, shareable: entry.shareable }));
  }

  /** After each process list: forgets an exited engine that no process, group or session in it still names, and one whose
   * pid the list shows as another process (the system gave the number on, which it does only once no group or session
   * still has it: nothing the engine left runs any more). Retired at the first sight, it stays retired: once that other
   * process exits, its pid is not the engine's again. Where the engine's start was not read (off Linux) the list shows
   * no start to tell them apart; an exited engine was reaped before it was marked so, and the pid seen in two lists after
   * that is another process's. */
  prune(rows: readonly { pid: number; start: string; pgid?: number; sid?: number }[]): void {
    const inUse = new Set<number>(), starts = new Map<number, string>();
    for (const row of rows) { inUse.add(row.pid); starts.set(row.pid, row.start); if (row.pgid !== undefined) inUse.add(row.pgid); if (row.sid !== undefined) inUse.add(row.sid); }
    for (const [pid, entry] of this.#entries) {
      if (!entry.exited) continue;
      const start = starts.get(pid);
      if (!inUse.has(pid)) this.#entries.delete(pid);
      else if (start === undefined) continue;
      else if (entry.start !== null ? start !== entry.start : (entry.seenSinceExit += 1) >= 2) this.#entries.delete(pid);
    }
  }
}

export const engineOwners = new EngineOwners();

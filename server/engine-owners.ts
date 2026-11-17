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
}

const MAX_ENTRIES = 4_096;

interface Entry { pid: number; start: string | null; threads: Map<string, string>; exited: boolean }

export class EngineOwners {
  readonly #entries = new Map<number, Entry>();

  /** An engine process spawnCli just started for a bot. Outside a turn (a keep-warm ping, a probe) it serves no
   * conversation yet: it counts as shared until one attaches. */
  track(child: { pid?: number; once(event: "exit", listener: () => void): unknown }, start: string | null): void {
    const pid = child.pid;
    if (!pid) return;
    const turn = currentTurn();
    const entry: Entry = { pid, start, threads: new Map(turn?.threadId ? [[turn.threadId, turn.botId ?? ""]] : []), exited: false };
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

  detach(child: { pid?: number }, threadId: string): void {
    if (child.pid) this.#entries.get(child.pid)?.threads.delete(threadId);
  }

  list(): EngineOwner[] {
    return [...this.#entries.values()].map((entry) => ({ pid: entry.pid, start: entry.start, threads: entry.threads, exited: entry.exited }));
  }

  /** Forgets exited engines that nothing in `inUse` (the process groups and sessions a process list shows) still names. */
  prune(inUse: ReadonlySet<number>): void {
    for (const [pid, entry] of this.#entries) if (entry.exited && !inUse.has(pid)) this.#entries.delete(pid);
  }
}

export const engineOwners = new EngineOwners();

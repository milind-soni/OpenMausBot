// Whether an engine that left a view's status read unanswered has hung, or is only slow: starting on a busy machine, or
// on a Cloud whose shared CPU is throttled. Only a hung one is reset.
import { readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

import { browserDaemonFile } from "../browser-engine.ts";
import { processAlive } from "../browser-processes.ts";

const STATUS_READ_MS = 10_000;
const MOST_LOAD_FACTOR = 3;
/** An engine that answered this recently is making progress. */
const ANSWERED_RECENTLY_MS = 60_000;
/** How long unanswered status reads go on before the engine counts as hung: while it is still starting or answered
 * recently, and while it was silent for longer before. */
const SLOW_LIMIT_MS = { progressing: 3 * 60_000, silent: 30_000 };

/** The status read's limit: longer while the machine runs more work than it has processors for. */
export function statusReadMs(load = loadavg()[0] ?? 0, processors = availableParallelism()): number {
  const factor = Math.min(MOST_LOAD_FACTOR, Math.max(1, load / Math.max(1, processors)));
  return Math.round(STATUS_READ_MS * factor);
}

/** The engine's daemon for a session is starting (no pid file yet) or running; false once its process is gone. */
export function engineDaemonAlive(env: NodeJS.ProcessEnv): boolean {
  let pid: number;
  try { pid = Number(readFileSync(browserDaemonFile(env, ".pid"), "utf8").trim()); } catch { return true; }
  return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid);
}

export type EngineVerdict = "slow" | "hung";

/** When each session's engine last answered anything, and since when it has been slow. */
export class EngineProgress {
  readonly #now: () => number;
  readonly #answered = new Map<string, number>();
  readonly #slowSince = new Map<string, number>();

  constructor(now: () => number = Date.now) { this.#now = now; }

  answered(session: string): void {
    this.#answered.set(session, this.#now());
    this.#slowSince.delete(session);
  }

  /** After an unanswered status read: hung once its process is gone, or once reads went unanswered past the limit. Never
   * hung while a person holds the browser, who would lose it without being told. */
  verdict(session: string, { alive, held }: { alive: boolean; held: boolean }): EngineVerdict {
    const now = this.#now();
    if (!alive) return "hung";
    if (held) return "slow";
    const answered = this.#answered.get(session);
    const since = this.#slowSince.get(session) ?? now;
    this.#slowSince.set(session, since);
    const progressing = answered === undefined || now - answered < ANSWERED_RECENTLY_MS;
    return now - since < SLOW_LIMIT_MS[progressing ? "progressing" : "silent"] ? "slow" : "hung";
  }

  /** A reset session starts over. */
  forget(session: string): void {
    this.#answered.delete(session);
    this.#slowSince.delete(session);
  }
}

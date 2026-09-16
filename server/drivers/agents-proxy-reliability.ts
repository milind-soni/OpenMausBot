// The pure half of the agents proxy's tool reliability layer (Phase 2
// part 2): the four bounds every harness call gets, which calls may be
// retried, the errors that say what to do next, and the result cap. Kept
// apart from agents-proxy.ts, which starts a server on import, so tests
// can read these without launching a proxy.

/** Total wall time for one harness call. */
export const TOOL_CALL_TIMEOUT_MS = 60_000;
/** A read that failed on the network is tried once more after this. */
export const TOOL_RETRY_DELAY_MS = 750;
/** A tool result longer than this is cut: the head goes to the model, the
 * whole text is kept by the harness and fetched with tool_result_read. */
export const TOOL_RESULT_MAX_CHARS = 24_000;
export const TOOL_RESULT_HEAD_CHARS = 16_000;

/** Reads are safe to retry; every other path is a write and is not. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);
const RETRYABLE_POSTS = new Set(["/api/internal/session-search", "/api/internal/task-list"]);

export function isIdempotent(path: string, init?: { method?: string }): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return IDEMPOTENT_METHODS.has(method) || RETRYABLE_POSTS.has(path.split("?")[0]!);
}

/** What the model is told when the harness did not answer. Names the
 * bound that fired and the next move, never a stack trace. */
export function teachingError(path: string, error: unknown, retried: boolean): Error {
  const name = error instanceof Error ? error.name : "";
  const tool = path.replace(/^\/api\/internal\//, "").split("?")[0];
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error(`${tool} did not answer within ${TOOL_CALL_TIMEOUT_MS / 1000} seconds${retried ? " (tried twice)" : ""}. Do not loop on it: continue with what you have, and tell the person this tool timed out if the task depended on it.`);
  }
  return new Error(`${tool} could not reach OpenMausBot (${error instanceof Error ? error.message : String(error)})${retried ? ", tried twice" : ""}. This is the app, not your input: continue without it and tell the person the tool was unavailable.`);
}

/** The tools that stay listed under deferred loading (Phase 2 part 3).
 * The board's two are core while the board is on: filing work for later
 * is a front door, and a model that cannot see it reaches for a connected
 * app instead. */
export function coreToolNames(boardOn: boolean): Set<string> {
  return new Set(["list_bots", "session_search", "session_read", "memory_update", "tool_result_read", "post_to_room", ...(boardOn ? ["task_create", "task_list"] : [])]);
}

// ── Phase 3 part 3: the loop breaker ────────────────────────────────────
// A bot that keeps making the same failing call learns nothing from the
// repeat. The third identical failure gets a note, the fifth is refused
// before it runs. A success on the same key clears the count, and keys are
// bounded so one pathological session cannot grow the proxy forever.
export const LOOP_WARN_AT = 3;
export const LOOP_REFUSE_AT = 5;
const LOOP_MAX_KEYS = 256;

export class LoopBreaker {
  private readonly failures = new Map<string, number>();

  key(name: string, args: unknown): string {
    let serialized: string;
    try { serialized = JSON.stringify(args ?? {}); } catch { serialized = String(args); }
    return `${name}:${serialized}`;
  }

  /** The refusal text when this call has failed LOOP_REFUSE_AT-1 times already, else null. */
  refusal(key: string): string | null {
    const count = this.failures.get(key) ?? 0;
    if (count < LOOP_REFUSE_AT - 1) return null;
    this.failures.set(key, count + 1);
    return `Refused: this exact call has failed ${count} times in a row and was not run again. Stop repeating it — change the arguments or the approach, or say plainly what is blocking you.`;
  }

  /** Record the outcome. Returns a note to append to the error on the LOOP_WARN_AT-th failure, else null. */
  record(key: string, failed: boolean): string | null {
    if (!failed) {
      this.failures.delete(key);
      return null;
    }
    if (!this.failures.has(key) && this.failures.size >= LOOP_MAX_KEYS) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    if (count === LOOP_WARN_AT) return `Note from the harness: this is the ${count}rd identical failing call. Change approach or say what is blocking you; the ${LOOP_REFUSE_AT}th identical call will be refused.`;
    return null;
  }
}

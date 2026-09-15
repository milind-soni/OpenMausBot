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

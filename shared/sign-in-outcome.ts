// Why an engine sign-in ended (or why a try inside it did not count), as fixed codes: the server's sign-in status and error
// bodies carry one as `reason`, and a Cloud home's sign-in trace (server/sign-in-trace.ts) counts them. Never words.

export const SIGN_IN_OUTCOMES = [
  /** Signed in. */
  "completed",
  /** A pasted code that is not a code at all (too short, spaces): refused before it reached the engine; the sign-in stays open. */
  "wrong_code",
  /** The provider refused the code or the sign-in. */
  "refused",
  /** The sign-in's own time ran out. */
  "expired",
  /** The person cancelled it. */
  "cancelled",
  /** The engine's login command ended before the sign-in finished. */
  "exited",
  /** The server stopped (a restart, a stop for sleep), the engine's settings changed, or the session that started it ended. */
  "interrupted",
  /** The engine's command is not on this server. */
  "not_installed",
  /** The engine showed no link or code in time, or did not finish after the code was entered. */
  "timed_out",
  /** Anything else. */
  "failed",
] as const;
export type SignInOutcome = (typeof SIGN_IN_OUTCOMES)[number];

const OUTCOMES: ReadonlySet<string> = new Set(SIGN_IN_OUTCOMES);
export const signInOutcome = (value: unknown): SignInOutcome | null => typeof value === "string" && OUTCOMES.has(value) ? value as SignInOutcome : null;

/** An error that says why with a code (`reason`), for the status and error bodies. */
export function withSignInReason<T extends Error>(error: T, reason: SignInOutcome): T & { reason: SignInOutcome } {
  return Object.assign(error, { reason });
}

/** The code an error carries, if it is one of ours. */
export const signInReasonOf = (error: unknown): SignInOutcome | null =>
  error && typeof error === "object" ? signInOutcome((error as { reason?: unknown }).reason) : null;

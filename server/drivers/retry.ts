// Transient-failure classification + capped backoff for turn drivers
// (plan v2 §3.4). Pure functions — no timers, no events — so the drivers
// keep owning process lifetime while sharing one policy: a provider hiccup
// (429/5xx/overloaded/reset) gets up to MAX_ATTEMPTS tries, an auth or
// request-shape problem never does.
import type { ProviderErrorCode } from "../contracts.ts";

export const RETRY_MAX_ATTEMPTS = 3;

/** Backoff schedule before attempt N (N is 1-based over retries): 1s / 3s / 8s. */
export const BACKOFF_BASE_MS = [1_000, 3_000, 8_000] as const;

export type TransientReason =
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "connection_reset"
  | "timeout";

export type TerminalReason =
  | "auth"
  | "quota"
  | "unknown_model"
  | "invalid_request"
  | "not_found"
  | ProviderErrorCode
  | "terminal_exit"
  | "interrupted"
  | "unknown";

export interface ErrorClassification {
  transient: boolean;
  reason: string;
}

const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: TransientReason }> = [
  { pattern: /\b(?:429|rate.?limit|too many requests)\b/i, reason: "rate_limited" },
  { pattern: /\boverloaded\b|\bcapacity\b/i, reason: "overloaded" },
  { pattern: /\b5\d{2}\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b/i, reason: "server_error" },
  {
    pattern:
      /\b(?:econnreset|econnrefused|epipe|etimedout|eai_again|connection reset|connection refused|socket hang up|network error|fetch failed)\b/i,
    reason: "connection_reset",
  },
  { pattern: /\btimeout(ed)?\b|\btimed? out\b/i, reason: "timeout" },
];

const TERMINAL_PATTERNS: Array<{ pattern: RegExp; reason: TerminalReason }> = [
  {
    pattern: /\b(?:40[13]|unauthorized|forbidden|invalid api key|missing bearer|authentication required|not logged in|logged out)\b/i,
    reason: "auth",
  },
  { pattern: /\b402\b|\bquota\b|\bbilling\b|\bsubscription\b/i, reason: "quota" },
  { pattern: /\bmodel not found\b|\bunknown model\b|\bdoes not exist for model\b|\bunsupported model\b/i, reason: "unknown_model" },
  { pattern: /\b400\b|\b422\b|\binvalid request\b|\bmalformed\b|\bunexpected status\b/i, reason: "invalid_request" },
  { pattern: /\b404\b|\bno such thread\b|\bthread gone\b/i, reason: "not_found" },
  // interrupt/cancel vocabulary from the drivers' own stop paths — a turn the
  // user stopped must never come back as an auto-retry
  { pattern: /\b(?:interrupted|cancelled by user)\b/i, reason: "interrupted" },
];

/** A CLI exit report, as drivers assemble it from a child process's close
 * event: the numeric exit code plus whatever stderr survived. */
interface CliExit {
  exitCode: number | null;
  stderr?: string;
}

/** A bare failure message, wrapped so the classifier's inputs stay named
 * domain values rather than unparsed primitives. */
interface FailureText {
  text: string;
}

/** The failure shapes drivers actually hand the classifier. */
type FailureInput = Error | CliExit | FailureText | null;

const messageOf = (err: FailureInput): string => {
  if (!err) return "";
  if (err instanceof Error) return `${err.message}${err.cause ? ` ${String(err.cause)}` : ""}`;
  if ("text" in err) return err.text;
  return [err.stderr ?? "", ""].join(" ").trim();
};

/** Classify a thrown error or a CLI exit into retry-worthy vs terminal.
 *
 * Exit-report shape: a nonzero exit with no error text is treated as
 * terminal (`terminal_exit`) — drivers only reach it after the CLI already
 * reported its own protocol-level failure. A signal kill (negative code) is
 * never retried either.
 */
export function classifyError(err: FailureInput): ErrorClassification {
  const text = messageOf(err);
  if (err && "exitCode" in err) {
    const { exitCode: code } = err;
    if (code !== null && code < 0) return { transient: false, reason: "interrupted" };
    for (const { pattern, reason } of TRANSIENT_PATTERNS) {
      if (pattern.test(text)) return { transient: true, reason };
    }
    for (const { pattern, reason } of TERMINAL_PATTERNS) {
      if (pattern.test(text)) return { transient: false, reason };
    }
    return { transient: false, reason: "terminal_exit" };
  }
  for (const { pattern, reason } of TERMINAL_PATTERNS) {
    if (pattern.test(text)) return { transient: false, reason };
  }
  for (const { pattern, reason } of TRANSIENT_PATTERNS) {
    if (pattern.test(text)) return { transient: true, reason };
  }
  return { transient: false, reason: "unknown" };
}

/** Capped exponential delay with jitter, in milliseconds. Attempt 0 (the
 * first retry) waits ~1s, then ~3s, then ~8s; beyond that the cap holds.
 * Jitter stays within ±25% so tests can bound it and a thundering herd of
 * bots doesn't re-sync on the same tick. */
export function computeBackoff(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS[Math.min(Math.max(attempt, 0), BACKOFF_BASE_MS.length - 1)];
  const jitter = base * 0.25;
  return Math.round(base - jitter + random() * jitter * 2);
}

/** A cancellable backoff sleep. An interrupt during the wait resolves at
 * once with "cancelled" — the caller settles the turn as interrupted
 * instead of relaunching, so no zombie process outlives the user's stop. */
export interface BackoffWait {
  promise: Promise<"elapsed" | "cancelled">;
  cancel: () => void;
}

export function interruptibleDelay(ms: number, signal?: AbortSignal): BackoffWait {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onCancel: (() => void) | null = null;
  const promise = new Promise<"elapsed" | "cancelled">((resolve) => {
    timer = setTimeout(() => resolve("elapsed"), Math.max(1, ms));
    timer.unref?.();
    if (signal?.aborted) return resolve("cancelled");
    onCancel = () => {
      clearTimeout(timer!);
      resolve("cancelled");
    };
    signal?.addEventListener("abort", onCancel, { once: true });
  });
  return {
    promise,
    cancel: () => onCancel?.(),
  };
}

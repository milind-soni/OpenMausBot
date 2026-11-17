// Transient-failure classification and capped backoff for turn drivers: a provider hiccup
// (429/5xx/overloaded/reset) gets up to MAX_ATTEMPTS tries, an auth or request-shape problem none.
import type { ProviderErrorCode } from "../contracts.ts";
import { isProviderSafetyBlock } from "../../shared/provider-safety.ts";

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
  { pattern: /\b5\d{2}\b|\binternal server error\b|\binternal service failure\b|\bServiceUnavailableError\b|\bbad gateway\b|\bservice unavailable\b/i, reason: "server_error" },
  // Codex's ChatGPT workspace routing lookup (codex-cli 0.160); only its "unauthorized" variant is a sign-in problem.
  { pattern: /\bworkspace routing discovery (?:failed|timed out)\b/i, reason: "server_error" },
  {
    pattern:
      /\b(?:econnreset|econnrefused|epipe|etimedout|eai_again|unexpected_eof_while_reading|connection reset|connection refused|socket hang up|network error|fetch failed)\b/i,
    reason: "connection_reset",
  },
  { pattern: /\btimeout(ed)?\b|\btimed? out\b/i, reason: "timeout" },
];

/** A subscription's usage running out: terminal even when phrased as a rate limit. Claude Code 2.1.295
 * says "You've hit your weekly limit · resets …", "…your session limit", "…your Opus limit", "…your
 * team's shared budget", "You're out of usage credits", "You're out of extra usage". */
export const USAGE_LIMIT = /\busage limit\b|\bhit your (?:(?!rate\b)[\w'’-]+ ){0,3}(?:limit|budget)\b|\b(?:weekly|daily|monthly|subscription|usage|session|5-hour) limit reached\b|\bout of (?:usage(?: credits)?|extra usage|credits)\b/i;

/** An engine that cannot run the model it was given, whatever the turn: OpenCode 2.2.5 answers session/prompt for a model
 * it has no route to with `{code: -32603, message: "Internal error: Unsupported package for <provider>/<model>: …",
 * data: {service: "session", errorName: "provider.no-route"}}`. */
export const MODEL_NO_ROUTE = /\bunsupported package for\b|\bprovider\.no-route\b/i;
/** The same failure in the plain words a person is shown, which stay as final as the raw ones. */
const MODEL_NO_ROUTE_PLAIN = /\bcan't use (?:the|this bot's) model\b/i;

const TERMINAL_PATTERNS: Array<{ pattern: RegExp; reason: TerminalReason }> = [
  {
    pattern: /\b(?:40[13]|unauthorized|forbidden|invalid api key|missing bearer|authentication required|not logged in|logged out)\b/i,
    reason: "auth",
  },
  // every terminal pattern is read before the transient 429 one
  { pattern: USAGE_LIMIT, reason: "quota" },
  { pattern: /\b402\b|\bquota\b|\bbilling\b|\bsubscription\b/i, reason: "quota" },
  { pattern: /\bmodel not found\b|\bunknown model\b|\bdoes not exist for model\b|\bunsupported model\b/i, reason: "unknown_model" },
  { pattern: MODEL_NO_ROUTE, reason: "unknown_model" },
  { pattern: MODEL_NO_ROUTE_PLAIN, reason: "unknown_model" },
  { pattern: /\b400\b|\b422\b|\binvalid request\b|\bmalformed\b/i, reason: "invalid_request" },
  { pattern: /\b404\b|\bno such thread\b|\bthread gone\b/i, reason: "not_found" },
  // A turn the user stopped must never come back as an auto-retry.
  { pattern: /\b(?:interrupted|cancelled by user)\b/i, reason: "interrupted" },
  { pattern: /\bcertificate[ _]verify[ _]failed\b/i, reason: "unknown" },
];

interface CliExit {
  exitCode: number | null;
  stderr?: string;
}

interface FailureText {
  text: string;
}

type FailureInput = Error | CliExit | FailureText | null;

const messageOf = (err: FailureInput): string => {
  if (!err) return "";
  if (err instanceof Error) return `${err.message}${err.cause ? ` ${String(err.cause)}` : ""}`;
  if ("text" in err) return err.text;
  return [err.stderr ?? "", ""].join(" ").trim();
};

/** A nonzero exit with no error text is terminal (`terminal_exit`): the CLI already reported its own
 * failure. A signal kill (negative code) is never retried. */
export function classifyError(err: FailureInput): ErrorClassification {
  const text = messageOf(err);
  // A surrounding HTTP 5xx/429 must not replay a provider safety block.
  if (isProviderSafetyBlock(text)) return { transient: false, reason: "provider_safety" };
  if (err && "exitCode" in err) {
    const { exitCode: code } = err;
    if (code !== null && code < 0) return { transient: false, reason: "interrupted" };
    for (const { pattern, reason } of TERMINAL_PATTERNS) {
      if (pattern.test(text)) return { transient: false, reason };
    }
    for (const { pattern, reason } of TRANSIENT_PATTERNS) {
      if (pattern.test(text)) return { transient: true, reason };
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

/** Whether a turn whose CLI exited before its result may be sent again. Only work the provider never did is resent:
 * a launch that ended before taking the prompt, or a transient failure before any model call answered or any text
 * streamed. Once a call answered, the subscription has paid for it and the CLI already retried its own API calls. */
export function mayResendTurn(turn: { endedBeforeTurn: boolean; exitCode: number | null; transient: boolean; streamed: boolean;
  answered: boolean; attempt: number }): boolean {
  if (turn.endedBeforeTurn) return true;
  return turn.exitCode !== 0 && turn.transient && !turn.streamed && !turn.answered && turn.attempt < RETRY_MAX_ATTEMPTS - 1;
}

export function computeBackoff(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS[Math.min(Math.max(attempt, 0), BACKOFF_BASE_MS.length - 1)];
  const jitter = base * 0.25;
  return Math.round(base - jitter + random() * jitter * 2);
}

/** An interrupt during the wait resolves "cancelled" at once, so no relaunch outlives the user's stop. */
export interface BackoffWait {
  promise: Promise<"elapsed" | "cancelled">;
  cancel: () => void;
}

export function interruptibleDelay(ms: number, signal?: AbortSignal): BackoffWait {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onCancel: (() => void) | null = null;
  const promise = new Promise<"elapsed" | "cancelled">((resolve) => {
    const settle = (result: "elapsed" | "cancelled") => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (onCancel) signal?.removeEventListener("abort", onCancel);
      onCancel = null;
      resolve(result);
    };
    onCancel = () => settle("cancelled");
    if (signal?.aborted) return settle("cancelled");
    timer = setTimeout(() => settle("elapsed"), Math.max(1, ms));
    timer.unref?.();
    signal?.addEventListener("abort", onCancel, { once: true });
  });
  return {
    promise,
    cancel: () => onCancel?.(),
  };
}

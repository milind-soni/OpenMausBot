// An error as a person reads it. Most errors the app shows are already a
// sentence someone wrote for a person ("Add your key in Settings → API
// keys"), and those stay exactly as they are. Some are not: a bare HTTP
// status from `api()`, the browser's "Failed to fetch", a provider's JSON
// body, a stack trace, a Node error code. For those this returns one plain
// line, and the caller keeps the original under a Details disclosure.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** The browser's own words when a request never reached the server. */
const UNREACHABLE = /^(?:TypeError:\s*)?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/i;
/** An AbortSignal.timeout firing, in each browser's words. */
const TIMED_OUT = /^(?:TimeoutError:\s*)?(?:The operation was aborted due to timeout|signal timed out|The operation timed out\.?)$/i;

/** Shapes no person wrote. Each is narrow on purpose: a sentence that only
 * mentions "timeout" or "rate limit" is still a sentence. */
const TECHNICAL: RegExp[] = [
  UNREACHABLE,
  TIMED_OUT,
  // api()'s fallback when a refusal has no `error`: "502 Bad Gateway"
  /^\d{3}(?: [A-Za-z][\w '-]*)?$/,
  // a JSON body pasted into the message
  /[{[]\s*"[\w$-]+"\s*:/,
  // a stack trace
  /\n\s+at \S/,
  // "TypeError: …", "SyntaxError: …"
  /^[A-Z][a-z]+Error: /,
  // a Node or libc error code
  /\b(?:E(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|ACCES|PERM|NOENT|ADDRINUSE|HOSTUNREACH|NETUNREACH)|ERR_[A-Z_]{3,})\b/,
  // a message led by a status code: "API Error: 529", "upstream HTTP 503",
  // "status 500". A sentence that only mentions one further in is a person's
  /^(?:[\w-]+ ){0,2}(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b/i,
  // a JSON parse failure
  /Unexpected token .* in JSON|is not valid JSON|Unexpected end of JSON input/,
  // a process exit report: "claude exited 3 before result: …"
  /^\S+ exited (?:with code )?-?\d+\b/,
  // a bare machine slug: "rate_limited", "invalid_request_error"
  /^[a-z]+(?:_[a-z0-9]+)+$/,
];

const KINDS: Array<[RegExp, LocaleKey]> = [
  [UNREACHABLE, "error.plain.unreachable"],
  [/\b429\b|rate.?limit|too many requests/i, "error.plain.rateLimited"],
  [/overloaded|\b529\b|\b503\b|capacity|service unavailable/i, "error.plain.busy"],
  [/ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|connection (?:reset|refused)/i, "error.plain.connection"],
  [/timeout|timed out|ETIMEDOUT/i, "error.plain.timeout"],
  [/\b(?:EACCES|EPERM)\b/, "error.plain.permission"],
  [/\b40[13]\b|unauthori[sz]ed|forbidden/i, "error.plain.access"],
  [/\b404\b|not found|ENOENT/i, "error.plain.notFound"],
  [/\b413\b|too large/i, "error.plain.tooLarge"],
  [/\b5\d\d\b|internal server error|bad gateway/i, "error.plain.server"],
];

/** Whether `raw` is a machine's words rather than a sentence for a person. */
export function isTechnicalError(raw: string): boolean {
  const text = raw.trim();
  return Boolean(text) && TECHNICAL.some((pattern) => pattern.test(text));
}

/** "API Error: 400 ", "HTTP 503: ", "upstream HTTP 429 - " in front of a
 * message. */
const STATUS_PREFIX = /^(?:[\w-]+ ){0,2}(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b[\s:.-]*/i;

/** An HTTP reason phrase on its own: "Bad Gateway", "Service Unavailable". */
const REASON_PHRASE = /^(?:[A-Z][a-z]+ ?){1,4}\.?$/;

/** One plain line for a technical error, or undefined when `raw` already
 * reads as a sentence and should be shown as it is. A sentence behind a
 * status code ("API Error: 400 Claude Code 2.1.268 does not support this
 * model…") keeps its words without the code: they are the precise cause. */
export function plainErrorLine(raw: string): string | undefined {
  if (!isTechnicalError(raw)) return undefined;
  const text = raw.trim();
  const rest = text.replace(STATUS_PREFIX, "").trim();
  if (rest !== text && /[A-Za-z]+\s+[A-Za-z]+/.test(rest) && !REASON_PHRASE.test(rest) && !isTechnicalError(rest)) return rest;
  const key = KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? "error.plain.generic";
  return t(key);
}

import { cloudHomeConfigured } from "../cloud-home.ts";
import { hostTimeZone } from "../turn-clock.ts";
import { USAGE_LIMIT } from "./retry.ts";
import { CODEX_USAGE_LIMIT_REACHED } from "../../shared/codex-usage-limit.ts";

/** How a Codex turn reaches OpenAI: OpenMausBot's ChatGPT plan, Codex's own sign-in, or any other provider. */
export type CodexRoute = "plan" | "own" | "other";

// codex-cli 0.160.1 holding no login sends no Authorization header and gets this 401.
export const CODEX_MISSING_CREDENTIALS = /missing bearer or basic authentication/i;

export function codexNotSignedIn(): string {
  return `Codex isn't signed in on this computer.${cloudHomeConfigured() ? " Sign-ins don't copy over when you move to My Cloud." : ""} Sign in to Codex in Settings → Model providers → Codex.`;
}

/** Codex's own words name ChatGPT's plans ("Upgrade to Pro"), which read as MausBot's. codex-cli 0.160.1 ends them
 * with "Try again at 5:23 PM." or "…or try again at Oct 17th, 2026 5:23 PM.", in its local time. */
export function codexLimitMessage(said: string, timeZone = hostTimeZone()): string {
  const resets = /\btry again at ([^.]+)/i.exec(said)?.[1]?.trim();
  return `${CODEX_USAGE_LIMIT_REACHED} This is OpenAI's limit, not your MausBot plan. ${resets
    ? `It resets at ${resets} (${timeZone}). Until then, manage your Codex usage in ChatGPT or switch this bot to another AI.`
    : "Manage your Codex usage in ChatGPT, or switch this bot to another AI until it resets."}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function clockHours(hour: string, meridiem: string): number {
  return (Number(hour) % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);
}

/** When Codex says its usage limit resets, from its words "try again at 5:23 PM" (today) or "try again at
 * Oct 17th, 2026 5:23 PM", in this computer's local time; undefined when it names no time. */
export function codexLimitResetsAt(said: string, now = Date.now()): number | undefined {
  if (!USAGE_LIMIT.test(said)) return undefined;
  const when = /\btry again at ([^.]+)/i.exec(said)?.[1]?.trim() ?? "";
  const time = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(when);
  if (time) {
    // codex-rs/protocol/src/error.rs format_retry_timestamp prints only the time, without seconds, when the reset is on
    // its own local date. A minute already begun is the reset arriving within it or just past, so it ends with the minute.
    const hour = clockHours(time[1]!, time[3]!);
    const minute = Number(time[2]);
    let at = new Date(now).setHours(hour, minute, 0, 0);
    // When a DST change repeats this hour, setHours gives the first of the two; once that has passed, Codex meant the second.
    const later = at + (new Date(at + 3 * 3_600_000).getTimezoneOffset() - new Date(at).getTimezoneOffset()) * 60_000;
    if (later > at && at + 59_999 < now && new Date(later).getHours() === hour && new Date(later).getMinutes() === minute) at = later;
    return at <= now ? at + 59_999 : at;
  }
  const dated = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(when);
  const month = dated ? MONTHS.indexOf(dated[1]!.toLowerCase()) : -1;
  if (!dated || month < 0) return undefined;
  const at = new Date(Number(dated[3]), month, Number(dated[2]), clockHours(dated[4]!, dated[6]!), Number(dated[5]), 0, 0).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** The runtime.error fields a Codex usage-limit refusal adds: that it is one, for the whole account or for one model
 * ("You've hit your usage limit for gpt-6.1-sol. Switch to another model now…"), and when it resets, if Codex said. */
export function codexLimitFacts(raw: string, route: CodexRoute, codexErrorInfo?: unknown): { limit?: "engine" | "model"; limitResetsAt?: number } {
  if (codexErrorInfo !== "usageLimitExceeded" && !USAGE_LIMIT.test(raw) && !raw.includes("subscription_sharing_usage_limit_exceeded")) return {};
  const at = route === "own" ? codexLimitResetsAt(raw) : undefined;
  return { limit: /\busage limit for \S+?\.(?:\s|$)/i.test(raw) ? "model" : "engine", ...(at === undefined ? {} : { limitResetsAt: at }) };
}

export function codexUserError(value: string, route: CodexRoute, codexErrorInfo?: unknown): string {
  if (route === "plan" && value.includes("subscription_sharing_usage_limit_exceeded")) {
    return "subscription_sharing_usage_limit_exceeded: Your ChatGPT plan usage limit was reached. Manage usage in ChatGPT Settings, or explicitly choose another provider.";
  }
  if (route === "own" && (codexErrorInfo === "usageLimitExceeded" || USAGE_LIMIT.test(value))) return codexLimitMessage(value);
  if (route === "own" && CODEX_MISSING_CREDENTIALS.test(value)) return codexNotSignedIn();
  if (value.includes("provider_not_configured")) {
    return route === "plan"
      ? "provider_not_configured: ChatGPT has not enabled this model for the selected account. Refresh models or reconnect ChatGPT plan in Settings. API billing will not be used."
      : "provider_not_configured: This Codex account cannot use the selected route. For the new ChatGPT plan models, choose ChatGPT plan in Settings → Engines and Continue with ChatGPT, then select a model from that account.";
  }
  return value.slice(0, 400);
}

// Codex's own words when OpenAI refuses its stored ChatGPT login (codex-cli 0.160 login/src/auth).
const CODEX_SIGN_IN_REFUSED = /workspace routing discovery unauthorized|access token could not be refreshed|authentication session could not be refreshed|ChatGPT login is required|auth data is not available|please (?:log out and )?sign in again/i;

/** A turn error saying Codex's own sign-in was refused (`unauthorized`, a model-backend 401, or its
 * sign-in words). A 401 from an MCP server or tool reaches the model as a tool result, never here. */
export function codexSignInRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { message, codexErrorInfo: info } = error as { message?: unknown; codexErrorInfo?: unknown };
  if (info === "unauthorized") return true;
  if (info && typeof info === "object" &&
    Object.values(info).some((variant) => (variant as { httpStatusCode?: unknown } | null)?.httpStatusCode === 401)) return true;
  return typeof message === "string" && CODEX_SIGN_IN_REFUSED.test(message);
}

export const CODEX_SIGN_IN_EXPIRED = "Codex's ChatGPT sign-in has expired. Sign in again in Settings → Model providers → Codex.";

export function codexSignInExpired(raw: string): string {
  return `${CODEX_SIGN_IN_EXPIRED} Codex said: ${raw.slice(0, 300)}`;
}

export class CodexRpcError extends Error {
  code: unknown;

  constructor(error: { code?: unknown; message?: string }) {
    super(error.message ?? JSON.stringify(error));
    this.code = error.code;
  }
}

export function missingNativeCodexThread(error: unknown, cursor: string): boolean {
  // Codex's local thread/resume rejection, verified with an empty native home; unknown versions fail closed.
  return error instanceof CodexRpcError && error.code === -32600 &&
    error.message === `no rollout found for thread id ${cursor}`;
}

/** Codex refuses to resume an archived session: "session <id> is archived. Run `codex unarchive <id>` to unarchive it first." */
export const archivedNativeCodexThread = (error: unknown, cursor: string): boolean =>
  error instanceof CodexRpcError && error.message.includes(cursor) && /\bis archived\b/.test(error.message);

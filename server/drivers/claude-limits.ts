import type { ServerText } from "../../shared/server-text.ts";
import { chatNotice, type ChatNoticeKey } from "../chat-notices.ts";
import { redactSecretsInText } from "../redact.ts";
import { hostTimeZone } from "../turn-clock.ts";
import { engineFailure, type EngineFailureKind } from "./engine-errors.ts";
import { USAGE_LIMIT } from "./retry.ts";

export interface ClaudeLimit {
  /** the CLI's rateLimitType: five_hour, seven_day, seven_day_opus, seven_day_sonnet,
   * seven_day_overage_included or overage (2.1.295) */
  window: string | null;
  /** epoch seconds */
  resetsAt: number | null;
  /** The plan still had room: this model runs on extra usage and its credits are used up, so `resetsAt` is the
   * billing period's reset and other models on the same account keep working. */
  credits?: true;
}

/** The window refusing this account per the CLI's `rate_limit_info` ("allowed", "allowed_warning",
 * "rejected"; on `rate_limit_event` since 2.1.272 and on the refused call's `api_error_params` since
 * 2.1.295), or null. A rejected window with extra usage in use still runs the turn on credits. */
export function claudeLimitRefusal(info: unknown): ClaudeLimit | null {
  if (!info || typeof info !== "object") return null;
  const { status, rateLimitType, resetsAt, isUsingOverage, errorCode, overageDisabledReason } = info as Record<string, unknown>;
  if (status !== "rejected" || isUsingOverage === true) return null;
  return {
    window: typeof rateLimitType === "string" ? rateLimitType : null,
    resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    ...(errorCode === "credits_required" || overageDisabledReason === "out_of_credits" ? { credits: true as const } : {}),
  };
}

/** The CLI's api-error frame for a usage-limit refusal: `api_error: "usage_limit_reached"` (2.1.295),
 * the words ("You've hit your weekly limit · resets …"), or an earlier refusing `rate_limit_event`.
 * It outranks whatever else the frame says: 2.1.272 answered a limited account with "does not
 * support this model". */
export function claudeUsageLimit(
  frame: { error?: unknown; is_api_error_message?: unknown; api_error?: unknown },
  text: string,
  refused = false,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return refused || frame.api_error === "usage_limit_reached" || USAGE_LIMIT.test(text);
}

const CLAUDE_LIMIT_NAMES: Record<string, ChatNoticeKey> = {
  five_hour: "chat.notice.part.fiveHourLimit",
  seven_day: "chat.notice.part.weeklyLimit",
  seven_day_opus: "chat.notice.part.weeklyOpusLimit",
  seven_day_sonnet: "chat.notice.part.weeklySonnetLimit",
};

/** A weekly window for one model family (seven_day_opus, seven_day_sonnet…), not the overage windows. */
const modelWindow = (window: string | null | undefined): boolean => /^seven_day_(?!overage)[a-z]+$/.test(window ?? "");

/** The reset to hold the whole engine until: only a window every model shares refuses the account, so a credits refusal
 * or one model's weekly window leaves the engine free for its other models. */
export function claudeEngineReset(limit: ClaudeLimit | null | undefined): { limitResetsAt: number } | undefined {
  if (!limit?.resetsAt || limit.credits || modelWindow(limit.window)) return undefined;
  return { limitResetsAt: limit.resetsAt * 1000 };
}

/** The runtime error's facts for a usage limit: what it refuses, and when that resets when Claude said. A model's own
 * window resets that model alone; extra usage credits name only the billing period's end, which is no countdown. */
export function claudeLimitFacts(limit: ClaudeLimit | null | undefined): { limit: "engine" | "model" | "credits"; limitResetsAt?: number } {
  if (limit?.credits) return { limit: "credits" };
  if (modelWindow(limit?.window)) return { limit: "model", ...(limit?.resetsAt ? { limitResetsAt: limit.resetsAt * 1000 } : {}) };
  return { limit: "engine", ...claudeEngineReset(limit) };
}

export function claudeLimitMessage(limit: ClaudeLimit | null, said?: string, now = Date.now(), timeZone = hostTimeZone()): string {
  return claudeLimitError(limit, said, now, timeZone).message;
}

/** `limit` and `meanwhile` name `chat.notice.part.*` keys, and `resetsAt` is a moment in `timeZone`: the client words both. */
export function claudeLimitError(limit: ClaudeLimit | null, said?: string, now = Date.now(), timeZone = hostTimeZone()): { message: string; text?: ServerText } {
  const coded = (key: ChatNoticeKey, params?: Record<string, string | number>, shown = params) =>
    ({ message: chatNotice(key, shown), text: { key, ...(params ? { params } : {}) } });
  if (limit?.credits) return coded("chat.notice.claudeExtraUsage");
  const name = limit?.window && Object.hasOwn(CLAUDE_LIMIT_NAMES, limit.window) ? CLAUDE_LIMIT_NAMES[limit.window]! : "chat.notice.part.usageLimit";
  const meanwhile: ChatNoticeKey = modelWindow(limit?.window) ? "chat.notice.part.chooseModel" : "chat.notice.part.switchAccount";
  const parts = { limit: name, meanwhile }, words = { limit: chatNotice(name), meanwhile: chatNotice(meanwhile) };
  if (limit?.resetsAt && limit.resetsAt * 1000 > now) {
    const at = limit.resetsAt * 1000;
    let resets: string;
    try {
      resets = `${new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
    } catch {
      resets = `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      return { message: chatNotice("chat.notice.claudeLimitResets", { ...words, resets }) };
    }
    return coded("chat.notice.claudeLimitResets", { ...parts, resetsAt: at, timeZone, resets }, { ...words, resets });
  }
  const quoted = said && redactSecretsInText(said.trim().replace(/[.\s]+$/, ""));
  return quoted ? coded("chat.notice.claudeLimitSaid", { ...parts, said: quoted }, { ...words, said: quoted }) : coded("chat.notice.claudeLimit", parts, words);
}

/** The API refusing a model newer than the installed CLI, relayed as an api-error frame ("Claude
 * Code 2.1.268 does not support this model; version 2.1.280 or newer is required…"); it names no model. */
export function claudeVersionTooOld(
  frame: { error?: unknown; is_api_error_message?: unknown },
  text: string,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return /\bClaude Code v?\d+(?:\.\d+)+ does not support this model\b/i.test(text);
}

/** Claude Code 2.1.295's api-error kinds (the assistant frame's `error`) that say the cause outright. */
const CLAUDE_ERROR_KINDS: Record<string, EngineFailureKind> = {
  billing_error: "credits",
  overloaded: "overloaded",
  server_error: "server",
  rate_limit: "rate_limit",
};

/** An api-error frame or error result in plain words. Claude Code sends the frame as a synthetic message whose
 * stop_reason is "stop_sequence", with `error` (billing_error, overloaded, server_error, rate_limit, invalid_request,
 * model_not_found, unknown…) and its text ("API Error: 529 …", "Credit balance is too low"); the result repeats the
 * text with `api_error_status`. Each is one plain row, never a reply: a kind or status OMB words is named, anything
 * else keeps Claude's own words. */
export function claudeApiErrorMessage(frame: { error?: unknown; api_error_status?: unknown }, text: string): string {
  return claudeApiError(frame, text).message;
}

export function claudeApiError(frame: { error?: unknown; api_error_status?: unknown }, text: string): { message: string; text?: ServerText } {
  const said = text.trim();
  const kind = typeof frame.error === "string" && Object.hasOwn(CLAUDE_ERROR_KINDS, frame.error) ? CLAUDE_ERROR_KINDS[frame.error] : null;
  const status = typeof frame.api_error_status === "number" ? frame.api_error_status : undefined;
  return engineFailure("Claude", said, { kind, status }) ?? { message: said };
}

// Plain words for an engine's failure, shared by every driver: an account out of credits, a usage or rate limit, an
// overloaded or failing service, or any other HTTP refusal names the provider and keeps its own short reason. Each
// sentence keeps the words classifyError (retry.ts) reads, so retries, account switching and health codes are unchanged.
import type { ServerText } from "../../shared/server-text.ts";
import { chatNotice, noticeFailure } from "../chat-notices.ts";
import { redactSecretsInText } from "../redact.ts";
import { hostTimeZone } from "../turn-clock.ts";
import { toolCountLimitFromError } from "../tool-count-limit.ts";
import { MODEL_NO_ROUTE, USAGE_LIMIT } from "./retry.ts";
import { usageLimitWait } from "./acp/quiet-status.ts";

export type EngineFailureKind = "credits" | "usage_limit" | "rate_limit" | "overloaded" | "server" | "tool_schema" | "tool_count" | "model_no_route" | "refused";

/** A provider refusing for want of credit or payment, in its own words (402 is read from the status). */
const OUT_OF_CREDITS = /\bpayment required\b|\binsufficient (?:account )?(?:funds|balance|credits?)\b|\b(?:credit|account) balance is too low\b|\bout of credits?\b|\bno credits? (?:left|remaining)\b|\bused all (?:available |of (?:your|its) )?credits\b/i;

/** A provider refusing a tool's parameters schema: Moonshot's "tools.function.parameters is not a valid moonshot flavored
 * json schema, details: <At path 'root': schema exceeds maximum allowed size>", OpenAI's "Invalid schema for function
 * 'x'", Anthropic's "tools.3.custom.input_schema: …", Gemini's "function_declarations[3].parameters", Bedrock's
 * "toolSpec.inputSchema". */
const TOOL_SCHEMA = /moonshot flavou?red json schema|schema exceeds maximum allowed size|invalid schema for function\b|\btools\.\d+\.custom\.input_schema\b|function_declarations\[\d+\]\.parameters|\btoolSpec\.inputSchema\b/i;
const SCHEMA_TOOL_NAME = /\b(?:function|tool) ['"`]([\w.:-]{1,128})['"`]/i;
const SCHEMA_TOO_LARGE = /exceeds maximum allowed size|\btoo (?:large|long|big)\b/i;
/** The model OpenCode 2.2.5 names in a no-route refusal ("Unsupported package for <id>: <package>", "Model unavailable:
 * <id>", "Cannot initialize <id>: …"); an id may hold a colon ("ollama-cloud/deepseek-v4.1-flash:1017"). */
const NO_ROUTE_MODEL = /\b(?:Unsupported package for|Variant unavailable for|Cannot initialize|Model unavailable:) (\S+?)[:.]?(?=\s|$)/i;

/** Grok Build's "API error (status 402 Payment Required): …" (inside ACP's "Internal error: …"), the chat-completions
 * drivers' "xAI HTTP 402: …", and Claude Code's "API Error: 529 …". */
const STATUS = /\(status (\d{3})\b[^)]*\)|\bHTTP (\d{3})\b|^API Error:? (\d{3})\b/i;

const WRAPPERS = [
  /^provider returned a(?: streaming)? completion error:\s*/i,
  /^internal error:\s*/i,
  /^API error \(status \d{3}[^)]*\):?\s*/i,
  /^API Error:?\s*(?:\d{3}\b:?\s*)?/i,
  /^[\w.-]+ HTTP \d{3}:?\s*/i,
];
/** acpRpcError's method context: "(session/prompt, service: session, APIError)". */
const ACP_CONTEXT = /\s*\([a-z_]+\/[\w/.-]+(?:, [^()]*)?\)$/i;
const REASON_CHARS = 160;

export function httpStatusOf(text: string): number | null {
  const match = STATUS.exec(text.trim());
  const status = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function jsonMessage(body: string): string | null {
  try {
    const value = JSON.parse(body);
    const message = value?.error?.message ?? value?.message ?? (typeof value?.error === "string" ? value.error : undefined);
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/** A status line's own phrase ("Payment Required", "Overloaded"): it says nothing the sentence does not. */
const STATUS_PHRASE = /^(?:[A-Z][a-z]+ ?){1,4}$|^\S+$/;

/** The provider's own short reason inside a raw error, without the RPC wrapper, status line or method context: its
 * first sentence, redacted, and null for a bare status phrase, a raw body or nothing at all. */
export function providerReason(text: string): string | null {
  let reason = text.replace(/\s+/g, " ").trim();
  for (const wrapper of WRAPPERS) reason = reason.replace(wrapper, "");
  reason = reason.replace(ACP_CONTEXT, "").trim();
  if (/^[{[]/.test(reason)) reason = jsonMessage(reason)?.replace(/\s+/g, " ").trim() ?? "";
  if (!reason || reason.startsWith("<")) return null;
  const first = /^(.{20,}?[.!?])\s/.exec(reason)?.[1];
  if (first) reason = first;
  if (reason.length > REASON_CHARS) reason = `${reason.slice(0, REASON_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  reason = redactSecretsInText(reason).replaceAll('"', "'").replace(/[.\s]+$/, "");
  return reason && !STATUS_PHRASE.test(reason) ? reason : null;
}

/** What a raw engine failure is, from its HTTP status or its words; null when it is none of these. */
export function engineFailureKind(text: string, status = httpStatusOf(text)): EngineFailureKind | null {
  if (status === 402 || OUT_OF_CREDITS.test(text)) return "credits";
  if (USAGE_LIMIT.test(text)) return "usage_limit";
  if (status === 529 || /\boverloaded\b/i.test(text)) return "overloaded";
  if (status === 429) return "rate_limit";
  if (TOOL_SCHEMA.test(text)) return "tool_schema";
  if (toolCountLimitFromError(text) !== undefined) return "tool_count";
  if (MODEL_NO_ROUTE.test(text)) return "model_no_route";
  if (status !== null) return status >= 500 ? "server" : "refused";
  return null;
}

/** `text` in plain words naming `provider`, or null when it is no failure this knows (the caller keeps the text). */
export function engineFailureMessage(
  provider: string,
  text: string,
  options: { kind?: EngineFailureKind | null; status?: number | null; resetsAt?: number; timeZone?: string } = {},
): string | null {
  return engineFailure(provider, text, options)?.message ?? null;
}

export function engineFailure(
  provider: string,
  text: string,
  { kind, status, resetsAt, timeZone }: { kind?: EngineFailureKind | null; status?: number | null; resetsAt?: number; timeZone?: string } = {},
): { message: string; text?: ServerText } | null {
  const http = status === undefined ? httpStatusOf(text) : status;
  const what = kind ?? engineFailureKind(text, http);
  if (!what) return null;
  const reason = providerReason(text);
  const says = reason ? `${provider} says: "${reason}"` : null;
  const detail = (...parts: Array<string | null>) => parts.some(Boolean) ? ` (${parts.filter(Boolean).join("; ")})` : "";
  const code = http ? `HTTP ${http}` : null;
  if (what === "usage_limit") {
    const params = { provider, detail: detail(says) };
    if (resetsAt) {
      let zone = timeZone ?? hostTimeZone();
      try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
      const resets = limitResetTime(resetsAt, timeZone);
      return noticeFailure("chat.notice.usageLimitResets", { ...params, resetsAt, timeZone: zone, resets });
    }
    return { message: chatNotice("chat.notice.usageLimit", params), text: { key: "chat.notice.usageLimit", params } };
  }
  switch (what) {
    case "credits": return { message: `Your ${provider} account is out of credits${detail(says)}. Add credits with ${provider}, then run it again.` };
    case "rate_limit": return { message: `${provider} hit a rate limit${detail(code, says)}. Wait a minute, then run it again.` };
    case "overloaded": return { message: `${provider} is overloaded right now${detail(code, says)}. This is usually temporary, so try again in a few minutes.` };
    case "server": return { message: `${provider} had a temporary server problem${detail(code, says)}. Try again in a few minutes.` };
    case "tool_schema": {
      const tool = SCHEMA_TOOL_NAME.exec(text)?.[1];
      const problem = SCHEMA_TOO_LARGE.test(text) ? "is too large" : `uses a form ${provider} does not accept`;
      return { message: `${provider} refused this turn as an invalid request because the input schema of ${tool ? `the "${tool}" tool` : "one of this bot's tools"} `
        + `${problem}, so nothing ran. Turn off the MCP server or app that tool comes from for this bot, or switch the bot to another AI.` };
    }
    case "tool_count": {
      const limit = toolCountLimitFromError(text);
      return limit == null ? noticeFailure("chat.notice.toolCountUnknown", { provider })
        : noticeFailure("chat.notice.toolCount", { provider, limit: String(limit) });
    }
    case "model_no_route": {
      const model = NO_ROUTE_MODEL.exec(text)?.[1];
      return model ? noticeFailure("chat.notice.modelNoRoute", { provider, model }) : noticeFailure("chat.notice.modelNoRouteUnnamed", { provider });
    }
    case "refused": return { message: `${provider} stopped with an error${detail(code, says)}.` };
  }
}

/** When a usage limit resets, in `timeZone` with its name, or in UTC when the zone is unknown. */
export function limitResetTime(epochMs: number, timeZone = hostTimeZone()): string {
  try {
    return `${new Date(epochMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
  } catch {
    return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** A provider's HTTP error an engine posted as its whole reply instead of failing the turn (omp 18.12's ACP mode sends
 * it as message text and ends with end_turn): the status, an Anthropic `{"type":"error",…}` or OpenAI `{"error":{…}}`
 * body, and omp's ` retry-after-ms=<n>` when the provider named a wait. */
const ERROR_REPLY = /^([45]\d\d) (\{[\s\S]*\})(?: retry-after-ms=(\d+))?$/;

function isErrorBody(body: string): boolean {
  try {
    const value = JSON.parse(body);
    return value?.type === "error" || (typeof value?.error === "object" && value.error !== null);
  } catch {
    return false;
  }
}

export interface ErrorReplyFailure {
  message: string;
  text?: ServerText;
  stopReason: "quota" | "auth_required" | "rpc_error";
  setup?: true;
  limit?: "engine";
  limitResetsAt?: number;
}

/** A reply that is only a provider's error body, as the failed turn it is; null for any other text. It reads by its
 * words, as the same failure thrown would, and an account out of credits needs the person's setup. A 429 whose wait is
 * longer than an engine retries on its own is a usage limit too, and the wait names its reset. */
export function errorReplyFailure(provider: string, text: string, now = Date.now(), timeZone?: string): ErrorReplyFailure | null {
  const match = ERROR_REPLY.exec(text.trim());
  const body = match?.[2];
  if (!match || !body || !isErrorBody(body)) return null;
  const status = Number(match[1]);
  const waitMs = Number(match[3] ?? 0);
  const said = engineFailureKind(body, status);
  const kind = said !== "credits" && usageLimitWait(status, waitMs) ? "usage_limit" : said;
  const resetsAt = kind === "usage_limit" && waitMs > 0 ? now + waitMs : undefined;
  const failure = engineFailure(provider, body, { kind, status, resetsAt, timeZone })!;
  if (kind === "credits") return { ...failure, stopReason: "auth_required", setup: true };
  if (kind !== "usage_limit") return { ...failure, stopReason: "rpc_error" };
  return { ...failure, stopReason: "quota", limit: "engine", ...(resetsAt ? { limitResetsAt: resetsAt } : {}) };
}

/** Only an out-of-credits failure or a refused tool schema or tool count in plain words; any other text stays as it is. */
export function plainFailureMessage(provider: string, text: string): string {
  return plainFailure(provider, text).message;
}

export function plainFailure(provider: string, text: string): { message: string; text?: ServerText } {
  const kind = engineFailureKind(text);
  return kind === "credits" || kind === "tool_schema" || kind === "tool_count" ? engineFailure(provider, text, { kind })! : { message: text };
}

/** ACP protocol v1's StopReason values that explain why a turn ended early. */
export function stopFailure(stopReason: string | null | undefined, provider?: string): { message: string; text?: ServerText } | undefined {
  const reason = stopReason?.trim();
  if (!reason) return undefined;
  const name = provider?.trim();
  if (reason === "refusal") return name ? noticeFailure("chat.notice.stop.refusal", { provider: name, reason })
    : noticeFailure("chat.notice.stop.refusalGeneric", { reason });
  if (reason === "max_tokens") return name ? noticeFailure("chat.notice.stop.maxTokens", { provider: name, reason })
    : noticeFailure("chat.notice.stop.maxTokensGeneric", { reason });
  if (reason === "max_turn_requests") return noticeFailure("chat.notice.stop.maxRequests", { reason });
  return { message: /^[a-z][a-z0-9_]*$/i.test(reason) ? `The engine stopped without saying why (stop reason: ${reason}).` : reason };
}

/** A failed turn's stop reason as its cause: a bare provider token ("stop_sequence", "rpc_error") is never the whole
 * message, and the token stays in it so its class still reads. */
export function stopCause(stopReason: string | null | undefined, provider?: string): string | undefined {
  return stopFailure(stopReason, provider)?.message;
}

// Plain words for an engine's failure, shared by every driver: an account out of credits, a usage or rate limit, an
// overloaded or failing service, or any other HTTP refusal names the provider and keeps its own short reason. Each
// sentence keeps the words classifyError (retry.ts) reads, so retries, account switching and health codes are unchanged.
import { redactSecretsInText } from "../redact.ts";
import { toolCountLimitFromError } from "../tool-count-limit.ts";
import { USAGE_LIMIT } from "./retry.ts";

export type EngineFailureKind = "credits" | "usage_limit" | "rate_limit" | "overloaded" | "server" | "tool_schema" | "tool_count" | "refused";

/** A provider refusing for want of credit or payment, in its own words (402 is read from the status). */
const OUT_OF_CREDITS = /\bpayment required\b|\binsufficient (?:account )?(?:funds|balance|credits?)\b|\b(?:credit|account) balance is too low\b|\bout of credits?\b|\bno credits? (?:left|remaining)\b|\bused all (?:available |of (?:your|its) )?credits\b/i;

/** A provider refusing a tool's parameters schema: Moonshot's "tools.function.parameters is not a valid moonshot flavored
 * json schema, details: <At path 'root': schema exceeds maximum allowed size>", OpenAI's "Invalid schema for function
 * 'x'", Anthropic's "tools.3.custom.input_schema: …", Gemini's "function_declarations[3].parameters", Bedrock's
 * "toolSpec.inputSchema". */
const TOOL_SCHEMA = /moonshot flavou?red json schema|schema exceeds maximum allowed size|invalid schema for function\b|\btools\.\d+\.custom\.input_schema\b|function_declarations\[\d+\]\.parameters|\btoolSpec\.inputSchema\b/i;
const SCHEMA_TOOL_NAME = /\b(?:function|tool) ['"`]([\w.:-]{1,128})['"`]/i;
const SCHEMA_TOO_LARGE = /exceeds maximum allowed size|\btoo (?:large|long|big)\b/i;

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
  if (status !== null) return status >= 500 ? "server" : "refused";
  return null;
}

/** `text` in plain words naming `provider`, or null when it is no failure this knows (the caller keeps the text). */
export function engineFailureMessage(
  provider: string,
  text: string,
  { kind, status }: { kind?: EngineFailureKind | null; status?: number | null } = {},
): string | null {
  const http = status === undefined ? httpStatusOf(text) : status;
  const what = kind ?? engineFailureKind(text, http);
  if (!what) return null;
  const reason = providerReason(text);
  const says = reason ? `${provider} says: "${reason}"` : null;
  const detail = (...parts: Array<string | null>) => parts.some(Boolean) ? ` (${parts.filter(Boolean).join("; ")})` : "";
  const code = http ? `HTTP ${http}` : null;
  switch (what) {
    case "credits": return `Your ${provider} account is out of credits${detail(says)}. Add credits with ${provider}, then run it again.`;
    case "usage_limit": return `This ${provider} account has reached its usage limit${detail(says)}. Wait for it to reset, or switch this bot to another AI.`;
    case "rate_limit": return `${provider} hit a rate limit${detail(code, says)}. Wait a minute, then run it again.`;
    case "overloaded": return `${provider} is overloaded right now${detail(code, says)}. This is usually temporary, so try again in a few minutes.`;
    case "server": return `${provider} had a temporary server problem${detail(code, says)}. Try again in a few minutes.`;
    case "tool_schema": {
      const tool = SCHEMA_TOOL_NAME.exec(text)?.[1];
      const problem = SCHEMA_TOO_LARGE.test(text) ? "is too large" : `uses a form ${provider} does not accept`;
      return `${provider} refused this turn as an invalid request because the input schema of ${tool ? `the "${tool}" tool` : "one of this bot's tools"} `
        + `${problem}, so nothing ran. Turn off the MCP server or app that tool comes from for this bot, or switch the bot to another AI.`;
    }
    case "tool_count": return `${provider} refused this turn because this model takes at most ${toolCountLimitFromError(text) ?? "a limited number of"} tools `
      + "and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.";
    case "refused": return `${provider} stopped with an error${detail(code, says)}.`;
  }
}

/** Only an out-of-credits failure or a refused tool schema or tool count in plain words; any other text stays as it is. */
export function plainFailureMessage(provider: string, text: string): string {
  const kind = engineFailureKind(text);
  return kind === "credits" || kind === "tool_schema" || kind === "tool_count" ? engineFailureMessage(provider, text, { kind })! : text;
}

/** ACP's StopReason values (protocol v1) that do say why a turn ended early, naming the AI when the caller knows it;
 * each carries the advice that fits it. */
const STOP_REASON_WORDS: Record<string, { words: (ai: string) => string; hint: string }> = {
  refusal: {
    words: (ai) => `${ai} refused to go on with this request`,
    hint: "Try again, reword the request, or switch this bot to another AI.",
  },
  max_tokens: {
    words: (ai) => `${ai}'s reply reached its maximum length before it finished`,
    hint: "Ask it to continue, or ask for a shorter answer.",
  },
  max_turn_requests: {
    words: () => "The turn made as many model requests as one turn may before it finished",
    hint: "Ask it to carry on from where it stopped, or split the task.",
  },
};

/** A failed turn's stop reason as its cause: a bare provider token ("stop_sequence", "rpc_error") is never the whole
 * message, and the token stays in it so its class still reads. */
export function stopCause(stopReason: string | null | undefined, provider?: string): string | undefined {
  const reason = stopReason?.trim();
  if (!reason) return undefined;
  const entry = Object.hasOwn(STOP_REASON_WORDS, reason) ? STOP_REASON_WORDS[reason] : undefined;
  if (entry) return `${entry.words(provider?.trim() || "The AI")} (stop reason: ${reason}). ${entry.hint}`;
  return /^[a-z][a-z0-9_]*$/i.test(reason) ? `The engine stopped without saying why (stop reason: ${reason}).` : reason;
}

// Outbound actions: the calls that reach a person outside the app, or move
// money. Sending an email, replying in a thread, posting to a channel,
// publishing, inviting, sharing, refunding, charging. These get their own
// confirmation regardless of approval level, and an optional daily
// allowance per bot, because the cost of one wrong send is paid by someone
// who never saw the bot.
//
// Shared between the harness (which enforces it) and the app (which shows
// the setting), so both agree on what "outbound" means.

export type OutboundPolicy = {
  /** ask: every outbound call waits for a tap. allow: up to dailyCap a day. */
  policy: "ask" | "allow";
  dailyCap: number;
};

export const OUTBOUND_DEFAULT_CAP = 25;
const OUTBOUND_MAX_CAP = 1_000;

/** Tools whose action is one of these words send something somewhere. */
const SEND_VERBS = new Set([
  "SEND",
  "SENDS",
  "REPLY",
  "RESPOND",
  "FORWARD",
  "POST",
  "PUBLISH",
  "TWEET",
  "RETWEET",
  "BROADCAST",
  "INVITE",
  "SHARE",
  "REFUND",
  "CHARGE",
  "PAY",
  "PAYOUT",
  "TRANSFER",
]);

/** Creating one of these is sending it: a created comment is a comment
 * someone reads, a created invoice is one someone receives. */
const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM"]);

/** A read verb first means the rest of the name is what is being read:
 * REDDIT_GET_POST fetches a post, it does not post. */
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** The action part of a tool name, as upper-case word tokens. Composio's
 * TOOLKIT_ACTION drops its toolkit; an MCP server's mcp__server__action
 * drops its server; a bare built-in like Bash stays as it is. */
function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    action = rest.join("_");
    if (server === "composio") return actionTokens(action);
  } else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
    action = name.slice(name.indexOf("_") + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Does this tool send something to someone, or move money? */
export function isOutboundTool(name: string): boolean {
  // A raw API call from the workbench can do anything an app tool can, and
  // nothing here can read which; it is treated as a send.
  if (name === "COMPOSIO_PROXY_EXECUTE") return true;
  const tokens = actionTokens(name);
  if (tokens.length === 0) return false;
  if (tokens.includes("DRAFT")) return false;
  if (READ_VERBS.has(tokens[0])) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}

/** The stored shape, or null when the value is not one. */
export function normalizeOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { policy, dailyCap } = value as { policy?: unknown; dailyCap?: unknown };
  if (policy !== "ask" && policy !== "allow") return null;
  if (dailyCap === undefined) return { policy, dailyCap: OUTBOUND_DEFAULT_CAP };
  if (typeof dailyCap !== "number" || !Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > OUTBOUND_MAX_CAP) return null;
  return { policy, dailyCap };
}

/** What a bot without a stored policy does: ask, every time. */
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = { policy: "ask", dailyCap: OUTBOUND_DEFAULT_CAP };

/** One app tool a connector request would run, with its arguments when the
 * request carries them. */
export interface ConnectorCall {
  slug: string;
  arguments?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Composio's session exposes a handful of meta tools and runs the app
 * tools inside them: a multi-execute call carries a list of slugs with
 * arguments, and the remote workbench runs Python that names the slugs it
 * calls. This returns the app tools a tools/call would actually run —
 * the call itself when it is a plain app tool, the wrapped ones otherwise
 * — so a gate sees through the wrapper. Search, schema lookup, and
 * connection management run nothing and yield nothing. */
export function connectorCallsIn(name: string, args: unknown): ConnectorCall[] {
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = isRecord(args) && Array.isArray(args.tools) ? args.tools : [];
    const calls: ConnectorCall[] = [];
    for (const item of tools) {
      if (!isRecord(item)) continue;
      const slug = [item.tool_slug, item.slug, item.name, item.tool].find((value) => typeof value === "string" && value);
      if (typeof slug !== "string") continue;
      calls.push({ slug, ...(item.arguments !== undefined ? { arguments: item.arguments } : {}) });
    }
    return calls;
  }
  if (name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL") {
    const code = isRecord(args)
      ? [args.code_to_execute, args.code, args.command].find((value) => typeof value === "string")
      : undefined;
    if (typeof code !== "string") return [];
    const seen = new Set<string>();
    const calls: ConnectorCall[] = [];
    for (const match of code.matchAll(/\b([A-Z][A-Z0-9]+_[A-Z0-9_]{3,})\b/g)) {
      const slug = match[1];
      if (slug.startsWith("COMPOSIO_") || seen.has(slug)) continue;
      seen.add(slug);
      calls.push({ slug });
    }
    if (/\bproxy_execute\b/.test(code)) calls.push({ slug: "COMPOSIO_PROXY_EXECUTE" });
    return calls;
  }
  if (name.startsWith("COMPOSIO_")) return [];
  return [{ slug: name, ...(args !== undefined ? { arguments: args } : {}) }];
}

/** The subset of a request's app tools that would send something. */
export function outboundCallsIn(name: string, args: unknown): ConnectorCall[] {
  return connectorCallsIn(name, args).filter((call) => isOutboundTool(call.slug));
}

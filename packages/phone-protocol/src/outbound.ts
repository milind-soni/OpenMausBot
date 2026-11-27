// Outbound actions: calls that reach a person outside the app or move money.
// Below Full access they get their own confirmation unless the bot's rule sends
// without asking; at Full access they run unless the bot has a rule of its own.
// A read-and-draft routine run never reaches them: the relay refuses every send
// there. Shared by the harness (which enforces it) and the app.
import { isConnectedAppsServer } from "./own-apps.ts";

export type OutboundPolicy = {
  /** ask: every outbound call waits for a tap. allow: outbound calls go out without asking. */
  policy: "ask" | "allow";
};

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
  "BUY",
  "PURCHASE",
  "DIAL",
]);

/** Creating one of these is sending it: a created comment is a comment
 * someone reads, a created invoice is one someone receives, a created call rings someone. */
const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW", "MAKE"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM", "CALL"]);

/** Telnyx's hosted server reaches its whole API through one tool, so any call of it may ring, text or buy. */
const RAW_API_ACTION = /^mcp__.+__invoke_api_endpoint$|^mcp_.+_invoke_api_endpoint$/;

/** A read verb first means the rest of the name is what is being read:
 * REDDIT_GET_POST fetches a post, it does not post. */
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** Composio reads known by slug, since some put the noun first (GOOGLECALENDAR_EVENTS_LIST lists events). */
export const KNOWN_READ_SLUGS: ReadonlySet<string> = new Set([
  "GMAIL_FETCH_EMAILS",
  "GMAIL_GET_PROFILE",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_FIND_EVENT",
  "GOOGLECALENDAR_LIST_CALENDARS",
]);

/** The action part of a tool name, as upper-case word tokens. Composio's
 * TOOLKIT_ACTION drops its toolkit; an MCP server's mcp__server__action
 * drops its server; a bare built-in like Bash stays as it is. */
function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    action = rest.join("_");
    if (isConnectedAppsServer(server)) return actionTokens(action);
  } else if (/^mcp_/i.test(name)) {
    const flatConnected = /^mcp_(?:composio|own_apps)_(.+)$/i.exec(name);
    if (flatConnected) return actionTokens(flatConnected[1]!);
    const flatMcp = /^mcp_([^_]+)_(.+)$/i.exec(name);
    if (flatMcp) {
      const [, server, rest] = flatMcp;
      if (isConnectedAppsServer(server!)) return actionTokens(rest!);
      action = rest!;
    }
  } else if (/^(?:[A-Z][A-Z0-9]*|_[A-Z0-9]+)_[A-Z0-9_]+$/.test(name)) {
    const start = name.startsWith("_") ? 1 : 0;
    action = name.slice(name.indexOf("_", start) + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Does the tool name describe a read-only action? This is deliberately
 * narrower than "not outbound": updates, deletes and other writes do not
 * become reads merely because they send nothing to another person. */
export function isReadOnlyTool(name: string): boolean {
  if (KNOWN_READ_SLUGS.has(name.replace(/^mcp(?:__|_)(?:composio|own_apps)(?:__|_)/, ""))) return true;
  const tokens = actionTokens(name);
  return tokens.length > 0 && READ_VERBS.has(tokens[0]);
}

/** The built-in agents server's X research tools only read X: x_post reads a post, it does not post one. */
const AGENTS_X_READS = /^(?:mcp__agents__|mcp_agents_|agents__|agents_)?x_(?:search|user_posts|post|profile)$/;

const GENERIC_SUMMARY_MCP = /^Run\s+(mcp_[A-Za-z0-9_.:-]+)\b/i;

/** Resolves the underlying MCP tool name when an ACP driver reports `tool: "other"` with `summary: "Run mcp_..."`. */
export function effectiveToolName(name: string, summary?: string): string {
  const trimmed = name.trim();
  if (trimmed && trimmed.toLowerCase() !== "other") return name;
  if (summary) {
    const match = GENERIC_SUMMARY_MCP.exec(summary.trim());
    if (match?.[1]) return match[1];
  }
  return name;
}

/** Does this tool send something to someone, or move money? */
export function isOutboundTool(name: string, summary?: string): boolean {
  const resolved = effectiveToolName(name, summary);
  // A raw API call from the workbench can do anything an app tool can, and
  // nothing here can read which; it is treated as a send.
  if (resolved === "COMPOSIO_PROXY_EXECUTE" || resolved.endsWith("_COMPOSIO_PROXY_EXECUTE") || RAW_API_ACTION.test(resolved)) return true;
  if (AGENTS_X_READS.test(resolved)) return false;
  const tokens = actionTokens(resolved);
  if (tokens.length === 0) return false;
  if (isReadOnlyTool(resolved)) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  if (tokens.includes("DRAFT")) return false;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}

/** The stored shape, or null when the value is not one. Fields other than `policy` are dropped. */
export function normalizeOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { policy } = value as { policy?: unknown };
  return policy === "ask" || policy === "allow" ? { policy } : null;
}

/** What a bot without a stored policy does: ask, every time. */
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = { policy: "ask" };

/** The rule a bot's sends follow: its own, or without one, sending freely at Full access and asking otherwise. */
export function effectiveOutboundPolicy(rule: OutboundPolicy | undefined, fullAccess: boolean): OutboundPolicy {
  return rule ?? (fullAccess ? { policy: "allow" } : DEFAULT_OUTBOUND_POLICY);
}

/** Drops from a stored bot's rule what `normalizeOutboundPolicy` drops, so every copy of one rule reads the same; true
 * when it changed. A rule that is not one is left as it is, and asks. */
export function trimOutboundPolicy(bot: { outbound?: OutboundPolicy }): boolean {
  const kept = bot.outbound && normalizeOutboundPolicy(bot.outbound);
  if (!kept || Object.keys(bot.outbound!).length === Object.keys(kept).length) return false;
  bot.outbound = kept;
  return true;
}

/** One app tool a connector request would run, with its arguments when the
 * request carries them. */
export interface ConnectorCall {
  slug: string;
  arguments?: unknown;
  /** The connected account a multi-execute item names (its id or alias). */
  account?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Composio's session exposes a handful of meta tools and runs the app
 * tools inside them: a multi-execute call carries a list of slugs with
 * arguments. Arbitrary workbench/bash code is opaque: it requires an
 * explicit unrestricted approval, never an inferred app or send count.
 * Search, schema lookup, and connection management run no app tools. */
export function connectorCallsIn(name: string, args: unknown): ConnectorCall[] {
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = isRecord(args) && Array.isArray(args.tools) ? args.tools
      : isRecord(args) && typeof args.tool_slug === "string" ? [args] : [];
    if (!tools.length) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
    const calls: ConnectorCall[] = [];
    for (const item of tools) {
      if (!isRecord(item)) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
      const slug = [item.tool_slug, item.slug, item.name, item.tool].find((value) => typeof value === "string" && value);
      if (typeof slug !== "string") return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
      calls.push({
        slug,
        ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
        ...(typeof item.account === "string" && item.account.trim() ? { account: item.account.trim() } : {}),
      });
    }
    return calls;
  }
  if (name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL") {
    // Arbitrary code can compute tool names and repeat calls. Its app and
    // outbound count cannot be inferred from literals in the source.
    return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
  }
  if (["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"].includes(name)) return [];
  if (name.startsWith("COMPOSIO_")) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
  return [{ slug: name, ...(args !== undefined ? { arguments: args } : {}) }];
}

/** The subset of a request's app tools that would send something. */
export function outboundCallsIn(name: string, args: unknown): ConnectorCall[] {
  return connectorCallsIn(name, args).filter((call) => isOutboundTool(call.slug));
}

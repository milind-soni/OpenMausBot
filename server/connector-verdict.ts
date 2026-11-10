// The harness-side verdict for connected-app tool calls: every Composio call crosses POST /api/internal/connectors/mcp,
// where the loopback token names the bot. Unrecognized argument shapes are denied: "this bot may call exactly these tools"
// must hold even against a model that garbles the protocol.
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";
import { EMAIL_SLUG } from "../shared/email.ts";

/** The connected apps' sandbox: Composio's code tools. Code run there can reach any connected app, past a bot's per-app
 * grants and scopes, so a bot that has either runs it only at Full access, and only by a direct call. */
export const APP_SANDBOX_TOOLS: readonly string[] = ["COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"];

/** The service Composio's own tools are named for (COMPOSIO_REMOTE_WORKBENCH → composio). */
export const APP_SANDBOX_SERVICE = "composio";

/** A bot with per-app grants asked to run code in the apps' sandbox below Full access, or inside a batch. */
export const APP_SANDBOX_REFUSAL = "This call was not performed. A bot with its own connected-app grants runs code in the apps' "
  + "sandbox only at Full access, and only by calling COMPOSIO_REMOTE_WORKBENCH or COMPOSIO_REMOTE_BASH_TOOL directly (never inside "
  + "COMPOSIO_MULTI_EXECUTE_TOOL). Use a direct app tool, or tell the person this needs Full access.";

const OPAQUE_CODE_REFUSAL = "OpenMausBot cannot verify this code against this bot's tool grants. Use a direct app tool.";

/** A tools/call frame that calls the apps' sandbox directly. */
function appSandboxCall(frame: unknown): boolean {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return false;
  const { method, params } = frame as { method?: unknown; params?: unknown };
  const name = params && typeof params === "object" && !Array.isArray(params) ? (params as { name?: unknown }).name : undefined;
  return method === "tools/call" && typeof name === "string" && APP_SANDBOX_TOOLS.includes(name);
}

/** The relay's rule for the apps' sandbox: a direct call to it passes a bot's per-app grants and scopes only while the turn
 * runs at Full access, judged again each time it is asked (at dispatch too). `refusal` is what a bot with grants is told
 * when code it sent cannot be checked against them. */
export function appSandboxRule(frame: unknown, fullAccess: () => boolean): { open(): boolean; refusal: string } {
  const direct = appSandboxCall(frame);
  return { open: () => direct && fullAccess(), refusal: direct ? APP_SANDBOX_REFUSAL : OPAQUE_CODE_REFUSAL };
}

/** The only Composio meta-tool whose arguments name target tools. */
export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

export type ConnectorCall =
  | { kind: "passthrough" }
  | { kind: "tools"; invoked: string; names: string[] }
  | { kind: "unrecognized"; invoked: string; reason: string };

export interface ConnectorDenial {
  tool: string;
  /** null when the name carries no service prefix at all. */
  service: string | null;
  /** the service is granted but the exact tool is not on its list. */
  onGrantedService: boolean;
}

export interface ConnectorVerdict {
  allowed: boolean;
  legacy: boolean;
  denials: ConnectorDenial[];
  rule: string;
}

/** Composio's upper-snake prefix before the first underscore, lowercased (GMAIL_SEND_EMAIL → gmail); no underscore, no service. */
export function serviceSlugFor(tool: string): string | null {
  const underscore = tool.indexOf("_");
  if (underscore <= 0) return null;
  return tool.slice(0, underscore).toLowerCase();
}

/** Real slugs may contain underscores (bland_ai), so the longest matching candidate wins over the plain split. */
export function serviceSlugForCandidates(tool: string, candidates: readonly string[]): string | null {
  let match: string | null = null;
  for (const candidate of candidates) {
    if (tool.startsWith(candidate.toUpperCase() + "_") && (match === null || candidate.length > match.length)) {
      match = candidate;
    }
  }
  return match;
}

export function connectorCallFromFrame(payload: unknown): ConnectorCall {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "passthrough" };
  const frame = payload as { method?: unknown; params?: unknown };
  if (frame.method !== "tools/call") return { kind: "passthrough" };
  const params = frame.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call carried no params object" };
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || !name) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call named no tool" };
  }
  if (name === COMPOSIO_MULTI_EXECUTE_TOOL) {
    return multiExecuteCall(name, (params as { arguments?: unknown }).arguments);
  }
  if (name.startsWith("COMPOSIO_")) return { kind: "passthrough" };
  // Per-service connection cards keep their card flow in any spelling.
  if (name.endsWith("_MANAGE_CONNECTIONS") || name.endsWith("_WAIT_FOR_CONNECTIONS")) {
    return { kind: "passthrough" };
  }
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) {
    return { kind: "unrecognized", invoked: name, reason: "the tool name is not a Composio tool name" };
  }
  return { kind: "tools", invoked: name, names: [name] };
}

/** Composio's schema is a 1-50 item `tools` array of { tool_slug, arguments } (a legacy single { tool_slug } is accepted); anything else is denied. */
function multiExecuteCall(invoked: string, args: unknown): ConnectorCall {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { kind: "unrecognized", invoked, reason: "the arguments were not an object" };
  }
  const tools = (args as { tools?: unknown }).tools;
  const singleSlug = (args as { tool_slug?: unknown }).tool_slug;
  if (Array.isArray(tools)) {
    if (tools.length === 0) {
      return { kind: "unrecognized", invoked, reason: "the tools list was empty" };
    }
    const names: string[] = [];
    for (const item of tools) {
      const slug = item && typeof item === "object" && !Array.isArray(item)
        ? (item as { tool_slug?: unknown }).tool_slug
        : undefined;
      if (typeof slug !== "string" || !slug) {
        return { kind: "unrecognized", invoked, reason: "an entry in the tools list named no tool_slug" };
      }
      names.push(slug);
    }
    return { kind: "tools", invoked, names };
  }
  if (typeof singleSlug === "string" && singleSlug) {
    return { kind: "tools", invoked, names: [singleSlug] };
  }
  return { kind: "unrecognized", invoked, reason: "the arguments named no tools to execute" };
}

/** No record is the legacy all-tools bot; a record, even empty, allows only what it names. Service keys are own properties
 * only, so CONSTRUCTOR_X never matches an inherited property. Empty `candidates` (catalog unreachable) degrades open. */
export function evaluateConnectorTools(
  names: string[],
  grants: Record<string, ConnectorToolGrant> | undefined,
  candidates: readonly string[] = [],
): ConnectorVerdict {
  if (grants === undefined) {
    return { allowed: true, legacy: true, denials: [], rule: "composio" };
  }
  const denials: ConnectorDenial[] = [];
  let rule = "";
  for (const tool of new Set(names)) {
    const service = serviceSlugForCandidates(tool, candidates) ?? serviceSlugFor(tool);
    const grant = service !== null && Object.hasOwn(grants, service)
      ? grants[service]
      : undefined;
    if (grant && (grant.tools === "*" || grant.tools.includes(tool))) {
      if (!rule) rule = "connectorTools." + service;
      continue;
    }
    denials.push({ tool, service, onGrantedService: Boolean(grant) });
  }
  return { allowed: denials.length === 0, legacy: false, denials, rule };
}

/** Never lists what the bot could have called instead: enumerating adjacent grants teaches the model to probe. */
export function connectorRefusalText(denials: ConnectorDenial[]): string {
  if (denials.length && denials.every((denial) => APP_SANDBOX_TOOLS.includes(denial.tool))) return APP_SANDBOX_REFUSAL;
  const named = denials.map((denial) => '"' + denial.tool + '"').join(", ");
  const one = denials.length === 1;
  return [
    named + " " + (one ? "is" : "are") + " not granted to this bot.",
    "This call was not performed.",
    "Ask the person to grant " + (one ? "it" : "these tools") + " in OpenMausBot if they want " + (one ? "it" : "them") + " run.",
  ].join(" ");
}

export function connectorUnrecognizedText(invoked: string, reason: string): string {
  return [
    "A " + invoked + " call arrived in a shape OpenMausBot could not read (" + reason + "), so it was not performed.",
    invoked === COMPOSIO_MULTI_EXECUTE_TOOL
      ? "Send it again with the tools to execute as tools: [{ tool_slug, arguments }]."
      : "Send a well-formed call that names the tools to execute.",
    "Ask the person to grant any tool this bot needs.",
  ].join(" ");
}

export function connectorScopeRefusalText(call: ConnectorCall, reason: "app" | "write", bot: string, app: string, tool: string): string {
  if (call.kind === "unrecognized") return connectorUnrecognizedText(call.invoked, call.reason);
  return reason === "app"
    ? `OpenMausBot did not run this: ${bot} has not been given access to ${app}. Ask the user to allow it under the bot's Access settings, and do not retry.`
    : `OpenMausBot did not run this: ${app} is read-only for ${bot}, and ${tool} would write to it. Ask the user before trying again.`;
}

/** Connected-app services a connectorTools grant names. The built-in Email app is never in the connected-apps inventory or
 * catalog; its own tools check its grant when called. */
export function connectedAppGrantSlugs(grants: Record<string, ConnectorToolGrant>): string[] {
  return Object.keys(grants).filter((slug) => slug !== EMAIL_SLUG);
}

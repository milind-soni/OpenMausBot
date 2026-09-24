// The harness-side verdict for connected-app tool calls (issue #1736, part
// of the per-bot Composio tool grants umbrella #1734).
//
// Every Composio tool call crosses POST /api/internal/connectors/mcp: the
// provider CLIs talk to the stdio bridge, and the bridge forwards each
// JSON-RPC frame there. So the grants verdict lives on the harness side,
// where the loopback token already names the bot and the decision log is
// native — the bridge never sees a key it could have to enforce with.
//
// Three shapes reach this module:
//
//   * a direct per-toolkit call — params.name is the tool itself, e.g.
//     GMAIL_SEND_EMAIL;
//   * the executor meta-tool — COMPOSIO_MULTI_EXECUTE_TOOL, whose
//     arguments name one or many target tools;
//   * everything else — connection cards, discovery, notifications —
//     which passes through untouched (advertisement filtering is slice 3).
//
// Unrecognized argument shapes are denied by default: a call whose target
// tools cannot be read is a call whose tools cannot be checked, and the
// grants promise — "this bot may call exactly these tools" — must hold
// even against a model that garbles the protocol.
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";

/** The executor meta-tool: the only meta-tool whose arguments name target
 * tools. Discovery and connection meta-tools keep their existing flows. */
export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/** One tools/call frame, classified for the verdict. names carries every
 * target tool in call order (duplicates preserved for the audit summary;
 * the verdict itself judges distinct names). */
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
  /** the bot carries no connectorTools record: legacy all-tools behavior. */
  legacy: boolean;
  denials: ConnectorDenial[];
  /** the grant key that allowed the first tool, for the allow row. */
  rule: string;
}

/** The service a Composio tool name belongs to: the upper-snake prefix
 * before the first underscore, lowercased (GMAIL_SEND_EMAIL to gmail). A
 * name with no underscore names no service, so no grant can cover it. */
export function serviceSlugFor(tool: string): string | null {
  const underscore = tool.indexOf("_");
  if (underscore <= 0) return null;
  return tool.slice(0, underscore).toLowerCase();
}

/** Classify one relayed JSON-RPC frame. Anything that is not a tools/call,
 * or is a discovery/connection/platform meta-tool, passes through. */
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
  // Platform meta-tools (search, schemas, remote workbench) are not
  // connected-app tools; grants are keyed by service slug, and slice 3
  // owns what the model is even shown.
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

/** Read the target tools out of COMPOSIO_MULTI_EXECUTE_TOOL arguments:
 * the upstream schema is a 1-50 item tools array of { tool_slug,
 * arguments }; a legacy single { tool_slug } object is accepted too.
 * Anything else cannot be checked, so it is denied. */
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

/** Judge distinct target names against a bot's grants. grants undefined
 * is the legacy all-tools bot and passes everything; an explicit record —
 * including the empty one — allows only what it names. */
export function evaluateConnectorTools(
  names: string[],
  grants: Record<string, ConnectorToolGrant> | undefined,
): ConnectorVerdict {
  if (grants === undefined) {
    return { allowed: true, legacy: true, denials: [], rule: "composio" };
  }
  const denials: ConnectorDenial[] = [];
  let rule = "";
  for (const tool of new Set(names)) {
    const service = serviceSlugFor(tool);
    const grant = service === null ? undefined : grants[service];
    if (grant && (grant.tools === "*" || grant.tools.includes(tool))) {
      if (!rule) rule = "connectorTools." + service;
      continue;
    }
    denials.push({ tool, service, onGrantedService: Boolean(grant) });
  }
  return { allowed: denials.length === 0, legacy: false, denials, rule };
}

/** Safe to hand straight to the model: names the refused tool and says who
 * can change it. It never lists what the bot could have called instead —
 * a refusal that enumerates adjacent grants teaches the model to probe. */
export function connectorRefusalText(denials: ConnectorDenial[]): string {
  const named = denials.map((denial) => '"' + denial.tool + '"').join(", ");
  const one = denials.length === 1;
  return [
    named + " " + (one ? "is" : "are") + " not granted to this bot.",
    "This call was not performed.",
    "Ask the person to grant " + (one ? "it" : "these tools") + " in OpenMausBot if they want " + (one ? "it" : "them") + " run.",
  ].join(" ");
}

/** The unrecognized-shape refusal: names the meta-tool and what could not
 * be read, and still points at the person rather than at any tool list. */
export function connectorUnrecognizedText(invoked: string, reason: string): string {
  return [
    "A " + invoked + " call arrived in a shape OpenMausBot could not read (" + reason + "), so it was not performed.",
    "Send a well-formed call that names the tools to execute.",
    "Ask the person to grant any tool this bot needs.",
  ].join(" ");
}

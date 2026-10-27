// Trims the connector bridge's tools/list to the bot's grants; call-time enforcement stays the authority. Whenever
// filtering cannot run (no env var, malformed, oversized) the bridge relays the list untouched.
import { CONNECTOR_SLUG_PATTERN, CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";

export const CONNECTOR_ALLOWED_TOOLS_ENV = "OMB_CONNECTOR_ALLOWED_TOOLS";

export const CONNECTOR_SERVICE_SLUGS_ENV = "OMB_CONNECTOR_SERVICE_SLUGS";

/** Past this the env var is omitted: mounting must never depend on catalog size. */
export const CONNECTOR_ALLOWED_TOOLS_MAX_BYTES = 32 * 1024;

export const CONNECTOR_SERVICE_SLUGS_MAX_BYTES = 32 * 1024;

/** Platform meta-tools stay advertised whenever any tool is granted; the executor's arguments are still judged at call time. */
export const CONNECTOR_META_TOOLS: readonly string[] = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  // Composio ships COMPOSIO_MANAGE_CONNECTIONS in every session; COMPOSIO_WAIT_FOR_CONNECTIONS is opt-in and off by default.
  // The filter keeps only names upstream lists, so advertising an opted-out one changes nothing.
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
];

const CONNECTION_TOOL_SUFFIXES = ["_MANAGE_CONNECTIONS", "_WAIT_FOR_CONNECTIONS"];

export function serializeConnectorAllowedTools(
  grants: Record<string, ConnectorToolGrant>,
): { env?: string; oversized: boolean } {
  const env = JSON.stringify(grants);
  if (Buffer.byteLength(env, "utf8") > CONNECTOR_ALLOWED_TOOLS_MAX_BYTES) return { oversized: true };
  return { env, oversized: false };
}

export function serializeConnectorServiceSlugs(
  slugs: readonly string[],
): { env?: string; oversized: boolean } {
  const unique = [...new Set(slugs.filter((slug) => CONNECTOR_SLUG_PATTERN.test(slug)))];
  if (!unique.length) return { oversized: false };
  const env = JSON.stringify(unique);
  if (Buffer.byteLength(env, "utf8") > CONNECTOR_SERVICE_SLUGS_MAX_BYTES) return { oversized: true };
  return { env, oversized: false };
}

/** Anything off reads as "no allowlist": relay the unfiltered list rather than guess a narrower one. */
export function parseConnectorAllowedToolsEnv(raw: string | undefined): Record<string, ConnectorToolGrant> | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grants: Record<string, ConnectorToolGrant> = {};
  for (const [slug, grant] of Object.entries(value as Record<string, unknown>)) {
    if (!CONNECTOR_SLUG_PATTERN.test(slug)) return null;
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return null;
    const tools = (grant as { tools?: unknown }).tools;
    if (tools === "*") {
      grants[slug] = { tools: "*" };
      continue;
    }
    if (!Array.isArray(tools) || tools.length === 0) return null;
    if (!tools.every((tool): tool is string => typeof tool === "string" && CONNECTOR_TOOL_NAME_PATTERN.test(tool))) {
      return null;
    }
    grants[slug] = { tools };
  }
  return grants;
}

/** Anything off reads as an empty list: the plain split rather than a partial inventory. */
export function parseConnectorServiceSlugsEnv(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.every((slug): slug is string => typeof slug === "string" && CONNECTOR_SLUG_PATTERN.test(slug))
    ? value
    : [];
}

/** Offered when its service is granted with `"*"`, its exact name is granted, or it is that service's connection flow.
 *  COMPOSIO_MANAGE_CONNECTIONS is always offered: a bot with no grants still has to be able to ask for a sign-in. */
export function connectorToolAdvertised(
  name: string,
  grants: Record<string, ConnectorToolGrant>,
  candidates: readonly string[] = [],
): boolean {
  if (name === "COMPOSIO_MANAGE_CONNECTIONS") return true;
  if (Object.keys(grants).length > 0 && CONNECTOR_META_TOOLS.includes(name)) return true;
  const service = serviceSlugForCandidates(name, candidates) ?? serviceSlugFor(name);
  const grant = service === null ? undefined : grants[service];
  if (!grant) return false;
  if (grant.tools === "*") return true;
  if (grant.tools.includes(name)) return true;
  return CONNECTION_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** A frame without a readable tools array passes through unchanged: degrade, never guess. */
export function filterToolsListFrame(
  frame: Record<string, unknown>,
  grants: Record<string, ConnectorToolGrant>,
  candidates: readonly string[] = [],
): Record<string, unknown> {
  const result = frame.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return frame;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return frame;
  const kept = tools.filter((tool) => {
    const name = tool && typeof tool === "object" && !Array.isArray(tool)
      ? (tool as { name?: unknown }).name
      : undefined;
    return typeof name === "string" ? connectorToolAdvertised(name, grants, candidates) : true;
  });
  return { ...frame, result: { ...(result as Record<string, unknown>), tools: kept } };
}

const AUTH_CONFIG_PARAMETER = {
  type: "string",
  description: "Optional, read by OpenMausBot: the id (ac_…) of an auth config in the person's own Composio project to "
    + "connect the one listed toolkit with. Leave it out to use their most recently created enabled config for it.",
};

/** COMPOSIO_MANAGE_CONNECTIONS as OpenMausBot's connection cards read it: Composio's schema has no auth config id. */
export function withAuthConfigParameter(frame: Record<string, unknown>): Record<string, unknown> {
  const result = frame.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return frame;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return frame;
  const withParameter = tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    const { name, inputSchema } = tool as { name?: unknown; inputSchema?: unknown };
    if (typeof name !== "string" || !name.endsWith("_MANAGE_CONNECTIONS")) return tool;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return tool;
    const properties = (inputSchema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties) || "auth_config_id" in properties) return tool;
    return { ...tool, inputSchema: { ...inputSchema, properties: { ...properties, auth_config_id: AUTH_CONFIG_PARAMETER } } };
  });
  return { ...frame, result: { ...(result as Record<string, unknown>), tools: withParameter } };
}

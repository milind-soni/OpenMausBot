// Advertisement filtering for the connector MCP bridge (issue #1737, part
// of the per-bot Composio tool grants umbrella #1734).
//
// Call-time enforcement (connector-verdict.ts, slice 2) stays the
// authority: it judges the real tool names on the harness relay endpoint,
// where the loopback token already names the bot. This module is surface
// only — it trims a tools/list response to the tools the bot was granted,
// so the model is never offered a call that would be refused a moment
// later. The allowlist reaches the bridge as JSON in the environment, the
// same channel every other bridge input uses; whenever filtering cannot
// run — no env var, malformed env, oversized payload — the bridge relays
// the list untouched and the grants stay enforced at call time.
import { CONNECTOR_SLUG_PATTERN, CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";

/** The env var mcpIntegration sets and connector-proxy.ts reads. */
export const CONNECTOR_ALLOWED_TOOLS_ENV = "OMB_CONNECTOR_ALLOWED_TOOLS";

/** The env var carrying the connected-service slugs the filter resolves
 * tool-name prefixes against. Without it the filter falls back to the
 * plain first-segment split, exactly as when the catalog is unreachable. */
export const CONNECTOR_SERVICE_SLUGS_ENV = "OMB_CONNECTOR_SERVICE_SLUGS";

/** Upper bound for the serialized allowlist. Past it the env var is
 * omitted entirely (mounting must never depend on catalog size) and the
 * bot keeps the unfiltered list with call-time enforcement only. */
export const CONNECTOR_ALLOWED_TOOLS_MAX_BYTES = 32 * 1024;

/** Upper bound for the serialized slug list; past it the env var is
 * omitted and the filter falls back to the plain split. */
export const CONNECTOR_SERVICE_SLUGS_MAX_BYTES = 32 * 1024;

/** The platform meta-tools. They name no connected-app tool themselves —
 * search and schemas discover, the executor runs what it is told — so
 * they stay advertised whenever any tool is granted; the executor's
 * arguments are still judged call-time by connector-verdict.ts. */
export const CONNECTOR_META_TOOLS: readonly string[] = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  // Session-level connection meta-tools. COMPOSIO_MANAGE_CONNECTIONS ships
  // in every Composio session; COMPOSIO_WAIT_FOR_CONNECTIONS is opt-in and
  // off by default. They prefix as service "composio", which no grant
  // names, so they ride this list instead of CONNECTION_TOOL_SUFFIXES —
  // connector-proxy intercepts their calls to surface connection cards.
  // The filter only keeps names upstream actually lists, so advertising an
  // opted-out tool changes nothing.
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
];

const CONNECTION_TOOL_SUFFIXES = ["_MANAGE_CONNECTIONS", "_WAIT_FOR_CONNECTIONS"];

/** Harness side: serialize a grants record for the bridge env, or report
 * that it exceeded the cap (the caller warns and omits it). */
export function serializeConnectorAllowedTools(
  grants: Record<string, ConnectorToolGrant>,
): { env?: string; oversized: boolean } {
  const env = JSON.stringify(grants);
  if (Buffer.byteLength(env, "utf8") > CONNECTOR_ALLOWED_TOOLS_MAX_BYTES) return { oversized: true };
  return { env, oversized: false };
}

/** Harness side: serialize the connected-service slugs for the bridge
 * env, or report that they exceeded the cap. Duplicate or non-slug
 * entries are dropped rather than failing the whole mount. */
export function serializeConnectorServiceSlugs(
  slugs: readonly string[],
): { env?: string; oversized: boolean } {
  const unique = [...new Set(slugs.filter((slug) => CONNECTOR_SLUG_PATTERN.test(slug)))];
  if (!unique.length) return { oversized: false };
  const env = JSON.stringify(unique);
  if (Buffer.byteLength(env, "utf8") > CONNECTOR_SERVICE_SLUGS_MAX_BYTES) return { oversized: true };
  return { env, oversized: false };
}

/** Bridge side: decode and shape-check the allowlist env. Anything off —
 * absent, unparseable, wrong shapes — reads as "no allowlist" so the
 * bridge degrades to relaying the unfiltered list rather than guessing a
 * narrower one. Call-time enforcement holds either way. */
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

/** Bridge side: decode the connected-service slug list. Anything off —
 * absent, unparseable, or one bad entry — reads as an empty list so the
 * filter degrades to the plain split instead of trusting a partial
 * inventory. */
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

/** Whether one advertised tool name survives the filter. A tool is
 * offered when its service is granted with `"*`", when its exact name is
 * granted, or when it is that service's connection flow — a card the
 * person approves, which slice 2 passes through at call time and which a
 * bot granted a service should still be able to offer for another
 * account. */
export function connectorToolAdvertised(
  name: string,
  grants: Record<string, ConnectorToolGrant>,
  candidates: readonly string[] = [],
): boolean {
  if (Object.keys(grants).length > 0 && CONNECTOR_META_TOOLS.includes(name)) return true;
  // The connected-service slugs are the resolver's candidates, so an
  // underscored service (bland_ai) claims its own tools instead of a
  // plain-prefix grant (bland) widening them; an unreachable catalog
  // leaves the list empty and the plain split stands.
  const service = serviceSlugForCandidates(name, candidates) ?? serviceSlugFor(name);
  const grant = service === null ? undefined : grants[service];
  if (!grant) return false;
  if (grant.tools === "*") return true;
  if (grant.tools.includes(name)) return true;
  return CONNECTION_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Filter one upstream tools/list response — the bridge normalizes SSE and
 * JSON upstreams to a single frame first, so both shapes flow through
 * here. Returns a shallow copy with result.tools trimmed; a frame without
 * a readable tools array passes through unchanged (degrade, never guess).
 * Entries the filter cannot read a name from are kept as-is. */
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

import type { ConnectorToolGrant } from "../shared/wire.ts";
import { CONNECTOR_SLUG_PATTERN, CONNECTOR_TOOL_NAME_PATTERN } from "../shared/wire.ts";

export const CONNECTOR_SLUGS_MAX = 64;
export const CONNECTOR_TOOLS_PER_SERVICE_MAX = 500;

export function parseConnectorTools(value: unknown): { ok: true; grants: Record<string, ConnectorToolGrant> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "connectorTools must be an object of service slugs to tool grants" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CONNECTOR_SLUGS_MAX) {
    return { ok: false, error: `connectorTools may name at most ${CONNECTOR_SLUGS_MAX} services` };
  }
  const grants: Record<string, ConnectorToolGrant> = {};
  for (const [slug, grant] of entries) {
    if (!CONNECTOR_SLUG_PATTERN.test(slug)) {
      return { ok: false, error: `connectorTools service slugs must be lowercase slugs (got "${slug}")` };
    }
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      return { ok: false, error: `connectorTools.${slug} must be a grant like { tools: "*" } or { tools: ["TOOL_NAME"] }` };
    }
    const keys = Object.keys(grant);
    if (keys.length !== 1 || keys[0] !== "tools") {
      return { ok: false, error: `connectorTools.${slug} accepts only a tools field` };
    }
    const tools = (grant as { tools: unknown }).tools;
    if (tools === "*") {
      grants[slug] = { tools: "*" };
      continue;
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, error: `connectorTools.${slug}.tools must be "*" or a non-empty list of tool names (use {} to grant no tools)` };
    }
    if (tools.length > CONNECTOR_TOOLS_PER_SERVICE_MAX) {
      return { ok: false, error: `connectorTools.${slug}.tools may list at most ${CONNECTOR_TOOLS_PER_SERVICE_MAX} tools` };
    }
    const names: string[] = [];
    for (const tool of tools) {
      if (typeof tool !== "string" || !CONNECTOR_TOOL_NAME_PATTERN.test(tool)) {
        return { ok: false, error: `connectorTools.${slug}.tools names must be Composio tool names like GMAIL_SEND_EMAIL` };
      }
      if (!names.includes(tool)) names.push(tool);
    }
    grants[slug] = { tools: names };
  }
  return { ok: true, grants };
}

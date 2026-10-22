import { AUTH_CONFIG_ID } from "../shared/connector-availability.ts";
import { inputError } from "./composio-project.ts";
import { normalizeAccountAlias } from "./composio.ts";

const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;

export interface ConnectorRequestItem {
  slug: string;
  alias?: string;
  /** An auth config in the person's own Composio project that the bot asked this toolkit to connect with. */
  authConfigId?: string;
}

/** A bridge's connection requests: an unknown slug is skipped, a bad alias or auth config id refuses the request. */
export function connectorRequestItems(rawItems: readonly unknown[]): ConnectorRequestItem[] {
  const items: ConnectorRequestItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw === "string") {
      const slug = raw.trim().toLowerCase();
      if (CONNECTOR_SLUG.test(slug)) items.push({ slug });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as { slug?: unknown; toolkit?: unknown; alias?: unknown; account?: unknown; authConfigId?: unknown };
    const slug = typeof row.slug === "string" ? row.slug : typeof row.toolkit === "string" ? row.toolkit : undefined;
    if (!slug || !CONNECTOR_SLUG.test(slug.toLowerCase())) continue;
    const alias = normalizeAccountAlias((row.alias ?? row.account) as string | undefined);
    const { authConfigId } = row;
    if (authConfigId !== undefined && (typeof authConfigId !== "string" || !AUTH_CONFIG_ID.test(authConfigId))) {
      throw inputError("authConfigId must be a Composio auth config id (ac_…)");
    }
    items.push({ slug: slug.toLowerCase(), ...(alias ? { alias } : {}), ...(authConfigId ? { authConfigId } : {}) });
  }
  return items;
}

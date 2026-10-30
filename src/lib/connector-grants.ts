import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../../shared/wire";

/** Preset hints, not a security boundary: the grant always stores the expanded explicit list. */
export type ConnectorVerb = "read" | "draft" | "send" | "modify" | "delete";

const VERB_WORDS: ReadonlyArray<readonly [ConnectorVerb, readonly string[]]> = [
  ["delete", ["DELETE", "REMOVE", "TRASH", "PURGE", "DESTROY"]],
  ["modify", ["UPDATE", "EDIT", "MODIFY", "PATCH", "SET", "RENAME", "MOVE", "TAG", "MARK", "UPLOAD", "ASSIGN", "APPROVE", "REJECT", "ARCHIVE", "PIN", "UNPIN", "STAR", "LABEL", "ENABLE", "DISABLE", "TOGGLE", "CANCEL", "CLOSE", "COMPLETE", "TRANSFER", "INSERT"]],
  ["send", ["SEND", "REPLY", "FORWARD", "PUBLISH", "POST", "SHARE", "NOTIFY", "INVITE", "MENTION", "COMMENT", "MESSAGE", "TWEET", "EMAIL", "MAIL", "CALL", "SMS", "TEXT"]],
  ["draft", ["CREATE", "ADD", "NEW", "DRAFT", "COMPOSE", "GENERATE", "WRITE", "MAKE", "BUILD"]],
  ["read", ["READ", "LIST", "GET", "SEARCH", "FIND", "FETCH", "QUERY", "SHOW", "VIEW", "RETRIEVE", "LOOKUP", "CHECK", "DESCRIBE", "BROWSE", "DOWNLOAD", "STATS"]],
];

/** The more-privileged class wins regardless of word order (GMAIL_CREATE_AND_SEND sends). */
export function classifyConnectorTool(name: string): ConnectorVerb | null {
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) return null;
  const words = name.split("_");
  for (const [verb, markers] of VERB_WORDS) {
    if (words.some((word) => markers.includes(word))) return verb;
  }
  return null;
}

/** A newer server may widen the shape: render unknown grants read-only, never round-trip a guess through a PATCH. */
export function isConnectorToolGrantShape(value: unknown): value is ConnectorToolGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tools = (value as { tools?: unknown }).tools;
  if (tools === "*") return true;
  return Array.isArray(tools)
    && tools.length > 0
    && tools.every((tool): tool is string => typeof tool === "string" && CONNECTOR_TOOL_NAME_PATTERN.test(tool));
}

export function isConnectorToolsRecordShape(value: unknown): value is Record<string, ConnectorToolGrant> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((grant) => isConnectorToolGrantShape(grant));
}

export type ConnectorAccessLevel = "all" | "partial" | "none";

export interface ConnectorServiceAccess {
  level: ConnectorAccessLevel;
  count: number;
  editable: boolean;
}

export function connectorServiceAccess(
  grants: unknown,
  slug: string,
): ConnectorServiceAccess {
  if (grants === undefined || grants === null) return { level: "all", count: 0, editable: true };
  if (typeof grants !== "object" || Array.isArray(grants)) {
    return { level: "partial", count: 0, editable: false };
  }
  const record = grants as Record<string, unknown>;
  const editable = isConnectorToolsRecordShape(record);
  const grant = record[slug];
  if (grant === undefined) return { level: "none", count: 0, editable };
  if (!isConnectorToolGrantShape(grant)) return { level: "partial", count: 0, editable: false };
  if (grant.tools === "*") return { level: "all", count: 0, editable };
  return { level: "partial", count: grant.tools.length, editable };
}

export type ConnectorGrantsState = "off" | "full" | "partial" | "none" | "unreadable";

export function connectorGrantsState(bot: { composio?: boolean; connectorTools?: unknown }): ConnectorGrantsState {
  if (bot.composio === false) return "off";
  const grants = bot.connectorTools;
  if (grants === undefined || grants === null) return "full";
  if (typeof grants !== "object" || Array.isArray(grants)) return "unreadable";
  const entries = Object.entries(grants as Record<string, unknown>);
  if (!entries.length) return "none";
  if (!entries.every(([, grant]) => isConnectorToolGrantShape(grant))) return "unreadable";
  return "partial";
}

export function withServiceGrant(
  current: unknown,
  slug: string,
  next: { tools: "*" | string[] } | null,
  knownSlugs: readonly string[] = [],
): Record<string, ConnectorToolGrant> | undefined {
  if (current !== undefined && current !== null && !isConnectorToolsRecordShape(current)) return undefined;
  const record: Record<string, ConnectorToolGrant> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, ConnectorToolGrant>) }
      // No record means every connected app keeps every tool. Seed that "all"
      // for the apps we know about, so restricting one app leaves the others
      // alone instead of silently emptying them.
      : Object.fromEntries(knownSlugs.map((known) => [known, { tools: "*" as const }]));
  if (next === null) delete record[slug];
  else record[slug] = { tools: next.tools };
  return record;
}

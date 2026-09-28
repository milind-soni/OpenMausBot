// Pure helpers for the per-bot connector tool grants UI (issue #1738, part
// of the per-bot Composio tool grants umbrella #1734). Everything here is
// display sugar over the exact-name data model from slice 1: verb presets
// suggest a set of names, the editor always saves explicit names, and a
// shape this build does not recognize renders read-only instead of being
// rewritten by the renderer.
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../../shared/wire";

/** The verb classes the editor offers as preset chips. They are ordering
 * hints for a person scanning 200 tool names, not a security boundary —
 * what lands in the grant is always the expanded explicit list. */
export type ConnectorVerb = "read" | "draft" | "send" | "modify" | "delete";

const VERB_WORDS: ReadonlyArray<readonly [ConnectorVerb, readonly string[]]> = [
  ["delete", ["DELETE", "REMOVE", "TRASH", "PURGE", "DESTROY"]],
  ["modify", ["UPDATE", "EDIT", "MODIFY", "PATCH", "SET", "RENAME", "MOVE", "TAG", "MARK", "UPLOAD", "ASSIGN", "APPROVE", "REJECT", "ARCHIVE", "PIN", "UNPIN", "STAR", "LABEL", "ENABLE", "DISABLE", "TOGGLE", "CANCEL", "CLOSE", "COMPLETE", "TRANSFER", "INSERT"]],
  ["send", ["SEND", "REPLY", "FORWARD", "PUBLISH", "POST", "SHARE", "NOTIFY", "INVITE", "MENTION", "COMMENT", "MESSAGE", "TWEET", "EMAIL", "MAIL", "CALL", "SMS", "TEXT"]],
  ["draft", ["CREATE", "ADD", "NEW", "DRAFT", "COMPOSE", "GENERATE", "WRITE", "MAKE", "BUILD"]],
  ["read", ["READ", "LIST", "GET", "SEARCH", "FIND", "FETCH", "QUERY", "SHOW", "VIEW", "RETRIEVE", "LOOKUP", "CHECK", "DESCRIBE", "BROWSE", "DOWNLOAD", "STATS"]],
];

/** Classify one Composio tool name into a verb class, or null when no
 * class claims it. A name like GMAIL_CREATE_AND_SEND still sends, so the
 * more-privileged class wins regardless of word order. */
export function classifyConnectorTool(name: string): ConnectorVerb | null {
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) return null;
  const words = name.split("_");
  for (const [verb, markers] of VERB_WORDS) {
    if (words.some((word) => markers.includes(word))) return verb;
  }
  return null;
}

/** Recognize the grant shape this build writes. A future server may widen
 * it; the renderer must render those grants read-only, never round-trip a
 * guess through a PATCH. */
export function isConnectorToolGrantShape(value: unknown): value is ConnectorToolGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tools = (value as { tools?: unknown }).tools;
  if (tools === "*") return true;
  return Array.isArray(tools)
    && tools.length > 0
    && tools.every((tool): tool is string => typeof tool === "string" && CONNECTOR_TOOL_NAME_PATTERN.test(tool));
}

/** Whether a whole connectorTools record can be safely edited here. */
export function isConnectorToolsRecordShape(value: unknown): value is Record<string, ConnectorToolGrant> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((grant) => isConnectorToolGrantShape(grant));
}

export type ConnectorAccessLevel = "all" | "partial" | "none";

/** One service's access as the UI should describe it. `editable` is false
 * when the record carries a shape this build does not recognize — the
 * summary still renders, the editor does not offer writes that could
 * destroy fields a newer server understands. */
export interface ConnectorServiceAccess {
  level: ConnectorAccessLevel;
  /** Granted tool count for "partial"; 0 otherwise. */
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
  // A wildcard still rides the record-level editable flag: inside a record
  // this build cannot fully read, the editor must not offer writes that
  // withServiceGrant would silently drop.
  if (grant.tools === "*") return { level: "all", count: 0, editable };
  return { level: "partial", count: grant.tools.length, editable };
}

/** The Connected apps card headline state: off beats everything, an absent
 * record is the legacy all-tools default, an explicit record — even one of
 * all-`*` services — reads as a tailored grant set. */
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

/** The next connectorTools value for one service edit. `tools` sets the
 * service's grant; `null` removes the service from the record (an emptied
 * record stays as the explicit no-tools `{}`). Returns undefined when the
 * current record is not editable — callers drop the edit instead. */
export function withServiceGrant(
  current: unknown,
  slug: string,
  next: { tools: "*" | string[] } | null,
): Record<string, ConnectorToolGrant> | undefined {
  if (current !== undefined && current !== null && !isConnectorToolsRecordShape(current)) return undefined;
  const record: Record<string, ConnectorToolGrant> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, ConnectorToolGrant>) }
      : {};
  if (next === null) delete record[slug];
  else record[slug] = { tools: next.tools };
  return record;
}

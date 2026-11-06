// OpenConnector action ids ("github.get_current_user") speak on the connector surface only as the
// upper-snake tool names the rest of this repo already enforces grants and scopes on
// ("GITHUB_GET_CURRENT_USER"), so one mapping serves the picker, the approval cards and the relay.
import { CONNECTOR_TOOL_NAME_PATTERN } from "../../../shared/wire.ts";

export const TOOL_DESCRIPTION_MAX = 240;

const ACTION_SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTION_NAME = /^[a-z0-9][a-z0-9_-]{0,120}$/;

export interface ConnectorToolForAction {
  /** lower-case service id, the toolkit slug grants and scopes key on. */
  service: string;
  /** upper-snake connector tool name, CONNECTOR_TOOL_NAME_PATTERN-compliant. */
  name: string;
}

/** "github.get_current_user" → { service: "github", name: "GITHUB_GET_CURRENT_USER" }. Anything the
 * pattern would reject (bad service, empty action, over-long name) maps to null, never a partial name. */
export function connectorToolForAction(actionId: string): ConnectorToolForAction | null {
  const trimmed = actionId.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  const service = trimmed.slice(0, dot).toLowerCase();
  const action = trimmed.slice(dot + 1);
  if (!ACTION_SERVICE.test(service) || !ACTION_NAME.test(action)) return null;
  const name = `${service.toUpperCase()}_${action.toUpperCase()}`;
  return CONNECTOR_TOOL_NAME_PATTERN.test(name) ? { service, name } : null;
}

/** The inverse: which action id a granted tool name calls. Services with underscores (google_calendar)
 * need the real service slugs as candidates so the longest match wins, exactly like Composio's. */
export function actionForConnectorTool(name: string, candidates: readonly string[]): string | null {
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) return null;
  let match: string | null = null;
  for (const candidate of candidates) {
    if (name.startsWith(candidate.toUpperCase() + "_") && (match === null || candidate.length > match.length)) {
      match = candidate;
    }
  }
  if (match === null) {
    const cut = name.indexOf("_");
    if (cut <= 0) return null;
    match = name.slice(0, cut).toLowerCase();
  }
  return `${match}.${name.slice(match.length + 1).toLowerCase()}`;
}

/** The grant-editor listing row for one action. */
export function connectorToolListingForAction(action: { id: string; description?: unknown }): { service: string; name: string; description?: string } | null {
  const mapped = connectorToolForAction(action.id);
  if (!mapped) return null;
  const description = typeof action.description === "string"
    ? action.description.replace(/\s+/g, " ").trim().slice(0, TOOL_DESCRIPTION_MAX)
    : "";
  return description ? { ...mapped, description } : mapped;
}

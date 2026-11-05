import { t } from "./i18n";
import type { McpChangeRequest } from "../../shared/mcp-request";

const ACTION_KEY = {
  enable: "mcp.turnOn",
  update: "mcp.request.change",
  remove: "mcp.request.remove",
} as const;

export function mcpRequestActionLabel(action: McpChangeRequest["action"]): string {
  return t(ACTION_KEY[action]);
}

// One handler per tool name, assembled from the domain modules beside this
// file. mcp-server.ts keeps the matching TOOLS advertisement list; the
// ToolName type below keys both records, so a list entry without a handler
// fails to typecheck there, and a handler without a list entry fails the
// exhaustiveness check declared beside the list.
import type { ToolHandler } from "./context.ts";
import * as bots from "./bots.ts";
import * as channels from "./channels.ts";
import * as conversations from "./conversations.ts";
import * as models from "./models.ts";
import * as search from "./search.ts";
import * as system from "./system.ts";
import * as tasks from "./tasks.ts";

export const TOOL_HANDLERS = {
  ...system.handlers,
  ...bots.handlers,
  ...channels.handlers,
  ...tasks.handlers,
  ...conversations.handlers,
  ...models.handlers,
  ...search.handlers,
} satisfies Record<string, ToolHandler>;

/** Every tool name the MCP server can dispatch. */
export type ToolName = keyof typeof TOOL_HANDLERS;

// One handler per tool name, assembled from the domain modules beside this
// file. agents-proxy.ts keeps the matching name→schema table; the ToolName
// type below keys both records, so a table entry without a handler fails to
// typecheck there, and a handler without a table entry fails the
// exhaustiveness check declared beside the table.
import type { ToolHandler } from "./context.ts";
import * as bots from "./bots.ts";
import * as computers from "./computers.ts";
import * as credentials from "./credentials.ts";
import * as memory from "./memory.ts";
import * as rooms from "./rooms.ts";
import * as routines from "./routines.ts";
import * as skills from "./skills.ts";
import * as teams from "./teams.ts";
import * as threads from "./threads.ts";

export const TOOL_HANDLERS = {
  ...computers.handlers,
  ...rooms.handlers,
  ...bots.handlers,
  ...threads.handlers,
  ...teams.handlers,
  ...routines.handlers,
  ...memory.handlers,
  ...skills.handlers,
  ...credentials.handlers,
} satisfies Record<string, ToolHandler>;

/** Every tool name the proxy can dispatch. */
export type ToolName = keyof typeof TOOL_HANDLERS;

/** The shape of one entry in the tool table that advertises these tools. */
export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Claude Code 2.1.285 and later keep a tool behind its ToolSearch when the server lists it with
// `_meta["anthropic/alwaysLoad"]: false`, even though its --mcp-config server is `alwaysLoad`; the server-level flag
// still makes the CLI connect the server before the first request (checked on 2.1.321). An older CLI ignores the mark
// and loads every tool, and with tool search off every tool loads whatever the mark says.

/** The proxy's switch, set by the Claude driver: "1" marks every tool outside claudeAlwaysLoaded deferred. */
export const DEFER_TOOLS_ENV = "OMB_AGENTS_DEFER_TOOLS";

/** Sent whole on every Claude request: tools most turns call, or must call without a search first. list_bots stays
 * because a deferred list_bots loses to Claude Code's own ListAgents when the bot inherits this machine's setup. Tools a
 * turn calls only now and then (memory_update, attach_file, send_voice_note) are deferred: the prompt names them, and
 * one ToolSearch loads one when it is needed. */
export const CLAUDE_ALWAYS_LOADED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "tool_result_read",
  "list_bots",
  "message_person",
  "create_options_card",
]);

/** A Chief hands work out on most turns: a deferred coordinate_bots costs every hand-off a ToolSearch request first. */
export const CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES: ReadonlySet<string> = new Set([...CLAUDE_ALWAYS_LOADED_TOOL_NAMES, "coordinate_bots"]);

export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** The tools a Claude turn of this bot sends whole. */
export const claudeAlwaysLoaded = (chief: boolean): ReadonlySet<string> => chief ? CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES : CLAUDE_ALWAYS_LOADED_TOOL_NAMES;

/** `tools` with every tool outside the always-loaded set marked deferred. */
export function withDeferMarks<Tool extends { name: string; _meta?: Record<string, unknown> }>(tools: readonly Tool[], chief = false): Tool[] {
  const loaded = claudeAlwaysLoaded(chief);
  return tools.map((tool) => loaded.has(tool.name)
    ? tool
    : { ...tool, _meta: { ...tool._meta, [ALWAYS_LOAD_META]: false } });
}

/** What Claude Code 2.1.321 sends up front for these tools/list entries: a loaded tool whole, as
 * {name, description, input_schema}, and a deferred one as its name on a line of a reminder. */
export function claudeUpFrontBytes(tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown; _meta?: Record<string, unknown> }>, prefix = "mcp__agents__") {
  let whole = 0;
  let deferred = 0;
  for (const tool of tools) {
    const name = `${prefix}${tool.name}`;
    if (tool._meta?.[ALWAYS_LOAD_META] === false) deferred += Buffer.byteLength(`${name}\n`, "utf8");
    else whole += Buffer.byteLength(JSON.stringify({ name, description: tool.description, input_schema: tool.inputSchema }), "utf8");
  }
  return { whole, deferred, total: whole + deferred };
}

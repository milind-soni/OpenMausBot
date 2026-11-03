/** The longest an engine waits on one agents tool call: a lent computer's command of up to 900 seconds, plus the time
 * its result takes to come back. Codex CLI otherwise ends an MCP tool call after the server's tool_timeout_sec, 60 by
 * default in its config docs. */
export const AGENTS_TOOL_TIMEOUT_SECONDS = 960;

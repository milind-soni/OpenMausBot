/** The reviewed local reads of the built-in agents MCP. Names, prefixes or third-party annotations alone must never grant
 * read access; session recall keeps its own-bot scope. */
export const READ_ONLY_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_bots",
  "list_team_setup",
  "list_shared_computers",
  "list_rooms",
  "list_threads",
  "assignment_status",
  "session_search",
  "session_read",
  "tool_result_read",
  "list_triggers",
  "list_trigger_events",
  "skills_list",
]);

export const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const);

export function isReadOnlyAgentTool(name: string): boolean {
  return READ_ONLY_AGENT_TOOL_NAMES.has(name);
}

export function agentToolAnnotations(name: string): typeof READ_ONLY_ANNOTATIONS | undefined {
  return isReadOnlyAgentTool(name) ? READ_ONLY_ANNOTATIONS : undefined;
}

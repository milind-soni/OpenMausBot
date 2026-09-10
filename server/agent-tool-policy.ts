/** Reviewed local reads exposed by the built-in agents MCP integration.
 * This exact catalog supplies MCP tool metadata only; names, prefixes, or
 * third-party annotations alone must never grant read access.
 * Session recall keeps its own-bot scope and may record a deduplicated access
 * disclosure in a room; it does not edit recalled messages or launch work.
 */
export const READ_ONLY_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_bots",
  "list_rooms",
  "list_threads",
  "check_delegation",
  "wait_delegation",
  "session_search",
  "session_read",
  "list_routines",
  "skills_list",
]);

const READ_ONLY_ANNOTATIONS = Object.freeze({
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

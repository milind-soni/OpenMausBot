import { describe, expect, it } from "vitest";
import { agentToolAnnotations, isReadOnlyAgentTool, READ_ONLY_AGENT_TOOL_NAMES } from "./agent-tool-policy.ts";

describe("built-in agent tool read policy", () => {
  it("includes only the reviewed local reads", () => {
    expect([...READ_ONLY_AGENT_TOOL_NAMES]).toEqual([
      "list_bots",
      "list_team_setup",
      "list_shared_computers",
      "list_rooms",
      "list_threads",
      "assignment_status",
      "session_search",
      "tool_result_read",
      "trigger_info",
      "list_waits",
      "skills_list",
      "list_unread_notifications",
    ]);
    for (const name of READ_ONLY_AGENT_TOOL_NAMES) {
      expect(isReadOnlyAgentTool(name)).toBe(true);
      expect(agentToolAnnotations(name)).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it.each([
    "shared_computer", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation", "start_thread", "close_thread", "post_to_room",
    // These post into the chat: never read-only.
    "attach_file", "show_widget", "update_widget", "show_html", "update_html",
    "create_bot", "request_credential", "request_sign_in", "memory_update", "trigger", "delete_trigger", "create_trigger",
    "manage_trigger", "memory_log", "manage_room", "create_room", "wait_until", "cancel_wait", "propose_profile", "skill_manage",
    // Read through their action tools, never as read-only names of their own.
    "list_triggers", "list_trigger_events", "session_read",
    "propose_team_setup", "propose_bot_deletion",
    "list_secrets", "read_credentials", "list_bots_and_delete", "unknown", "",
    "mcp__agents__list_bots", "agents.list_bots", "LIST_BOTS", " list_bots",
  ])("does not infer read access for %s", (name) => {
    expect(isReadOnlyAgentTool(name)).toBe(false);
    expect(agentToolAnnotations(name)).toBeUndefined();
  });
});

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
      "check_delegation",
      "wait_delegation",
      "session_search",
      "session_read",
      "list_routines",
      "skills_list",
      // The durable task board's read half. task_list returns board rows and
      // mutates nothing; its write sibling task_create is pinned as a
      // non-read below, which is the property that actually matters.
      "task_list",
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
    "shared_computer", "ask_bot", "delegate_bot", "start_thread", "close_thread", "post_to_room",
    "create_bot", "request_credential", "memory_update", "propose_routine",
    "propose_routine_action", "propose_profile", "skill_manage",
    "propose_team_setup", "propose_bot_deletion", "task_create",
    "list_secrets", "read_credentials", "list_bots_and_delete", "unknown", "",
    "mcp__agents__list_bots", "agents.list_bots", "LIST_BOTS", " list_bots",
  ])("does not infer read access for %s", (name) => {
    expect(isReadOnlyAgentTool(name)).toBe(false);
    expect(agentToolAnnotations(name)).toBeUndefined();
  });
});

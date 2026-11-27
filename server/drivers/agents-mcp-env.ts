import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { TOOL_LIMIT_ENV } from "../tool-count-limit.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "../tool-schema-profile.ts";
import { DEFER_TOOLS_ENV } from "./agents-claude-defer.ts";

/** The settings the harness gives the agents MCP server, and the only ones a request may carry over HTTP. */
export const AGENTS_MCP_ENV = ["OMB_BOT_ID", "OMB_THREAD_ID", "OMB_EXTERNAL_RUNTIME", "OMB_CHIEF_OF_STAFF",
  "OMB_SKILL_AUTHORING_ENABLED", "OMB_SKILL_BURGER", "OMB_MEMORY_ENABLED", "OMB_SHARED_COMPUTERS_ENABLED", "OMB_CLOUD_HOME", "OMB_VOICE_NOTES",
  "OMB_X_RESEARCH", "OMB_RESEARCH", "OMB_TEAM_PEOPLE", "OMB_TEAM_BOARD", "OMB_MAUSBOT", "OMB_COMPUTER_SELECTION", "OMB_ROOM", "OMB_IMAGE_GENERATION", "OMB_MEETINGS", "OMB_APP_HOSTING", "OMB_TOOLS_OFF", "OMB_LOCAL_VM", TOOL_BRIDGE_ENV, TOOL_LIMIT_ENV,
  // The engine's schema profile: the URL form carries it as the stdio proxy's environment does.
  TOOL_SCHEMA_PROFILE_ENV,
  // Claude's deferred catalog: the URL form carries it as the stdio proxy's environment does.
  DEFER_TOOLS_ENV] as const;

// Security invariant: a confined turn acts on words nobody here wrote, and every engine pre-allows OpenMausBot's own tools
// (only the harness can tell them apart). So of OpenMausBot's own routes it reaches only what this list names, and a route
// nobody listed is refused:
// - reads of this conversation's own work and what the bot may see;
// - what waits on a person's card (asks, proposed changes, a tool the engine asks about first);
// - handing work on, which carries the lineage (server/host/outside-lineage.ts).
const EXACT: ReadonlySet<string> = new Set([
  "POST /api/internal/hook",
  "POST /api/internal/tool-timing",
  "GET /api/internal/tool-result",
  "POST /api/internal/tool-result",
  "POST /api/internal/options-card",
  "POST /api/internal/escalate",
  // In its own conversation, where a place's inbox labels a guest's words and keeps them from the owner's; a team refuses it.
  "POST /api/internal/people/message",
  "POST /api/internal/attach-file",
  "POST /api/internal/voice-note",
  "GET /api/internal/agents",
  "GET /api/internal/rooms",
  "GET /api/internal/room-targets",
  "GET /api/internal/threads",
  "POST /api/internal/threads",
  "GET /api/internal/assignment-status",
  "GET /api/internal/session-search",
  "GET /api/internal/session-read",
  "GET /api/internal/skills",
  "GET /api/internal/team-setup-catalog",
  "GET /api/internal/team-library",
  "GET /api/internal/engine-limits",
  "GET /api/internal/triggers",
  "GET /api/internal/trigger-events",
  "GET /api/internal/waits",
  "POST /api/internal/waits",
  "POST /api/internal/waits/cancel",
  "POST /api/internal/helpers/decide",
  "POST /api/internal/helpers/extract",
  // Each decides for itself, in plain words: what a confined turn may do there waits on a card, stays confined or is refused.
  "POST /api/internal/coordinate-bots",
  "POST /api/internal/post-to-room",
  "POST /api/internal/retry-thread",
  "POST /api/internal/trigger-requests",
  "POST /api/internal/manage-room",
  // A meeting's questions and notes come from outside by nature; a chat post still waits on the sending rule.
  "POST /api/internal/meetings/join",
  "POST /api/internal/meetings/status",
  "POST /api/internal/meetings/chat",
  "POST /api/internal/meetings/leave",
  "POST /api/internal/meetings/notes",
  "POST /api/internal/memory",
  "POST /api/internal/memory/log",
  "POST /api/internal/team-memory",
  "POST /api/internal/profile-requests",
  "POST /api/internal/model-requests",
  "POST /api/internal/team-setup-requests",
  "POST /api/internal/bot-deletion-requests",
  "POST /api/internal/create-bot",
  "POST /api/internal/skills/stage",
  "POST /api/internal/mcp-servers",
  "GET /api/internal/mcp-servers",
  "GET /api/internal/shared-computers",
  "POST /api/internal/shared-computers",
  // A tool on one of these reaches here only after the engine asked a person: none is pre-allowed in a confined turn.
  "POST /api/internal/browser/mcp",
  "POST /api/internal/computer/mcp",
  "GET /api/internal/computer-control",
  "POST /api/internal/computer-control",
  "POST /api/internal/computer/journal",
  "POST /api/internal/connectors/mcp",
  "POST /api/internal/connectors/request",
  "POST /api/internal/data/mcp",
  "POST /api/internal/email/mcp",
]);
const ASKED_MCP_PREFIX = "/api/internal/mcp-http/";

export const OUTSIDE_REFUSAL = "This work came in from outside, so it can't do that here. Finish what you can in this conversation and say plainly what a person would need to do.";

export function outsideRouteRefused(method: string, path: string): boolean {
  return !EXACT.has(`${method.toUpperCase()} ${path}`) && !path.startsWith(ASKED_MCP_PREFIX);
}

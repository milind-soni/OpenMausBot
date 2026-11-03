// Security invariant: a Bot API turn acts on a stranger's words with a key anyone may have copied, so everything is
// allow-only, for the turn and for whatever comes after it in that conversation:
// - the engine runs confined (no shell, no reads outside the thread's own empty folder) and at Ask, whatever the bot's
//   level, with no saved allowance; an engine that cannot be confined doesn't take the call;
// - of a turn's tools only the engine's hooks are mounted: no computer, browser, phone, connected apps, MCP servers, data
//   or OpenMausBot's own tools, so it can start, schedule, change or remember nothing;
// - of OpenMausBot's own routes it may reach only the engine's hooks and the paging of its own long results;
// - its system prompt keeps the bot's standing instructions, its saved memory and the rules for reading who sent a line,
//   and nothing about the person or their work;
// - what it says never reaches the person's other conversations.
export const BOT_API_TOOLS: ReadonlySet<string> = new Set(["hooks"]);
export const BOT_API_PARTS: ReadonlySet<string> = new Set(["memory", "webhook", "coordination"]);
const ROUTES: ReadonlySet<string> = new Set([
  "GET /api/internal/tool-result",
  "POST /api/internal/tool-result",
  "POST /api/internal/hook",
]);

export const BOT_API_REFUSAL = "This call came in through the Bot API, so it can only answer from what this bot already knows.";

export function botApiRouteRefused(method: string, path: string): boolean {
  return !ROUTES.has(`${method.toUpperCase()} ${path}`);
}

// The words a person reads when a step on one of their MCP servers fails: which server, why, and what to do. Only failures
// worded by an MCP client or by this server's own proxies are recognised. A tool's own error ("thread not found") is that
// tool's answer rather than the server failing, so it gets no line and its output speaks for itself.
import { serverLine, type ServerLineKey } from "./server-lines.ts";

export type McpFailureKind = "sign-in" | "refused" | "not-found" | "timeout" | "cant-connect";

const KIND_LINE: Readonly<Record<McpFailureKind, ServerLineKey>> = {
  "sign-in": "server.mcp.problem.signIn",
  refused: "server.mcp.problem.refused",
  "not-found": "server.mcp.problem.notFound",
  timeout: "server.mcp.problem.timeout",
  "cant-connect": "server.mcp.problem.cantConnect",
};

const NAMED = String.raw`(?:The )?MCP server "[^"]+"`;
const FAILURES: ReadonlyArray<readonly [RegExp, McpFailureKind]> = [
  // The credential broker's own answers (bot-box/broker-mcp-refusal.ts).
  [new RegExp(`^${NAMED} needs a sign-in\\b`), "sign-in"],
  [new RegExp(`^${NAMED} refused the sign-in or key\\b`), "refused"],
  // Claude Code's words for a server it can't use.
  [new RegExp(`^${NAMED} needs (?:authentication|additional permissions)\\b`), "sign-in"],
  [new RegExp(`^${NAMED} rejected\\b`), "refused"],
  [new RegExp(`^${NAMED} (?:is not connected|session expired)\\b`), "cant-connect"],
  [/^Dynamic Client Registration rejected\b/, "sign-in"],
  [/^HTTP 401 dialing /, "sign-in"],
  [/^HTTP 403 dialing /, "refused"],
  [/^HTTP 404 dialing /, "not-found"],
  [/^HTTP (?:408|504) dialing /, "timeout"],
  // Any other "<cause> dialing <address>": Claude Code hides the cause when the address holds a token.
  [/^\S+(?: \d{3})? dialing /, "cant-connect"],
  [/^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/, "cant-connect"],
  [/^ETIMEDOUT\b/, "timeout"],
  // The remote proxy's words (mcp-remote-proxy.ts) and the MCP SDK's.
  [/^This MCP server refused (?:its credentials|the request)\b/, "refused"],
  [/^This MCP server's address was not found\b/, "not-found"],
  [/^Could not reach this MCP server\b/, "cant-connect"],
  [/^Request timed out\b/, "timeout"],
  [/^Connection closed\b/, "cant-connect"],
  // The chat runtime's MCP client (drivers/chat-mcp-tools.ts).
  [/^MCP (?:request|startup) timed out\b/, "timeout"],
  [/^MCP (?:server could not start|server exited|server input closed|session closed)\b/, "cant-connect"],
];

/** What the engine said, out of the JSON a step's output may be: the chat runtime's `{ ok, result }`, or MCP's own content list. */
function reportedText(output: string): string {
  try {
    const parsed = JSON.parse(output) as { result?: unknown } | Array<{ text?: unknown }>;
    const text = Array.isArray(parsed) ? parsed[0]?.text : parsed?.result;
    return typeof text === "string" ? text : output;
  } catch {
    return output;
  }
}

/** Why an MCP step failed, from the first line of what the engine reported; null when it is the tool's own error. */
export function mcpFailureKind(output: string): McpFailureKind | null {
  const first = reportedText(output).replace(/^\s*<tool_use_error>\s*/, "").split("\n", 1)[0]!.trim().replace(/^(?:Error: )?(?:MCP error -?\d+: )/, "");
  return FAILURES.find(([pattern]) => pattern.test(first))?.[1] ?? null;
}

/** The configured MCP server a step's tool belongs to, as each engine spells it: after `mcp__` with two underscores before
 * the tool (Claude Code), two underscores alone (ACP), one (the chat runtime, Pi), or a dot. The longest name that fits wins. */
export function mcpServerOfTool(tool: string, servers: readonly string[]): string | undefined {
  const name = tool.toLowerCase();
  return [...servers].sort((a, b) => b.length - a.length).find((server) => {
    const own = server.toLowerCase(), flat = own.replace(/[^a-z0-9_]+/g, "_");
    return name.startsWith(`mcp__${own}__`) || name.startsWith(`${own}__`) || name.startsWith(`${own}.`) || name.startsWith(`${flat}_`);
  });
}

/** The `problem` line for a finished step: only a failed step on a configured MCP server whose failure is recognised has one. */
export function mcpToolProblem(tool: string, ok: boolean | undefined, output: string | undefined, servers: readonly string[], language?: string): { problem?: string } {
  if (ok !== false || !output) return {};
  const server = mcpServerOfTool(tool, servers);
  const kind = server ? mcpFailureKind(output) : null;
  return server && kind ? { problem: serverLine(language, KIND_LINE[kind], { name: server }) } : {};
}

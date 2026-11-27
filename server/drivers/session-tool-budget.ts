// One session's MCP tool budget shared out among every server in it, not only OpenMausBot's own: connected apps and the
// person's own servers reach the engine through OpenMausBot's relays, and each relay fits what it lists into the share
// it is given here. Their lists are known only once they answer, so each relay records the list it relayed and the next
// session sizes its share by that record. Until there is one, a relayed server is set aside what the known lists leave
// at their shortest: description text is lost, not tools.
// Measured on the native Antigravity CLI 1.5.18 (google-antigravity/antigravity-cli#1530): past the budget it leaves out
// the session's largest tools first, whichever server they come from, so to a person the cut looks like a size limit for
// one tool; and it refuses any tool whose `mcp_<server>_<tool>` is not 1 to 64 of [a-zA-Z0-9_-], whatever its size.
import { createHash } from "node:crypto";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { toolListFloorBytes, type ListedTool } from "../tool-list-budget.ts";
import { readRecordedToolList, TOOL_LIST_RECORD_ENV, TOOL_LIST_SHARE_ENV } from "../tool-list-share.ts";
import { ownServerToolList, sessionToolShares, withOwnShare, withSessionToolShares } from "./own-mcp-session-budget.ts";
import type { AcpMcpServer } from "./turn-mcp.ts";

/** "0" counts only OpenMausBot's own servers in the budget, and leaves every other server's list as it is. */
export const SESSION_TOOL_BUDGET_ENV = "OMB_SESSION_TOOL_BUDGET";

/** The least set aside for a server whose list is not known yet. */
export const UNKNOWN_LIST_RESERVE = 8_000;

const RELAY = /(?:^|[\\/])(?:connector-proxy|mcp-gate|mcp-remote-proxy|local-computer-proxy)\.[jt]s$/;
/** The tool names the native CLI accepts, as `mcp_<server>_<tool>`. */
const CLI_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

type Env = Array<{ name: string; value: string }>;
const valueOf = (env: Env, name: string) => env.find((entry) => entry.name === name)?.value;

export interface SessionBudgetOptions {
  env?: NodeJS.ProcessEnv;
  /** Where relays record the lists they relay. */
  recordsDir?: string;
  log?: (line: string) => void;
}

export function toolListRecordPath(recordsDir: string, botId: string, server: string): string {
  return join(recordsDir, `${createHash("sha256").update(`${botId}\0${server}`).digest("hex").slice(0, 40)}.json`);
}

/** The tools of `tools` the native CLI refuses for their name under server `server`. */
export function cliRefusedToolNames(server: string, tools: readonly ListedTool[]): string[] {
  return tools.filter((tool) => !CLI_TOOL_NAME.test(`mcp_${server}_${tool.name}`)).map((tool) => tool.name);
}

/** One of OpenMausBot's own servers behind a tool-selection gate: its list, which the gate narrows. */
function gatedOwnList(server: AcpMcpServer & { env: Env }): readonly ListedTool[] | null {
  try {
    const upstream = JSON.parse(valueOf(server.env, "OMB_GATE_UPSTREAM") ?? "") as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof upstream.command !== "string" || !Array.isArray(upstream.args)) return null;
    const env = upstream.env && typeof upstream.env === "object" ? Object.entries(upstream.env as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) })) : [];
    return ownServerToolList({ name: server.name, command: upstream.command, args: upstream.args.map(String), env });
  } catch {
    return null;
  }
}

type Planned =
  | { server: AcpMcpServer; kind: "own"; tools: readonly ListedTool[] }
  | { server: AcpMcpServer & { env: Env }; kind: "relay"; tools: readonly ListedTool[] | number; record: string }
  | { server: AcpMcpServer; kind: "other" };

/** `servers` with every server the session can size given its share of `budget`: OpenMausBot's own by their
 * OMB_TOOL_SCHEMA_PROFILE, relayed ones by OMB_TOOL_LIST_SHARE (and OMB_TOOL_LIST_RECORD, where they record their list). */
export function withSessionToolBudget(servers: AcpMcpServer[], budget: number, options: SessionBudgetOptions = {}): AcpMcpServer[] {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.warn(line));
  if (env[SESSION_TOOL_BUDGET_ENV] === "0") return withSessionToolShares(servers, budget, log);
  const recordsDir = options.recordsDir ?? join(DATA_DIR, "tool-list-records");
  const botId = servers.map((server) => ("command" in server ? valueOf(server.env, "OMB_BOT_ID") : undefined)).find(Boolean) ?? "";
  const planned: Planned[] = servers.map((server) => {
    const own = ownServerToolList(server);
    if (own) return { server, kind: "own", tools: own };
    if (!("command" in server) || !server.args.some((arg) => RELAY.test(arg))) return { server, kind: "other" };
    const record = toolListRecordPath(recordsDir, botId, server.name);
    return { server, kind: "relay", tools: readRecordedToolList(record) ?? gatedOwnList(server) ?? UNKNOWN_LIST_RESERVE, record };
  });
  const unknown = planned.filter((entry) => entry.kind === "relay" && typeof entry.tools === "number");
  if (unknown.length) {
    const known = planned.reduce((sum, entry) => sum + (entry.kind === "other" ? UNKNOWN_LIST_RESERVE : typeof entry.tools === "number" ? 0 : toolListFloorBytes(entry.tools)), 0);
    const reserve = Math.max(UNKNOWN_LIST_RESERVE, Math.floor((budget - known) / unknown.length));
    for (const entry of unknown) if (entry.kind === "relay") entry.tools = reserve;
  }
  if (!planned.some((entry) => entry.kind !== "other")) return servers;
  const others = planned.filter((entry) => entry.kind === "other");
  const sized = planned.filter((entry) => entry.kind !== "other");
  const lists = [...sized.map((entry) => entry.tools), ...others.map(() => UNKNOWN_LIST_RESERVE)];
  const { shares, bytes, fits } = sessionToolShares(lists, budget);
  if (!fits) {
    log(`[mcp] this session's MCP tools (${sized.map((entry) => entry.server.name).join(", ")}) come to ${bytes} bytes at their shortest, ${bytes - budget} over the ${budget}-byte tool budget; the engine leaves out its largest tools first`);
  }
  if (others.length) log(`[mcp] ${others.map((entry) => entry.server.name).join(", ")}: not relayed by OpenMausBot, so not fitted to the session's tool budget (${UNKNOWN_LIST_RESERVE} bytes set aside each)`);
  for (const entry of sized) {
    const refused = typeof entry.tools === "number" ? [] : cliRefusedToolNames(entry.server.name, entry.tools);
    if (refused.length) log(`[mcp] ${entry.server.name}: the engine refuses ${refused.length} tool(s) whose name as mcp_${entry.server.name}_<tool> is over 64 characters or not [a-zA-Z0-9_-]: ${refused.join(", ")}`);
  }
  const shareOf = new Map(sized.map((entry, index) => [entry.server, shares[index]!]));
  return planned.map((entry) => {
    const share = shareOf.get(entry.server);
    if (share === undefined || entry.kind === "other") return entry.server;
    if (entry.kind === "own") return withOwnShare(entry.server, share);
    const kept = entry.server.env.filter(({ name }) => name !== TOOL_LIST_SHARE_ENV && name !== TOOL_LIST_RECORD_ENV);
    return { ...entry.server, env: [...kept, { name: TOOL_LIST_SHARE_ENV, value: String(share) }, { name: TOOL_LIST_RECORD_ENV, value: entry.record }] };
  });
}

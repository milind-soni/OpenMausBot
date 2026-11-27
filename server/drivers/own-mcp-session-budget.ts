// OpenMausBot's own servers in one session's MCP tool budget: the least cut that brings every sized list under the
// budget together is found when the session's servers are sent, and each own server gets what its list comes to at that
// cut plus its part of what is left, as its OMB_TOOL_SCHEMA_PROFILE. Each server then fits the list it really serves into
// that share: a browser engine listing more than the estimate here only cuts its own. The agents list is sized exactly;
// the others by the catalogs their endpoints serve (email and phone show fewer when the bot may use fewer, and
// agent-browser's own list replaces the browser catalog).
import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { CLOUD_COMPUTER_TOOLS } from "../cloud-computer-tools.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { EMAIL_TOOLS } from "../email/tools.ts";
import { PHONE_TOOLS } from "../phones/tools.ts";
import type { HarnessMcpKind } from "../harness-mcp-request.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "../tool-schema-profile.ts";
import {
  definitionListBytes, descriptionLevelFor, toolListShareProfile, withCompactSchemas, withDescriptionLevel, type ListedTool,
} from "../tool-list-budget.ts";
import { agentsToolList } from "./agents-mcp.ts";
import { ownMcpOverHttp, type AcpMcpServer } from "./turn-mcp.ts";

type OwnKind = "agents" | HarnessMcpKind;

const CATALOGS: Record<HarnessMcpKind, readonly ListedTool[]> = {
  browser: BROWSER_TOOLS, data: DATA_TOOLS as readonly ListedTool[], computer: CLOUD_COMPUTER_TOOLS as readonly ListedTool[],
  email: EMAIL_TOOLS as readonly ListedTool[], device: PHONE_TOOLS as readonly ListedTool[],
};

export interface SessionShares {
  /** Each list's share of the budget, in bytes, in the order given. */
  shares: number[];
  /** What the lists come to together at the cut found, and whether that is within the budget. */
  bytes: number;
  fits: boolean;
}

/** Shares of `budget` for `lists`: each list's bytes at the least cut that fits them all, plus its part of the rest. A
 * number stands for a list known only by the bytes set aside for it, which no cut changes. With no cut that fits, each
 * gets its part of the budget by its size at its shortest, and fits what it can. */
export function sessionToolShares(lists: ReadonlyArray<readonly ListedTool[] | number>, budget: number): SessionShares {
  const reserved = lists.reduce<number>((sum, list) => sum + (typeof list === "number" ? list : 0), 0);
  const compacted = lists.map((tools) => (typeof tools === "number" ? [] : withCompactSchemas(tools)));
  const { level, fits } = descriptionLevelFor(compacted.flat(), budget - reserved);
  const sizes = lists.map((list, index) => (typeof list === "number" ? list : definitionListBytes(withDescriptionLevel(compacted[index]!, level))));
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  if (bytes === 0) return { shares: sizes, bytes, fits };
  const room = fits ? budget - bytes : budget;
  const shares = sizes.map((size) => Math.floor((fits ? size : 0) + room * (size / bytes)));
  return { shares, bytes, fits };
}

const pairsToRecord = (env: Array<{ name: string; value: string }>) => Object.fromEntries(env.map(({ name, value }) => [name, value]));

function ownKind(server: AcpMcpServer): { kind: OwnKind; env: Record<string, string> } | null {
  if (!("command" in server)) return null;
  const env = pairsToRecord(server.env);
  const url = ownMcpOverHttp({ ...server, env })?.url;
  const kind = url?.slice(url.lastIndexOf("/") + 1);
  return kind === "agents" || (kind !== undefined && kind in CATALOGS) ? { kind: kind as OwnKind, env } : null;
}

/** The tools one of OpenMausBot's own servers lists before any share; null for any other server. */
export function ownServerToolList(server: AcpMcpServer): readonly ListedTool[] | null {
  const own = ownKind(server);
  if (!own) return null;
  return own.kind === "agents" ? agentsToolList({ ...own.env, [TOOL_SCHEMA_PROFILE_ENV]: undefined }).listed as ListedTool[] : CATALOGS[own.kind];
}

/** One of OpenMausBot's own stdio servers with `share` as its OMB_TOOL_SCHEMA_PROFILE, any earlier profile replaced. */
export function withOwnShare(server: AcpMcpServer, share: number): AcpMcpServer {
  if (!("command" in server)) return server;
  const env = server.env.filter(({ name }) => name !== TOOL_SCHEMA_PROFILE_ENV);
  return { ...server, env: [...env, { name: TOOL_SCHEMA_PROFILE_ENV, value: toolListShareProfile(share) }] };
}

/** `servers` with each of OpenMausBot's own servers given its share of `budget`; every other server as it was. */
export function withSessionToolShares(servers: AcpMcpServer[], budget: number, log: (line: string) => void = (line) => console.warn(line)): AcpMcpServer[] {
  const own = servers.map((server) => ({ server, tools: ownServerToolList(server) })).filter((entry) => entry.tools !== null);
  if (!own.length) return servers;
  const { shares, bytes, fits } = sessionToolShares(own.map(({ tools }) => tools!), budget);
  if (!fits) {
    const others = servers.filter((server) => !own.some((entry) => entry.server === server)).map((server) => server.name);
    log(`[mcp] this session's own MCP tools (${own.map(({ server }) => server.name).join(", ")}) come to ${bytes} bytes at their shortest, ${bytes - budget} over the ${budget}-byte tool budget; the engine leaves out its largest tools first${others.length ? ` (${others.join(", ")} not counted)` : ""}`);
  }
  const shareOf = new Map(own.map(({ server }, index) => [server, shares[index]!]));
  return servers.map((server) => {
    const share = shareOf.get(server);
    return share === undefined ? server : withOwnShare(server, share);
  });
}

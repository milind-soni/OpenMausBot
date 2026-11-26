// One session's MCP tool budget shared out among OpenMausBot's own servers in it: the least cut that
// brings all of them under the budget together is found here, when the session's servers are sent, and each server gets
// what its list comes to at that cut plus its part of what is left, as its OMB_TOOL_SCHEMA_PROFILE. Each server then fits
// the list it really serves into that share: a browser engine listing more than the estimate here only cuts its own.
// The agents list is sized exactly; the others by the catalogs their endpoints serve (email and phone show fewer when
// the bot may use fewer, and agent-browser's own list replaces the browser catalog). The person's servers and the
// connected-apps server are not ours to trim and are not sized: their lists are only known once they answer.
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

/** Shares of `budget` for `lists`: each list's bytes at the least cut that fits them all, plus its part of the rest. With
 * no cut that fits, each gets its part of the budget by its size at its shortest, and fits what it can. */
export function sessionToolShares(lists: ReadonlyArray<readonly ListedTool[]>, budget: number): SessionShares {
  const compacted = lists.map((tools) => withCompactSchemas(tools));
  const { level, fits } = descriptionLevelFor(compacted.flat(), budget);
  const sizes = compacted.map((tools) => definitionListBytes(withDescriptionLevel(tools, level)));
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

/** `servers` with each of OpenMausBot's own servers given its share of `budget`; every other server as it was. */
export function withSessionToolShares(servers: AcpMcpServer[], budget: number, log: (line: string) => void = (line) => console.warn(line)): AcpMcpServer[] {
  const own = servers.map((server) => ({ server, own: ownKind(server) })).filter((entry) => entry.own !== null);
  if (!own.length) return servers;
  const lists = own.map(({ own: found }) => (found!.kind === "agents" ? agentsToolList({ ...found!.env, [TOOL_SCHEMA_PROFILE_ENV]: undefined }).listed as ListedTool[] : CATALOGS[found!.kind as HarnessMcpKind]));
  const { shares, bytes, fits } = sessionToolShares(lists, budget);
  if (!fits) {
    const others = servers.filter((server) => !own.some((entry) => entry.server === server)).map((server) => server.name);
    log(`[mcp] this session's own MCP tools (${own.map(({ own: found }) => found!.kind).join(", ")}) come to ${bytes} bytes at their shortest, ${bytes - budget} over the ${budget}-byte tool budget; the engine leaves out its largest tools first${others.length ? ` (${others.join(", ")} not counted)` : ""}`);
  }
  const shareOf = new Map(own.map(({ server }, index) => [server, shares[index]!]));
  return servers.map((server) => {
    const share = shareOf.get(server);
    if (share === undefined || !("command" in server)) return server;
    const env = server.env.filter(({ name }) => name !== TOOL_SCHEMA_PROFILE_ENV);
    return { ...server, env: [...env, { name: TOOL_SCHEMA_PROFILE_ENV, value: toolListShareProfile(share) }] };
  });
}

// One session's MCP tool budget shared out among OpenMausBot's own servers and external proxies (connected apps and
// remote MCP servers): the least cut that brings OpenMausBot's own servers under their budget is found here when the
// session's servers are sent, and each participating server gets its share as OMB_TOOL_SCHEMA_PROFILE.
// When no connected-app or remote-MCP server is present, OpenMausBot's own servers keep 100% of the budget.
import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { CLOUD_COMPUTER_TOOLS } from "../cloud-computer-tools.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { EMAIL_TOOLS } from "../email/tools.ts";
import { PHONE_TOOLS } from "../phones/tools.ts";
import type { HarnessMcpKind } from "../harness-mcp-request.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
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

/** Budget reserved per connected-app or remote-MCP proxy (capped so built-in servers keep the majority of `budget`). */
const EXTERNAL_PROXY_SHARE_CAP = 5_000;
const EXTERNAL_PROXY_BUDGET_RATIO = 0.4;
const OWN_HEADROOM_RESERVE = 2_000;

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

function unwrapGateUpstream(server: AcpMcpServer, env: Record<string, string>): { command: string; args: string[]; env: Record<string, string> } | null {
  if (!("command" in server) || !server.args.includes(SPAWNED_PROXIES.mcpGate)) return null;
  let configEnv: Record<string, string> = env;
  if (server.args[1] === "--config-env" && typeof server.args[2] === "string") {
    try { configEnv = JSON.parse(env[server.args[2]] ?? "{}") as Record<string, string>; } catch { return null; }
  }
  if (typeof configEnv.OMB_GATE_UPSTREAM !== "string") return null;
  try {
    const parsed = JSON.parse(configEnv.OMB_GATE_UPSTREAM) as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof parsed.command !== "string" || !Array.isArray(parsed.args)) return null;
    const upstreamEnv = parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
      ? parsed.env as Record<string, string>
      : {};
    return { command: parsed.command, args: parsed.args.map(String), env: { ...env, ...upstreamEnv } };
  } catch {
    return null;
  }
}

function ownKind(server: AcpMcpServer): { kind: OwnKind; env: Record<string, string> } | null {
  if (!("command" in server)) return null;
  const env = pairsToRecord(server.env);
  const directUrl = ownMcpOverHttp({ ...server, env })?.url;
  const directKind = directUrl?.slice(directUrl.lastIndexOf("/") + 1);
  if (directKind === "agents" || (directKind !== undefined && directKind in CATALOGS)) {
    return { kind: directKind as OwnKind, env };
  }
  const gated = unwrapGateUpstream(server, env);
  if (!gated) return null;
  const gatedUrl = ownMcpOverHttp({ name: server.name, ...gated })?.url;
  const gatedKind = gatedUrl?.slice(gatedUrl.lastIndexOf("/") + 1);
  return gatedKind === "agents" || (gatedKind !== undefined && gatedKind in CATALOGS)
    ? { kind: gatedKind as OwnKind, env: gated.env }
    : null;
}

function isBudgetableExternalProxy(server: AcpMcpServer): boolean {
  if (!("command" in server)) return false;
  const env = pairsToRecord(server.env);
  const check = (args: readonly string[]) =>
    args.some((arg) => arg === SPAWNED_PROXIES.connectors || arg === SPAWNED_PROXIES.mcpRemote
      || /(?:^|[\\/])(?:connector-proxy|mcp-remote-proxy)\.[jt]s$/.test(arg));
  if (check(server.args)) return true;
  const gated = unwrapGateUpstream(server, env);
  return gated ? check(gated.args) : false;
}

function withProfileShare(server: AcpMcpServer, share: number): AcpMcpServer {
  if (!("command" in server)) return server;
  const env = server.env.filter(({ name }) => name !== TOOL_SCHEMA_PROFILE_ENV);
  return { ...server, env: [...env, { name: TOOL_SCHEMA_PROFILE_ENV, value: toolListShareProfile(share) }] };
}

/** `servers` with each participating server given its share of `budget`; uncounted stdio servers left as they were. */
export function withSessionToolShares(servers: AcpMcpServer[], budget: number, log: (line: string) => void = (line) => console.warn(line)): AcpMcpServer[] {
  const classified = servers.map((server) => {
    const own = ownKind(server);
    return { server, own, external: own === null && isBudgetableExternalProxy(server) };
  });
  const own = classified.filter((entry) => entry.own !== null);
  const external = classified.filter((entry) => entry.external);
  if (!own.length && !external.length) return servers;

  const lists = own.map(({ own: found }) => (
    found!.kind === "agents"
      ? agentsToolList({ ...found!.env, [TOOL_SCHEMA_PROFILE_ENV]: undefined }).listed as ListedTool[]
      : CATALOGS[found!.kind as HarnessMcpKind]
  ));

  let reservedExternal = external.length > 0
    ? (own.length === 0 ? budget : Math.min(Math.floor(budget * EXTERNAL_PROXY_BUDGET_RATIO), external.length * EXTERNAL_PROXY_SHARE_CAP))
    : 0;
  let ownBudget = Math.max(0, budget - reservedExternal);
  let { shares, bytes, fits } = own.length
    ? sessionToolShares(lists, ownBudget)
    : { shares: [] as number[], bytes: 0, fits: true };

  // When built-in servers fit with excess budget to spare, lend the surplus to external proxies rather than starving them.
  if (own.length && external.length && fits) {
    const ownNeed = Math.min(ownBudget, bytes + OWN_HEADROOM_RESERVE);
    const surplus = ownBudget - ownNeed;
    if (surplus > 0) {
      reservedExternal += surplus;
      ownBudget -= surplus;
      ({ shares, bytes, fits } = sessionToolShares(lists, ownBudget));
    }
  }

  if (own.length && !fits) {
    const unbudgeted = classified.filter((entry) => !entry.own && !entry.external).map((entry) => entry.server.name);
    log(`[mcp] this session's own MCP tools (${own.map(({ own: found }) => found!.kind).join(", ")}) come to ${bytes} bytes at their shortest, ${bytes - ownBudget} over the ${ownBudget}-byte tool budget; the engine leaves out its largest tools first${unbudgeted.length ? ` (${unbudgeted.join(", ")} not counted)` : ""}`);
  }

  const shareOf = new Map<AcpMcpServer, number>(own.map(({ server }, index) => [server, shares[index]!]));
  if (external.length > 0) {
    const each = Math.floor(reservedExternal / external.length);
    for (const entry of external) shareOf.set(entry.server, each);
  }

  return servers.map((server) => {
    const share = shareOf.get(server);
    return share === undefined ? server : withProfileShare(server, share);
  });
}

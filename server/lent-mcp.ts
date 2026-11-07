// MCP servers saved here that run on a computer lent to this server (`runsOn`). A bot's turn reaches each one as an MCP
// server at this server's own address, and every call goes to that computer as a lending job: nothing here starts its
// command or fetches its address. Security: the computer gets the server exactly as it is saved here, keys included,
// and runs it only as its own lending allows; the keys never reach the bot.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { canUseMcpServer } from "../shared/tool-scope.ts";
import type { AppConfig } from "./config.ts";
import type { McpServerSpec } from "./contracts.ts";
import { augmentedPath } from "./env-path.ts";
import { deviceWord, type LentPlatform } from "./lent-computers.ts";
import type { McpProbeResult } from "./mcp-probe.ts";
import { isRemoteMcpServer, mcpServerServes, parseStoredMcpServer, type McpRunsOn, type StoredMcpServer } from "./mcp-registry.ts";
import { PASS } from "./routes/table.ts";
import type { LentMcpServer, SharedComputers } from "./shared-computers.ts";

export const LENT_MCP_PATH = "/api/internal/lent/mcp/";
export const isLentMcpPath = (path: string): boolean => path.startsWith(LENT_MCP_PATH);

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/iu;
/** A path on the person's own computer: their home folder (macOS, Linux, `~`) or a Windows drive. */
const PERSONAL_PATH = /^(?:~[\\/]|\/Users\/|\/home\/|[A-Za-z]:[\\/])/u;
const LISTING_MS = 10 * 60_000;
const MAX_TOOLS = 100;
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && LOOPBACK.test(hostname.replace(/^\[|\]$/gu, ""));
  } catch { return false; }
}

/** Security: a lent computer reaches a URL server only on a port of its own, 1024 or higher; one left to its default is a
 * system service's. */
function onItsOwnPort(url: string): boolean {
  try { return Number(new URL(url).port) >= 1024; } catch { return false; }
}

export interface HereChecks {
  exists(path: string): boolean;
  /** A program by its bare name is on this server's PATH. */
  program(command: string): boolean;
  /** Something on this server answers at this loopback address. */
  answers(url: string): Promise<boolean>;
}

const expand = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(2)) : path);
const pathLike = (command: string) => /[\\/]/u.test(command) || command.startsWith("~") || command.startsWith(".");

/** A server added here that only the person's own computer can run: a loopback address nothing here answers, or a command
 * that this server lacks, or that is or reads a path in their home folder this server does not have. */
export async function needsTheirComputer(server: StoredMcpServer, here: HereChecks): Promise<boolean> {
  if (isRemoteMcpServer(server)) return isLoopbackUrl(server.url) && !(await here.answers(server.url));
  const command = server.command.trim();
  if (pathLike(command)) return !here.exists(expand(command));
  if (!here.program(command)) return true;
  return [...server.args, ...Object.values(server.env)].some((value) => [value, ...value.split("=").slice(1)]
    .some((piece) => PERSONAL_PATH.test(piece) && !here.exists(expand(piece))));
}

export function answersHere(url: string): Promise<boolean> {
  const { hostname, port, protocol } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname.replace(/^\[|\]$/gu, ""), port: Number(port) || (protocol === "https:" ? 443 : 80) });
    const done = (answered: boolean) => { socket.destroy(); resolve(answered); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function lentDefinition(name: string, server: StoredMcpServer): LentMcpServer {
  return isRemoteMcpServer(server)
    ? { name, url: server.url, type: server.type, headers: { ...server.headers } }
    : { name, command: server.command, args: [...server.args], env: { ...server.env } };
}

const definitionKey = (definition: LentMcpServer) => createHash("sha256").update(JSON.stringify(definition)).digest("hex");

type ElsewhereServer = StoredMcpServer & { runsOn: McpRunsOn };
type Bot = { id: string; mcpServers?: string[]; toolScope?: unknown };

/** The saved servers that run on another computer and that this bot's turns use: on, for this bot, in its list and its
 * tool selection. */
export function elsewhereServers(cfg: Pick<AppConfig, "mcpServers">, bot: Bot): Array<[string, ElsewhereServer]> {
  return Object.entries(cfg.mcpServers ?? {}).flatMap(([name, raw]): Array<[string, ElsewhereServer]> => {
    if (bot.mcpServers && !bot.mcpServers.includes(name)) return [];
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok || !parsed.server.enabled || !parsed.server.runsOn || !mcpServerServes(parsed.server, bot.id) || !canUseMcpServer(bot.toolScope, name)) return [];
    return [[name, parsed.server as ElsewhereServer]];
  });
}

export type LentState =
  | { kind: "ready"; computerId: string }
  | { kind: "offline" | "stopped" | "never" | "outdated" | "no-terminal" | "port"; computer: string; device: "Mac" | "PC" | "computer" };

export function lentState(computers: Pick<SharedComputers, "runsOn">, principal: string | null, server: ElsewhereServer): LentState {
  const { online, known } = computers.runsOn(principal, server.runsOn);
  const at = (platform: LentPlatform | null | undefined, name: string) => ({ computer: name, device: deviceWord(platform) });
  if (online) {
    if (!online.mcpServers) return { kind: "outdated", ...at(online.platform, online.name) };
    if (isRemoteMcpServer(server) && !onItsOwnPort(server.url)) return { kind: "port", ...at(online.platform, online.name) };
    if (!isRemoteMcpServer(server) && !online.terminal) return { kind: "no-terminal", ...at(online.platform, online.name) };
    return { kind: "ready", computerId: online.id };
  }
  if (known) return { kind: known.lent ? "offline" : "stopped", ...at(known.platform, known.name) };
  return { kind: "never", computer: server.runsOn.label, device: "computer" };
}

/** `personal`: one person's place, whose computers are "your Mac"; `place`: this server, as the person knows it. */
export function lentLine(name: string, state: Exclude<LentState, { kind: "ready" }>, { personal, place }: { personal: boolean; place: string }): string {
  const { computer, device } = state;
  const theirs = personal && device !== "computer" ? `your ${device} (${computer})` : computer;
  switch (state.kind) {
    case "offline": return `${name} runs on ${theirs}, which is offline right now: OpenMausBot on it is closed, or the ${device} is asleep or off.`;
    case "stopped": return `${name} runs on ${theirs}, which no longer lends itself to ${place}: OpenMausBot on it is paused or signed out.`;
    case "never": return `${name} runs on ${theirs}, which isn't lent to ${place}: it works once OpenMausBot is open on that computer and signed in to ${place}.`;
    case "outdated": return `${name} runs on ${theirs}, whose OpenMausBot is too old to run it for ${place}: update OpenMausBot on that ${device}.`;
    case "port": return `${name} runs on ${theirs}, which reaches only an MCP server on its own port, 1024 or higher, at that ${device}'s address: save ${name} with the port its server listens on.`;
    case "no-terminal": return `${name} starts a program on ${theirs}, which doesn't let ${place} run programs right now: turn on "Let Clouds run commands on this ${device}" from the OpenMausBot icon on that ${device}.`;
  }
}

type Turn = { botId: string; threadId: string; generation: string };
type Rpc = { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };

export interface LentMcpDeps {
  cfg(): Pick<AppConfig, "mcpServers">;
  computers: Pick<SharedComputers, "runsOn" | "mcpLenders" | "request">;
  /** The managed policy over a bot's servers. */
  policy<T extends object>(servers: Record<string, T>): Record<string, T>;
  bot(id: string): Bot | null | undefined;
  /** Whom this turn may use lent computers for; null: nobody. */
  principal(turn: Turn): string | null;
  /** Why this turn can't use a lent computer, in words for the bot; null when nothing says so. */
  notice(turn: Turn): string | null;
  /** The same, for a call the bot made: where the person can allow it on a card, the card goes up too. */
  refusal(turn: Turn): string | null;
  /** This turn's bearer for LENT_MCP_PATH, minted only while it runs. */
  mint(turn: Turn): string;
  active(turn: Turn): boolean;
  /** This server's own loopback address, `http://127.0.0.1:<port>`. */
  origin: string;
  personal: boolean;
  place: string;
  here?: HereChecks;
}

const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: Rpc["id"], message: string, code = -32603) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const callError = (id: Rpc["id"], text: string) => reply(id, { content: [{ type: "text", text }], isError: true });
const failed = (result: unknown): string | null => {
  const answer = result as { isError?: unknown; content?: Array<{ text?: unknown }> } | null;
  return answer?.isError === true ? String(answer.content?.[0]?.text ?? "The MCP server failed.") : null;
};

export function createLentMcp(deps: LentMcpDeps) {
  const here: HereChecks = deps.here ?? { exists: existsSync, program: (command) => Boolean(whichHere(command)), answers: answersHere };
  const listings = new Map<string, { at: number; tools: Promise<unknown[]> }>();
  const words = { personal: deps.personal, place: deps.place };

  const servers = (bot: Bot) => deps.policy(Object.fromEntries(elsewhereServers(deps.cfg(), bot)));

  /** The tools a computer lists for a server, kept ten minutes, since every turn's engine asks again as it starts. */
  function tools(computerId: string, definition: LentMcpServer, principal: string, active: () => boolean, fresh = false): Promise<unknown[]> {
    const key = `${computerId}\n${definitionKey(definition)}`;
    const known = listings.get(key);
    if (!fresh && known && Date.now() - known.at < LISTING_MS) return known.tools;
    const listed = deps.computers.request({ computer_id: computerId, action: "mcp_tools", server: definition }, principal, active).then((result) => {
      const error = failed(result);
      if (error) throw new Error(error);
      const list = (result as { tools?: unknown })?.tools;
      if (!Array.isArray(list)) throw new Error(`${definition.name} listed no tools.`);
      return list;
    });
    listings.set(key, { at: Date.now(), tools: listed });
    listed.catch(() => { if (listings.get(key)?.tools === listed) listings.delete(key); });
    return listed;
  }

  async function rpc(name: string, frame: unknown, turn: Turn): Promise<unknown | undefined> {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return rpcError(null, "Invalid request.", -32600);
    const message = frame as Rpc;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(null, "Invalid request.", -32600);
    if (!Object.hasOwn(message, "id")) return undefined;
    const { id, method } = message;
    if (method === "initialize") {
      const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return reply(id, { protocolVersion: PROTOCOLS.includes(String(asked)) ? asked : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: `openmausbot-${name}`, version: "1" } });
    }
    if (method === "ping") return reply(id, {});
    if (method !== "tools/list" && method !== "tools/call") return rpcError(id, "Method not found.", -32601);
    const refuse = (text: string) => (method === "tools/call" ? callError(id, text) : rpcError(id, text));
    const bot = deps.bot(turn.botId);
    const mine = bot ? servers(bot) : {};
    const server = Object.hasOwn(mine, name) ? mine[name] : undefined;
    if (!server) return refuse(`${name} isn't one of your MCP servers on another computer now.`);
    const principal = deps.principal(turn);
    if (!principal) return refuse((method === "tools/call" ? deps.refusal(turn) : deps.notice(turn)) ?? `This conversation can't use ${server.runsOn.label}.`);
    const state = lentState(deps.computers, principal, server);
    if (state.kind !== "ready") return refuse(lentLine(name, state, words));
    const definition = lentDefinition(name, server);
    const active = () => deps.active(turn);
    try {
      if (method === "tools/list") return reply(id, { tools: await tools(state.computerId, definition, principal, active) });
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string" || !params.name) return callError(id, "Name the tool to call.");
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      const result = await deps.computers.request({ computer_id: state.computerId, action: "mcp_call", server: definition, tool_name: params.name, arguments: args }, principal, active);
      return reply(id, result && typeof result === "object" ? result : { content: [] });
    } catch (error) {
      return refuse(error instanceof Error ? error.message : `${name} did not answer.`);
    }
  }

  return {
    principal: (turn: Turn): string | null => deps.principal(turn),

    /** A turn's servers that run on a lent computer it may use now, as servers at this server's address. One it can't
     * reach is left out, and lines() says why. */
    mounts(bot: Bot, turn: Turn): Record<string, McpServerSpec> {
      const elsewhere = Object.entries(servers(bot));
      const principal = elsewhere.length ? deps.principal(turn) : null;
      if (!principal) return {};
      const mounted: Record<string, McpServerSpec> = {};
      let token: string | null = null;
      for (const [name, server] of elsewhere) {
        const state = lentState(deps.computers, principal, server);
        if (state.kind !== "ready") continue;
        token ??= deps.mint(turn);
        mounted[name] = { type: "http", url: `${deps.origin}${LENT_MCP_PATH}${name}`, headers: { authorization: `Bearer ${token}` } };
        void tools(state.computerId, lentDefinition(name, server), principal, () => deps.active(turn)).catch(() => {});
      }
      return mounted;
    },

    /** What the bot is told about each of its servers that runs elsewhere and that its turn can't reach now, by name. */
    lines(bot: Bot, turn: Turn): Map<string, string> {
      const elsewhere = Object.entries(servers(bot));
      const principal = elsewhere.length ? deps.principal(turn) : null;
      const said = new Map<string, string>();
      for (const [name, server] of elsewhere) {
        const state = lentState(deps.computers, principal, server);
        if (state.kind === "ready") continue;
        const refusal = principal ? null : deps.notice(turn);
        said.set(name, refusal ? `${name} runs on ${server.runsOn.label}. ${refusal}` : lentLine(name, state, words));
      }
      return said;
    },

    /** Runs only once the turn's bearer is checked. */
    async route(ctx: { method: string; path: string; req: IncomingMessage; res: ServerResponse; turn: Turn; readBody(): Promise<unknown>; json(res: ServerResponse, status: number, body: unknown): void }): Promise<typeof PASS | void> {
      if (!isLentMcpPath(ctx.path)) return PASS;
      const name = ctx.path.slice(LENT_MCP_PATH.length);
      if (ctx.method !== "POST") { ctx.res.writeHead(405, { allow: "POST" }).end(); return; }
      const answer = await rpc(name, await ctx.readBody(), ctx.turn);
      if (answer === undefined) { ctx.res.writeHead(202).end(); return; }
      ctx.json(ctx.res, 200, answer);
    },

    async test(name: string, server: StoredMcpServer & { runsOn: McpRunsOn }, principal: string | null, signal: AbortSignal): Promise<{ status: 200; body: McpProbeResult } | { status: 409; error: string }> {
      const state = lentState(deps.computers, principal, server);
      if (!principal) return { status: 409, error: `${name} runs on ${server.runsOn.label}, so it is checked there the next time one of your conversations uses it.` };
      if (state.kind !== "ready") return { status: 409, error: lentLine(name, state, words) };
      try {
        const listed = await tools(state.computerId, lentDefinition(name, server), principal, () => !signal.aborted, true);
        const named = listed.flatMap((tool) => (tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string" ? [tool as { name: string; description?: unknown }] : []));
        const shown = named.slice(0, MAX_TOOLS).map((tool) => ({ name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 500) } : {}) }));
        return { status: 200, body: { ok: true, tools: shown, ...(named.length > shown.length ? { total: named.length } : {}) } };
      } catch (error) {
        return { status: 200, body: { ok: false, reason: "unreachable", error: error instanceof Error ? error.message : `${name} did not answer.` } };
      }
    },

    /** A server added here that needs the person's own computer, marked as running on the one of theirs lent now: the one
     * named, else the one this session lends from, else the only one. With several and none of those, the adder is asked.
     * With none lent, a server that needs the person's computer is refused. */
    async place(server: StoredMcpServer, who: { principal: string | null; session?: string; computer?: string; newest?: boolean }): Promise<{ ok: true; server: StoredMcpServer } | { ok: false; error: string }> {
      if (server.runsOn || !who.principal) return { ok: true, server };
      const lenders = deps.computers.mcpLenders(who.principal);
      if (!(await needsTheirComputer(server, here))) return { ok: true, server };
      const remote = isRemoteMcpServer(server);
      if (!lenders.length) return { ok: false, error: `${remote ? "That address is" : "This command runs"} on the person's own computer, and no computer is lent to ${deps.place} now. Ask them to lend their Mac or PC${remote ? "" : " with its terminal"}, then add it again.` };
      if (remote && !onItsOwnPort(server.url)) return { ok: false, error: "This server runs on the person's own computer, which reaches only an MCP server on its own port, 1024 or higher: add it again with the port its server listens on in its address." };
      const asked = who.computer?.trim().toLowerCase();
      const named = asked ? lenders.find((lender) => lender.name.toLowerCase() === asked) : undefined;
      const names = lenders.map((lender) => lender.name).join(", ");
      if (asked && !named) return { ok: false, error: `No computer called ${who.computer} is lent to ${deps.place} now. These are: ${names}.` };
      const chosen = named ?? lenders.find((lender) => lender.session === who.session) ?? (lenders.length === 1 || who.newest ? lenders[0] : undefined);
      if (!chosen) return { ok: false, error: `This server runs on the person's own computer, and several are lent to ${deps.place}: ${names}. Ask the person which one in one short question, then add it again with computer set to its name.` };
      return { ok: true, server: { ...server, runsOn: { environmentId: chosen.environmentId, label: chosen.name } } };
    },
  };
}

export type LentMcp = ReturnType<typeof createLentMcp>;

function whichHere(command: string): string | null {
  const dirs = augmentedPath().split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) for (const suffix of suffixes) if (existsSync(join(dir, `${command}${suffix}`))) return join(dir, `${command}${suffix}`);
  return null;
}

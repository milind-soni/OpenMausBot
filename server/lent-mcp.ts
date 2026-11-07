// MCP servers saved here that run on a computer lent to this server (`runsOn`). A bot's turn reaches each one as an MCP
// server at this server's own address. A computer that lends them over its device link gets the turn's requests on
// streams of that link and starts a command only once the person allows it there; an older computer gets each call as a
// lending job. Nothing here starts a server's command or fetches its address. Security: the computer gets the server
// exactly as it is saved here, keys included, and runs it only as its own lending allows; the keys never reach the bot.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { LinkOpened, LinkStream } from "../electron/device-link-protocol.mjs";
import { commandFingerprint } from "../electron/lent-mcp.mjs";
import { canUseMcpServer } from "../shared/tool-scope.ts";
import type { AppConfig } from "./config.ts";
import type { McpServerSpec } from "./contracts.ts";
import type { DeviceLinks } from "./device-links.ts";
import { augmentedPath } from "./env-path.ts";
import { readBody } from "./harness/http.ts";
import { deviceWord, type LentPlatform } from "./lent-computers.ts";
import { replayHttp, replayPath } from "./lent-mcp-link.ts";
import { StdioSessions } from "./lent-mcp-stdio.ts";
import { probeMcpServer, type McpProbeResult } from "./mcp-probe.ts";
import { isRemoteMcpServer, mcpServerServes, parseStoredMcpServer, type McpRunsOn, type StoredMcpServer, type StoredStdioMcpServer } from "./mcp-registry.ts";
import { PASS } from "./routes/table.ts";
import type { LentMcpServer, SharedComputers } from "./shared-computers.ts";

export const LENT_MCP_PATH = "/api/internal/lent/mcp/";
export const isLentMcpPath = (path: string): boolean => path.startsWith(LENT_MCP_PATH);

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/iu;
/** A path on the person's own computer: their home folder (macOS, Linux, `~`) or a Windows drive. */
const PERSONAL_PATH = /^(?:~[\\/]|\/Users\/|\/home\/|[A-Za-z]:[\\/])/u;
const LISTING_MS = 10 * 60_000;
const SESSION_IDLE_MS = 10 * 60_000;
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

type Device = "Mac" | "PC" | "computer";
/** `link`: the computer lends its MCP servers over its device link, not as lending jobs. */
export type LentState =
  | { kind: "ready"; computerId: string; link: boolean; computer: string; device: Device }
  | { kind: "offline" | "stopped" | "never" | "outdated" | "no-terminal" | "port" | "not-lending"; computer: string; device: Device };

const PROBLEMS = ["no-link", "not-lending", "needs-approval", "declined", "no-server", "changed", "unreachable"] as const;
export type LentProblem = (typeof PROBLEMS)[number];
const isProblem = (word: string): word is LentProblem => (PROBLEMS as readonly string[]).includes(word);

export function lentState(computers: Pick<SharedComputers, "runsOn">, principal: string | null, server: ElsewhereServer): LentState {
  const { online, known } = computers.runsOn(principal, server.runsOn);
  const at = (platform: LentPlatform | null | undefined, name: string) => ({ computer: name, device: deviceWord(platform) });
  if (online) {
    const there = at(online.platform, online.name);
    if (online.mcpLink === false) return { kind: "not-lending", ...there };
    if (!online.mcpServers) return { kind: "outdated", ...there };
    if (isRemoteMcpServer(server) && !onItsOwnPort(server.url)) return { kind: "port", ...there };
    // Security: over the link, the person's Allow on the computer is what lets a command run there.
    if (!isRemoteMcpServer(server) && !online.terminal && online.mcpLink === null) return { kind: "no-terminal", ...there };
    return { kind: "ready", computerId: online.id, link: online.mcpLink === true, ...there };
  }
  if (known) return { kind: known.lent ? "offline" : "stopped", ...at(known.platform, known.name) };
  return { kind: "never", computer: server.runsOn.label, device: "computer" };
}

/** `personal`: one person's place, whose computers are "your Mac"; `place`: this server, as the person knows it. */
export function lentLine(name: string, state: Exclude<LentState, { kind: "ready" }> | { kind: LentProblem; computer: string; device: Device }, { personal, place }: { personal: boolean; place: string }): string {
  const { computer, device } = state;
  const theirs = personal && device !== "computer" ? `your ${device} (${computer})` : computer;
  switch (state.kind) {
    case "offline": return `${name} runs on ${theirs}, which is offline right now: OpenMausBot on it is closed, or the ${device} is asleep or off.`;
    case "stopped": return `${name} runs on ${theirs}, which no longer lends itself to ${place}: OpenMausBot on it is paused or signed out.`;
    case "never": return `${name} runs on ${theirs}, which isn't lent to ${place}: it works once OpenMausBot is open on that computer and signed in to ${place}.`;
    case "outdated": return `${name} runs on ${theirs}, whose OpenMausBot is too old to run it for ${place}: update OpenMausBot on that ${device}.`;
    case "port": return `${name} runs on ${theirs}, which reaches only an MCP server on its own port, 1024 or higher, at that ${device}'s address: save ${name} with the port its server listens on.`;
    case "no-terminal": return `${name} starts a program on ${theirs}, which doesn't let ${place} run programs right now: turn on "Let Clouds run commands on this ${device}" from the OpenMausBot icon on that ${device}.`;
    case "no-link": return `${name} runs on ${theirs}, whose connection to ${place} isn't up yet: try again in a moment. If it stays this way, the network there may be blocking it.`;
    case "not-lending": return `${name} runs on ${theirs}, which isn't lending its MCP servers to ${place}: turn on "Let My Cloud use your MCP servers on this ${device}" from the OpenMausBot icon on that ${device}.`;
    case "needs-approval": return `Allow ${name} on ${theirs}: a prompt is waiting there. Then try again.`;
    case "declined": return `On ${theirs}, the person didn't allow ${name}. Ask them before trying again.`;
    case "no-server": return `${theirs.replace(/^your /u, "Your ")} has no definition of ${name} to run.`;
    case "changed": return `${name} changed since the person allowed it on ${theirs}: a new prompt is waiting there.`;
    case "unreachable": return `${name} on ${theirs} didn't answer. Check that it is running there.`;
  }
}

/** Why a link to the computer opened no stream; null: there is no open link to it. */
export function linkProblem(opened: Exclude<LinkOpened, LinkStream> | null): LentProblem {
  if (!opened) return "no-link";
  if ("refused" in opened) return opened.refused === "not-lent" ? "not-lending" : opened.refused === "needs-approval" || opened.refused === "declined" ? opened.refused : "unreachable";
  return "failed" in opened && (opened.failed === "no-server" || opened.failed === "changed") ? opened.failed : "unreachable";
}

type Turn = { botId: string; threadId: string; generation: string };
type Rpc = { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };
/** One request of a turn's engine to a server whose computer lends it over its link, at the door `prefix`. `said`
 * hears each problem it is answered with. */
type Serving = { name: string; server: ElsewhereServer; state: Extract<LentState, { kind: "ready" }>; principal: string; turn: Turn; active(): boolean; prefix: string; readBody(): Promise<unknown>; said?(problem: LentProblem): void };
/** `latest`: the server as the newest request found it saved, and whether that request's turn still runs. */
type ThreadSessions = { generation: string; computerId: string; latest: { server: StoredStdioMcpServer; active(): boolean }; sessions: StdioSessions };

export interface LentMcpDeps {
  cfg(): Pick<AppConfig, "mcpServers">;
  computers: Pick<SharedComputers, "runsOn" | "mcpLenders" | "request">;
  links: Pick<DeviceLinks, "mcpRoute">;
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
const initialized = (name: string, params: unknown) => {
  const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  return { protocolVersion: PROTOCOLS.includes(String(asked)) ? asked : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: `openmausbot-${name}`, version: "1" } };
};
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
    if (method === "initialize") return reply(id, initialized(name, message.params));
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
    // Security: a computer that lends its MCP servers over its link is never sent them as jobs, even one that began to
    // while this request arrived.
    if (state.link) return refuse(lentLine(name, { kind: "unreachable", computer: state.computer, device: state.device }, words));
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

  const threads = new Map<string, ThreadSessions>();
  const forget = (key: string, entry = threads.get(key)) => {
    if (threads.get(key) === entry) threads.delete(key);
    entry?.sessions.close();
  };

  /** The thread's sessions of a command server. A new session from the thread's next turn, or any request for another
   * computer, ends the ones before it. */
  function sessionsOf(key: string, at: Serving, server: StoredStdioMcpServer, fresh: boolean): ThreadSessions {
    const kept = threads.get(key);
    if (kept && kept.computerId === at.state.computerId && (!fresh || kept.generation === at.turn.generation)) {
      kept.latest = { server, active: at.active };
      return kept;
    }
    if (kept) forget(key, kept);
    const entry: ThreadSessions = {
      generation: at.turn.generation,
      computerId: at.state.computerId,
      latest: { server, active: at.active },
      sessions: new StdioSessions({ open: () => openCommand(at, entry), idleMs: SESSION_IDLE_MS, onEmpty: () => { if (threads.get(key) === entry) forget(key, entry); } }),
    };
    threads.set(key, entry);
    return entry;
  }

  /** A new session's stream, for the server as saved now; one that opens after its turn ended is cancelled. */
  async function openCommand(at: Serving, entry: ThreadSessions): Promise<LinkOpened> {
    const { server, active } = entry.latest;
    const route = deps.links.mcpRoute(at.principal, at.state.computerId);
    const opened = route ? await route.open({ name: at.name, fingerprint: commandFingerprint(server) }) : { gone: true as const };
    if (!("join" in opened) || active()) return opened;
    opened.cancel();
    return { gone: true };
  }

  /** Answers on this server for one the computer couldn't be asked for, or refused: an `initialize` gets the plain words
   * as its session's instructions, and later requests in that session, which carry `refused-<problem>`, get a session
   * with no tools; any other request gets them as its error. */
  async function answerHere(req: IncomingMessage, res: ServerResponse, at: Serving, problem: LentProblem, parsed?: unknown): Promise<void> {
    at.said?.(problem);
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST, DELETE" }).end();
    const body = parsed ?? await at.readBody();
    const messages = (Array.isArray(body) ? body : [body]).filter((message): message is Rpc => typeof message === "object" && message !== null && (message as Rpc).jsonrpc === "2.0");
    if (!messages.length) return void res.writeHead(400).end();
    const refusedSession = String(req.headers["mcp-session-id"]).startsWith("refused-");
    const line = lentLine(at.name, { kind: problem, computer: at.state.computer, device: at.state.device }, words);
    const answers = messages.filter((message) => typeof message.method === "string" && Object.hasOwn(message, "id")).map(({ id, method, params }) => {
      if (method === "initialize") return reply(id, { ...initialized(at.name, params), instructions: line });
      if (refusedSession && method === "tools/list") return reply(id, { tools: [] });
      if (refusedSession && method === "ping") return reply(id, {});
      return method === "tools/call" ? callError(id, line) : rpcError(id, line);
    });
    if (!answers.length) return void res.writeHead(202).end();
    const opening = messages.some((message) => message.method === "initialize");
    res.writeHead(200, { "content-type": "application/json", ...(opening ? { "mcp-session-id": `refused-${problem}` } : {}) }).end(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
  }

  async function serve(req: IncomingMessage, res: ServerResponse, at: Serving): Promise<void> {
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") return void res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
    if (!at.active()) return void res.writeHead(401).end();
    const session = req.headers["mcp-session-id"];
    if (typeof session === "string" && session.startsWith("refused-")) {
      const said = session.slice("refused-".length);
      return answerHere(req, res, at, isProblem(said) ? said : "unreachable");
    }
    const route = deps.links.mcpRoute(at.principal, at.state.computerId);
    if (!route) return answerHere(req, res, at, linkProblem(null));
    if (isRemoteMcpServer(at.server)) {
      const saved = new URL(at.server.url);
      const path = replayPath(req.url ?? "", at.prefix, { path: saved.pathname, query: saved.search });
      if (path === null) return void res.writeHead(404).end();
      const port = Number(saved.port);
      const opened = await route.open({ name: at.name, port }).catch((): { gone: true } => ({ gone: true }));
      const ended = res.destroyed || !at.active();
      if (ended && "join" in opened) opened.cancel();
      if (res.destroyed) return;
      if (ended) return void res.writeHead(401).end();
      if (!("join" in opened)) return answerHere(req, res, at, linkProblem(opened));
      return replayHttp(req, res, opened, { port, path, prefix: at.prefix, headers: at.server.headers });
    }
    const key = `${at.turn.threadId}\n${at.name}`;
    const entry = sessionsOf(key, at, at.server, session === undefined);
    const outcome = await entry.sessions.handle(req, res);
    if (outcome === "opened" && threads.get(key) !== entry) forget(key, entry);
    if (threads.get(key) === entry && !entry.sessions.size) forget(key, entry);
    if (!outcome || outcome === "opened") return;
    if (!at.active()) return void res.writeHead(401).end();
    return answerHere(req, res, at, linkProblem(outcome.refused), outcome.body);
  }

  /** Test over the link: the probe reaches the server, as a turn of its own, through a loopback door only its token opens. */
  async function probeOverLink(name: string, server: ElsewhereServer, state: Serving["state"], principal: string, signal: AbortSignal): Promise<{ status: 200; body: McpProbeResult }> {
    const token = randomBytes(32).toString("hex");
    const turn = { botId: "mcp-test", threadId: `test-${randomUUID()}`, generation: randomUUID() };
    let problem = null as LentProblem | null;
    const door = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0]!;
      // Security: the door answers only its token, and its turn ends with the test.
      if (path !== `/${token}` && !path.startsWith(`/${token}/`)) return void res.writeHead(404).end();
      void serve(req, res, { name, server, state, principal, turn, active: () => !signal.aborted, prefix: `/${token}`, readBody: () => readBody(req), said: (said) => { problem = said; } }).catch(() => res.destroy());
    });
    await new Promise<void>((done) => door.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(door.address() as AddressInfo).port}/${token}`;
      const probed = await probeMcpServer({ type: isRemoteMcpServer(server) ? server.type : "http", url, headers: {}, enabled: true }, undefined, signal);
      return { status: 200, body: problem ? { ok: false, reason: "unreachable", error: lentLine(name, { kind: problem, computer: state.computer, device: state.device }, words) } : probed };
    } finally {
      door.closeAllConnections();
      door.close();
      forget(`${turn.threadId}\n${name}`);
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
        mounted[name] = { type: state.link && isRemoteMcpServer(server) ? server.type : "http", url: `${deps.origin}${LENT_MCP_PATH}${name}`, headers: { authorization: `Bearer ${token}` } };
        if (!state.link) void tools(state.computerId, lentDefinition(name, server), principal, () => deps.active(turn)).catch(() => {});
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
      const rest = ctx.path.slice(LENT_MCP_PATH.length);
      const name = rest.split("/")[0]!;
      const bot = deps.bot(ctx.turn.botId);
      const mine = bot ? servers(bot) : {};
      const server = Object.hasOwn(mine, name) ? mine[name] : undefined;
      const principal = server ? deps.principal(ctx.turn) : null;
      const state = server && principal ? lentState(deps.computers, principal, server) : null;
      if (server && principal && state?.kind === "ready" && state.link) {
        return serve(ctx.req, ctx.res, { name, server, state, principal, turn: ctx.turn, active: () => deps.active(ctx.turn), prefix: LENT_MCP_PATH + name, readBody: ctx.readBody });
      }
      if (ctx.method !== "POST") { ctx.res.writeHead(405, { allow: "POST" }).end(); return; }
      const answer = await rpc(rest, await ctx.readBody(), ctx.turn);
      if (answer === undefined) { ctx.res.writeHead(202).end(); return; }
      ctx.json(ctx.res, 200, answer);
    },

    async test(name: string, server: StoredMcpServer & { runsOn: McpRunsOn }, principal: string | null, signal: AbortSignal): Promise<{ status: 200; body: McpProbeResult } | { status: 409; error: string }> {
      const state = lentState(deps.computers, principal, server);
      if (!principal) return { status: 409, error: `${name} runs on ${server.runsOn.label}, so it is checked there the next time one of your conversations uses it.` };
      if (state.kind !== "ready") return { status: 409, error: lentLine(name, state, words) };
      if (state.link) return probeOverLink(name, server, state, principal, signal);
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

    /** The command server saved here under `name` for the computer `computerId` of `principal`'s, which reads it before
     * it starts it for a turn; null for a URL server, one that is off, or another computer's. */
    definition(principal: string, computerId: string, name: string): LentMcpServer | null {
      const saved = deps.cfg().mcpServers ?? {};
      const parsed = Object.hasOwn(saved, name) ? parseStoredMcpServer(name, saved[name]) : null;
      if (!parsed?.ok || !parsed.server.enabled || isRemoteMcpServer(parsed.server) || !parsed.server.runsOn) return null;
      return deps.computers.runsOn(principal, parsed.server.runsOn).online?.id === computerId ? lentDefinition(name, parsed.server) : null;
    },

    /** Ends every command session, and with each its child on the computer. */
    close(): void {
      for (const key of threads.keys()) forget(key);
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

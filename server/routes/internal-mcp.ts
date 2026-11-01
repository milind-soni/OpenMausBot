import { relative } from "node:path";

import type { AppConfig } from "../config.ts";
import { MCP_CONFIG_BUSY, type McpConfig, type McpConfigResult } from "../host/mcp-config.ts";
import type { McpServersHost } from "../host/mcp-servers-host.ts";
import { BOT_STRIPPED_KEYS, botListing, botMayChange, isSecretRef, mcpOwner, mergeBotUpdate, type McpOwner } from "../mcp-bot-rules.ts";
import type { McpAuthState, McpOAuthManager } from "../mcp-oauth.ts";
import type { McpProbeResult } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseMcpServerMutation, parseStoredMcpServer, type StoredMcpServer } from "../mcp-registry.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { PASS, type RouteHandler } from "./table.ts";

const PATH = "/api/internal/mcp-servers";
const ACTIONS = ["list", "add", "update", "enable", "disable", "test", "sign_in", "sign_out", "remove"] as const;
type McpAction = (typeof ACTIONS)[number];
const MAX_TOOL_NAMES = 100;

const OWNER_ONLY = "MCP servers are managed by the owner.";
const ASK_ADMIN = "Ask a workspace admin to add it.";
const ASK_SETTINGS = "Ask the person to change this in Settings.";
const NEXT_TURN = "The new tools arrive on your next turn.";

/** Only dispatch inside the internal capability gate, with its guarded body reader. The global route table must never
 * register this endpoint. */
export interface InternalMcpDeps {
  readBody(): Promise<Record<string, unknown>>;
  sender: { id: string; mcpServers?: string[] };
  threadId: string;
  fullAccess(): boolean;
  /** Refuses every action, list included. */
  guestDriven(): boolean;
  /** True off a Team Cloud; on one, the person this turn acts for is an owner or admin. */
  teamAdmin(): boolean;
  /** The bot's tool selection reaches this server; never widened here. */
  canUse(name: string): boolean;
  config: McpConfig;
  cfg(): AppConfig;
  personal(): string[];
  authState(name: string, url: string): McpAuthState;
  managedBy(name: string, server: StoredMcpServer): string | undefined;
  signOut(name: string, url: string): Promise<void>;
  /** The person this turn acts for, testing their own connection to a personal server. */
  testAs(name: string, url: string): { oauth: McpOAuthManager; key?: { header: string; value: string } } | null;
  redeem(body: Record<string, unknown>): { ok: true; value: Record<string, unknown>; commit(): void } | { ok: false; error: string };
  addToBotList(name: string): void;
  botAdd(current: Record<string, unknown>, body: unknown): ReturnType<McpServersHost["botAdd"]>;
  ownCwd(): string;
  /** A change applied with no card, for the decision log. */
  decide(summary: string): void;
  activity(label: string): void;
  language(): string | undefined;
}

type Outcome = { status: number; text: string; dropped?: string[] } | { status: number; error: string };

export function createInternalMcpRoutes(deps: InternalMcpDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== PATH || (method !== "GET" && method !== "POST")) return PASS;
    if (deps.guestDriven()) return json(res, 403, { error: OWNER_ONLY });
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnect);
    try {
      const outcome = method === "GET" ? list(deps) : await act(deps, await deps.readBody(), controller.signal);
      if ("error" in outcome) return json(res, outcome.status, { error: outcome.error });
      return json(res, outcome.status, { text: outcome.text, ...(outcome.dropped?.length ? { dropped: outcome.dropped } : {}) });
    } finally {
      res.off("close", disconnect);
    }
  };
}

async function act(deps: InternalMcpDeps, body: unknown, signal: AbortSignal): Promise<Outcome> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "request body must be a JSON object" };
  const { action, name, ...rest } = body as Record<string, unknown>;
  if (!ACTIONS.includes(action as McpAction)) return { status: 400, error: `mcp_server needs action: one of ${ACTIONS.join(", ")}.` };
  if (action === "list") return list(deps);
  if (action === "sign_in") return { status: 501, error: "Not yet" };
  if (typeof name !== "string" || !name) return { status: 400, error: `mcp_server ${String(action)} needs name.` };
  const fields = Object.fromEntries(Object.entries(rest).filter(([key]) => !BOT_STRIPPED_KEYS.includes(key)));
  if (action === "add") return add(deps, name, fields, signal);

  const servers = deps.cfg().mcpServers ?? {};
  if (!Object.hasOwn(servers, name)) return { status: 404, error: `${name} doesn't exist. Call mcp_server with action list to see the servers.` };
  const parsed = parseStoredMcpServer(name, servers[name]);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const server = parsed.server;
  const owner = mcpOwner(name, server, deps.sender.id, deps.personal());
  if (action === "test") return test(deps, name, server, owner, signal);

  const may = botMayChange(owner, server);
  if (!may.ok) return { status: 403, error: may.error };
  if (owner === "shared" && !deps.teamAdmin()) return { status: 403, error: ASK_ADMIN };
  if (action === "disable") return disable(deps, name);
  if (action === "sign_out") return signOut(deps, name, server);
  // A deliberate exception to server/direct-apply.ts, which applies a bot's change at every level with Undo: turning an
  // MCP server on runs a command on the person's computer or sends their data to a new service, the kind of action the
  // approval mode governs for shell commands. Turning one off or signing out only lowers what bots can do.
  if (!deps.fullAccess()) return { status: 403, error: ASK_SETTINGS };
  if (action === "update") return update(deps, name, server, fields, signal);
  if (action === "enable") return enable(deps, name, server, signal);
  return remove(deps, name);
}

function list(deps: InternalMcpDeps): Outcome {
  const personal = deps.personal();
  const rows = Object.entries(deps.cfg().mcpServers ?? {}).flatMap(([name, raw]) => {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) return [];
    const owner = mcpOwner(name, parsed.server, deps.sender.id, personal);
    if (owner === "theirs") return [];
    const server = parsed.server;
    return [botListing(name, server, {
      owner,
      authState: isRemoteMcpServer(server) ? deps.authState(name, server.url) : "none",
      forThisBot: (!deps.sender.mcpServers || deps.sender.mcpServers.includes(name)) && deps.canUse(name),
      managedBy: deps.managedBy(name, server),
    })];
  });
  say(deps, ["server.mcp.listed"]);
  return { status: 200, text: `MCP servers you can see (${rows.length}):\n${JSON.stringify(rows)}` };
}

async function add(deps: InternalMcpDeps, name: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<Outcome> {
  if (!deps.teamAdmin()) return { status: 403, error: ASK_ADMIN };
  if (Object.hasOwn(deps.cfg().mcpServers ?? {}, name)) return { status: 409, error: `${name} already exists. Use update, or pick another name.` };
  const redeemed = deps.redeem(trimmedRefs({ name, ...fields }));
  if (!redeemed.ok) return { status: 400, error: redeemed.error };
  const added = deps.botAdd(deps.cfg().mcpServers ?? {}, redeemed.value);
  if (!added.ok) return { status: added.status, error: added.error };
  const saved = deps.config.add(name, added.server);
  if ("error" in saved) return refused(saved);
  redeemed.commit();
  const server = added.server;
  const where = isRemoteMcpServer(server)
    ? ""
    : (server.bot ? " It uses files in your own folder, so it works only for you, not for other bots." : "")
      + (added.moved?.length ? ` Its files were in this conversation's temporary folder, so they were copied to ${added.moved.map(({ to }) => relative(deps.ownCwd(), to)).join(", ")} in your own folder, and it runs from there: change them there.` : "");

  if (!deps.fullAccess()) {
    say(deps, ["server.mcp.added", { name }], ["server.mcp.off"]);
    const local = isRemoteMcpServer(server) ? "" : " Turning on a local command runs that command on their computer.";
    return { status: 201, text: `Saved MCP server ${name} switched off. It stays off until the person turns it on in Settings → MCP servers.${local}${where}` };
  }
  const on = deps.config.setEnabled(name, true);
  if ("error" in on) return { status: on.status, error: `Saved ${name}, but it is still off: ${on.error}` };
  joinBotList(deps, name);
  const outcome = await probe(deps, name, server, signal);
  deps.decide(`Added MCP server ${name} and turned it on`);
  say(deps, ["server.mcp.added", { name }], ["server.mcp.on"], [outcome.label]);
  return { status: 201, text: `Added MCP server ${name} and turned it on. ${outcome.text}${selection(deps, name)}${where} ${NEXT_TURN}` };
}

async function update(deps: InternalMcpDeps, name: string, existing: StoredMcpServer, fields: Record<string, unknown>, signal: AbortSignal): Promise<Outcome> {
  const remote = isRemoteMcpServer(existing);
  const crossing = remote ? ["command", "args", "env"] : ["url", "type", "headers", "oauth"];
  if (crossing.some((key) => fields[key] !== undefined)) {
    return { status: 400, error: `${name} ${remote ? "is reached by its address" : "runs a command"}: to switch, remove it and add it again.` };
  }
  const merged = mergeBotUpdate(existing, fields);
  const signedIn = remote && deps.authState(name, existing.url) === "signed-in";
  const dropped = signedIn ? merged.dropped : merged.dropped.filter((item) => item !== "sign-in");
  const redeemed = deps.redeem(trimmedRefs(merged.body));
  if (!redeemed.ok) return { status: 400, error: redeemed.error };
  const parsed = parseMcpServerMutation(name, redeemed.value, existing);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const saved = deps.config.replace(name, parsed.server);
  if ("error" in saved) return refused(saved);
  redeemed.commit();
  deps.decide(`Changed MCP server ${name}`);
  const cleared = dropped.length
    ? ` Its destination changed, so these saved values were cleared: ${dropped.join(", ")}. If it still needs them, ask again with request_credential (delivery ref) and send the secretRef with action update.`
    : "";
  const changed: Line[] = [["server.mcp.changed", { name }], ...(dropped.length ? [["server.mcp.keysCleared"] as Line] : [])];
  if (!parsed.server.enabled) {
    say(deps, ...changed);
    return { status: 200, text: `Changed MCP server ${name}. It is off.${cleared}`, dropped };
  }
  const outcome = await probe(deps, name, parsed.server, signal);
  say(deps, ...changed, [outcome.label]);
  return { status: 200, text: `Changed MCP server ${name}.${cleared} ${outcome.text} ${NEXT_TURN}`, dropped };
}

async function enable(deps: InternalMcpDeps, name: string, server: StoredMcpServer, signal: AbortSignal): Promise<Outcome> {
  const on = deps.config.setEnabled(name, true);
  if ("error" in on) return refused(on);
  joinBotList(deps, name);
  const outcome = await probe(deps, name, server, signal);
  deps.decide(`Turned on MCP server ${name}`);
  say(deps, ["server.mcp.turnedOn", { name }], [outcome.label]);
  return { status: 200, text: `Turned on MCP server ${name}. ${outcome.text}${selection(deps, name)} ${NEXT_TURN}` };
}

function disable(deps: InternalMcpDeps, name: string): Outcome {
  const off = deps.config.setEnabled(name, false);
  if ("error" in off) return refused(off);
  deps.decide(`Turned off MCP server ${name}`);
  say(deps, ["server.mcp.turnedOff", { name }]);
  return { status: 200, text: `Turned off MCP server ${name}. Its tools leave on your next turn.` };
}

async function signOut(deps: InternalMcpDeps, name: string, server: StoredMcpServer): Promise<Outcome> {
  if (!isRemoteMcpServer(server)) return { status: 400, error: `${name} runs a command, so it has no sign-in.` };
  await deps.signOut(name, server.url);
  deps.decide(`Signed out of MCP server ${name}`);
  say(deps, ["server.mcp.signedOut", { name }]);
  return { status: 200, text: `Signed out of MCP server ${name}. It stays ${server.enabled ? "on" : "off"}; call mcp_server with action sign_in to sign in again.` };
}

function remove(deps: InternalMcpDeps, name: string): Outcome {
  const gone = deps.config.remove(name);
  if ("error" in gone) return refused(gone);
  deps.decide(`Removed MCP server ${name}`);
  say(deps, ["server.mcp.removed", { name }]);
  return { status: 200, text: `Removed MCP server ${name}, its saved keys and its sign-in. Its tools leave on your next turn.` };
}

async function test(deps: InternalMcpDeps, name: string, server: StoredMcpServer, owner: McpOwner, signal: AbortSignal): Promise<Outcome> {
  const may = botMayChange(owner, server);
  if (owner === "theirs" && !may.ok) return { status: 403, error: may.error };
  if (!server.enabled && !deps.fullAccess()) {
    return { status: 403, error: `${name} is off, and testing it would start it. Ask the person to turn it on first.` };
  }
  const outcome = await probe(deps, name, server, signal);
  say(deps, ["server.mcp.tested", { name }], [outcome.label]);
  return { status: 200, text: `MCP server ${name}: ${outcome.text}` };
}

async function probe(deps: InternalMcpDeps, name: string, server: StoredMcpServer, signal: AbortSignal): Promise<{ text: string; label: ServerLineKey }> {
  const result = await deps.config.test(name, {
    signal,
    asBot: { id: deps.sender.id, cwd: deps.ownCwd() },
    person: (url) => deps.testAs(name, url),
  });
  if ("error" in result) return { text: `Not tested: ${result.error}`, label: "server.mcp.testFailed" };
  const probed = result.body as McpProbeResult;
  if (probed.ok) {
    const names = probed.tools.slice(0, MAX_TOOL_NAMES).map((tool) => tool.name);
    const total = probed.total ?? probed.tools.length;
    const more = total > names.length ? ` and ${total - names.length} more` : "";
    return { text: names.length ? `Test: it works. Its tools: ${names.join(", ")}${more}.` : "Test: it works, but it has no tools.", label: "server.mcp.testWorks" };
  }
  if (probed.auth === "required") {
    return { text: `Test: needs sign-in. Call mcp_server with action sign_in and name ${name}, then end your turn.`, label: "server.mcp.testSignIn" };
  }
  if (probed.reason === "keys") {
    const keys = isRemoteMcpServer(server) ? Object.keys(server.headers) : Object.keys(server.env);
    return {
      text: `Test: needs a key${keys.length ? ` (${keys.join(", ")})` : ""}. Ask for it with request_credential (delivery ref) and send the secretRef with action update. Tell the person they can enter it on the computer or an iPhone.`,
      label: "server.mcp.testKey",
    };
  }
  return { text: `Test: failed. ${probed.error}`, label: "server.mcp.testFailed" };
}

function refused(result: Extract<McpConfigResult, { error: string }>): Outcome {
  return { status: result.status, error: result.error === MCP_CONFIG_BUSY ? `${result.error} Try again in a moment.` : result.error };
}

function joinBotList(deps: InternalMcpDeps, name: string): void {
  if (deps.sender.mcpServers && !deps.sender.mcpServers.includes(name)) deps.addToBotList(name);
}

function selection(deps: InternalMcpDeps, name: string): string {
  return deps.canUse(name) ? "" : ` Your tool selection leaves ${name} out. The person can change that in your settings.`;
}

/** A secretRef with spaces around it counts as a resupplied key, so it must redeem to the bare value. */
function trimmedRefs(body: Record<string, unknown>): Record<string, unknown> {
  const trim = (value: unknown) => (typeof value === "string" && isSecretRef(value) ? value.trim() : value);
  const each = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item)]))
    : value);
  const oauth = body.oauth && typeof body.oauth === "object" && !Array.isArray(body.oauth) ? body.oauth as Record<string, unknown> : null;
  return {
    ...body,
    ...(body.env !== undefined ? { env: each(body.env) } : {}),
    ...(body.headers !== undefined ? { headers: each(body.headers) } : {}),
    ...(oauth && oauth.clientSecret !== undefined ? { oauth: { ...oauth, clientSecret: trim(oauth.clientSecret) } } : {}),
  };
}

type Line = [ServerLineKey, Readonly<Record<string, string>>?];

function say(deps: InternalMcpDeps, ...lines: Line[]): void {
  const language = deps.language();
  deps.activity(lines.map(([key, params]) => serverLine(language, key, params)).join(" · "));
}

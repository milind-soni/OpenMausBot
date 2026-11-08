import { createHash } from "node:crypto";
import { relative } from "node:path";

import type { McpChangeRequest } from "../../shared/mcp-request.ts";
import type { WireMessage as Message } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { SERVER_PREFIXES } from "../drivers/agents-bridge.ts";
import { MCP_CONFIG_BUSY, runsElsewhere, type McpConfig, type McpConfigRefusal } from "../host/mcp-config.ts";
import { MCP_KEY_EXPIRED, type McpApplied, type McpCardAction, type McpUpdateFields } from "../host/mcp-requests.ts";
import type { BotKept, BotMcpServerAdd } from "../mcp-bot-servers.ts";
import { BOT_STRIPPED_KEYS, botChangeLines, botListing, botMayChange, botServerTarget, isSecretRef, mcpOwner, mergeBotUpdate } from "../mcp-bot-rules.ts";
import type { McpAuthState, McpOAuthManager } from "../mcp-oauth.ts";
import type { McpProbeResult } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseMcpServerMutation, parseStoredMcpServer, type StoredMcpServer, type StoredRemoteMcpServer, type StoredStdioMcpServer } from "../mcp-registry.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { PASS, type RouteHandler } from "./table.ts";

const PATH = "/api/internal/mcp-servers";
const ACTIONS = ["list", "add", "update", "enable", "disable", "restart", "test", "sign_in", "sign_out", "remove"] as const;
type McpAction = (typeof ACTIONS)[number];
const MAX_TOOL_NAMES = 100;

const OWNER_ONLY = "MCP servers are managed by the owner.";
const ASK_ADMIN = "Ask a workspace admin to add it.";

/** When a change reaches the bot's tools: a turn's servers are fixed when it starts, and the person's answer to a card
 * resumes the bot with a new turn that already has them. */
const WHEN = {
  live: { arrive: "The new tools arrive on your next turn.", leave: "Its tools leave on your next turn." },
  approved: { arrive: "Its tools are yours from this turn.", leave: "Its tools are gone from this turn." },
  restart: "This turn keeps talking to the old process; your next turn starts the new code.",
};
const ASKED: Record<McpCardAction, ServerLineKey> = { enable: "server.mcp.askedTurnOn", update: "server.mcp.askedChange", remove: "server.mcp.askedRemove" };

type Applied = "full-access" | "level";

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
  policyRefusal(name: string, server: StoredMcpServer): string | undefined;
  /** A team that uses only the servers its admins add: no server is added from a chat, whoever asks. */
  addRefusal?(): string | undefined;
  signOut(name: string, url: string): Promise<void>;
  /** The person this turn acts for, testing their own connection to a personal server. */
  testAs(name: string, url: string): { oauth: McpOAuthManager; key?: { header: string; value: string } } | null;
  redeem(body: Record<string, unknown>): { ok: true; value: Record<string, unknown>; commit(): void } | { ok: false; error: string };
  addToBotList(name: string): void;
  botAdd(current: Record<string, unknown>, body: unknown): BotMcpServerAdd;
  /** The add path's folder rules for a command server the bot changes. */
  botKeep(server: StoredStdioMcpServer): BotKept;
  ownCwd(): string;
  /** A change applied with no card, for the decision log. */
  decide(summary: string, applied: Applied): void;
  activity(label: string, call: McpCall): void;
  language(): string | undefined;
  /** The other bots that use this server now, by name. */
  usedBy(name: string): string[];
  /** Shows the person a card for a change below Full access; the bot ends its turn and their answer resumes it. */
  requestApproval(proposal: { action: McpCardAction; name: string; subtitle: string; targetHash: string; fields?: McpUpdateFields }): { text: string };
  /** Shows the person a Sign in card for a server reached by URL; the bot ends its turn and OpenMausBot resumes it when
   * they finish or set the card aside. */
  requestSignIn(name: string, server: StoredRemoteMcpServer): { posted: true } | { status: number; error: string };
  /** Whose lent computers this turn may use; null: nobody's. */
  lender?(): string | null;
  /** A server this bot adds that needs the person's own computer, marked as running on the one of theirs lent now
   * (`computer`: the one the bot names, by its name), or why it can't be added yet. */
  place?(server: StoredMcpServer, computer: string | undefined): Promise<{ ok: true; server: StoredMcpServer } | { ok: false; error: string }>;
}

type Deps = Omit<InternalMcpDeps, "readBody">;
/** `approved`: applying what the person allowed on a card, so the turn it resumes already has the change. */
type Ctx = Deps & { approved?: true };

type Outcome = { status: number; text: string; dropped?: string[] } | { status: number; error: string; busy?: true };
/** Which call a line is about, to find that call's own row. */
export type McpCall = { action: McpAction; name?: string };

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

const isMcpServerTool = (name: string) => SERVER_PREFIXES.some((prefix) => name === `${prefix}mcp_server`);
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `"key": "value"` in a call's JSON input preview, however it is spaced. */
const field = (key: string, value: string) => new RegExp(`"${key}"\\s*:\\s*${literal(JSON.stringify(value))}`);

/** The line goes on this call's own open mcp_server row in this turn (in a room, the speaking bot's), so the chat shows one
 * row. Engines start every tool block of a response before running any, so the row is the one whose input names this
 * call's action and server; the newest open row only when none does. With no turn to match, a row is added. */
export function showMcpActivity(
  store: {
    messagesFor(threadId: string): readonly Message[];
    patchMessage(threadId: string, messageId: string, patch: Partial<Message>): unknown;
    appendMessage(threadId: string, message: Omit<Message, "id" | "at">): unknown;
  },
  at: { threadId: string; turnId?: string; from?: { botId: string; name: string; color: string } },
  call: McpCall,
  label: string,
): void {
  const open = at.turnId === undefined ? [] : store.messagesFor(at.threadId).filter((message) => message.kind === "activity"
    && message.turnId === at.turnId && message.tool !== undefined && message.tool.ok === undefined && !message.tool.label
    && isMcpServerTool(message.tool.name) && (!at.from || message.from?.botId === at.from.botId));
  const names = (message: Message) => {
    const input = message.tool?.input ?? "";
    return field("action", call.action).test(input) && (call.name === undefined || field("name", call.name).test(input));
  };
  const row = open.find(names) ?? open.at(-1);
  if (row?.tool) store.patchMessage(at.threadId, row.id, { tool: { ...row.tool, label } });
  else {
    store.appendMessage(at.threadId, {
      role: "bot", kind: "activity", tool: { name: "mcp_server", label, ok: true },
      ...(at.turnId ? { turnId: at.turnId } : {}), ...(at.from ? { from: at.from } : {}),
    });
  }
}

async function act(deps: Ctx, body: unknown, signal: AbortSignal): Promise<Outcome> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "request body must be a JSON object" };
  const { action, name, computer, ...rest } = body as Record<string, unknown>;
  if (!ACTIONS.includes(action as McpAction)) return { status: 400, error: `mcp_server needs action: one of ${ACTIONS.join(", ")}.` };
  if (action === "list") return list(deps);
  if (typeof name !== "string" || !name) return { status: 400, error: `mcp_server ${String(action)} needs name.` };
  const fields = Object.fromEntries(Object.entries(rest).filter(([key]) => !BOT_STRIPPED_KEYS.includes(key)));
  if (action === "add") return add(deps, name, fields, signal, typeof computer === "string" ? computer : undefined);

  const servers = deps.cfg().mcpServers ?? {};
  if (!Object.hasOwn(servers, name)) {
    return { status: 404, error: `${name} ${action === "sign_in" ? "no longer exists" : "doesn't exist"}. Call mcp_server with action list to see the servers.` };
  }
  const parsed = parseStoredMcpServer(name, servers[name]);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const server = parsed.server;
  const owner = mcpOwner(name, server, deps.sender.id, deps.personal());
  const may = botMayChange(owner, server);
  if (action === "sign_in") return signIn(deps, name, server, owner);
  if (action === "test") {
    if (owner === "theirs" && !may.ok) return { status: 403, error: may.error };
    return test(deps, name, server, signal);
  }

  // The person's own answer to the card for a server this bot added turns it on, wherever it runs.
  const theirAnswer = deps.approved === true && action === "enable" && owner === "elsewhere";
  if (!may.ok && !theirAnswer) return { status: 403, error: may.error };
  if (owner === "shared" && !deps.teamAdmin()) return { status: 403, error: ASK_ADMIN };
  if (action === "disable") return disable(deps, name);
  if (action === "restart") return restart(deps, name, server, signal);
  if (action === "sign_out") return signOut(deps, name, server);
  // A deliberate exception to server/direct-apply.ts, which applies a bot's change at every level with Undo: turning an
  // MCP server on runs a command on the person's computer or sends their data to a new service, the kind of action the
  // approval mode governs for shell commands. Turning one off or signing out only lowers what bots can do.
  if (!deps.fullAccess()) return propose(deps, action as McpCardAction, name, server, fields);
  if (action === "update") return update(deps, name, server, fields, signal);
  if (action === "enable") return enable(deps, name, server, signal);
  return remove(deps, name, server);
}

function list(deps: Deps): Outcome {
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
  say(deps, { action: "list" }, ["server.mcp.listed"]);
  return { status: 200, text: `MCP servers you can see (${rows.length}):\n${JSON.stringify(rows)}` };
}

async function add(deps: Deps, name: string, fields: Record<string, unknown>, signal: AbortSignal, computer?: string): Promise<Outcome> {
  const managed = deps.addRefusal?.();
  if (managed) return { status: 403, error: managed };
  if (!deps.teamAdmin()) return { status: 403, error: ASK_ADMIN };
  if (Object.hasOwn(deps.cfg().mcpServers ?? {}, name)) return { status: 409, error: `${name} already exists. Use update, or pick another name.` };
  const redeemed = deps.redeem(trimmedRefs({ name, ...fields }));
  if (!redeemed.ok) return { status: 400, error: redeemed.error };
  const added = deps.botAdd(deps.cfg().mcpServers ?? {}, redeemed.value);
  if (!added.ok) return { status: added.status, error: added.error };
  const placed = deps.place ? await deps.place(added.server, computer) : { ok: true as const, server: added.server };
  if (!placed.ok) return { status: 409, error: placed.error };
  const server = placed.server;
  const saved = deps.config.add(name, server);
  if ("error" in saved) return refused(saved);
  redeemed.commit();
  const where = folderText(deps, server, added.moved ?? []);

  // Security: below Full access, turning on a command server (it runs a program) or a server on the person's own
  // computer needs their yes; a URL server elsewhere only connects to an address.
  if (!deps.fullAccess() && (!isRemoteMcpServer(server) || server.runsOn)) {
    say(deps, { action: "add", name }, ["server.mcp.added", { name }], ["server.mcp.switchedOff"]);
    const card = deps.requestApproval({ action: "enable", name, subtitle: turnOnText(deps, server), targetHash: targetHash(server) });
    return { status: 201, text: `Saved MCP server ${name} switched off.${where} ${card.text}` };
  }
  const on = deps.config.setEnabled(name, true);
  if ("error" in on) {
    const off = refused(on);
    return { status: off.status, error: `Saved ${name}, but it is still off: ${off.error}` };
  }
  joinBotList(deps, name);
  const outcome = await probe(deps, name, server, signal);
  deps.decide(`Added MCP server ${name} and turned it on`, deps.fullAccess() ? "full-access" : "level");
  say(deps, { action: "add", name }, ["server.mcp.added", { name }], ["server.mcp.on"], outcome.line);
  return { status: 201, text: `Added MCP server ${name} and turned it on. ${outcome.text}${selection(deps, name)}${where} ${WHEN.live.arrive}` };
}

/** The update merged onto the saved entry, its secretRefs redeemed but not spent until `commit`. */
function planUpdate(deps: Deps, name: string, existing: StoredMcpServer, fields: Record<string, unknown>):
  { server: StoredMcpServer; dropped: string[]; commit(): void } | { status: number; error: string } {
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
  return { server: parsed.server, dropped, commit: redeemed.commit };
}

async function update(deps: Ctx, name: string, existing: StoredMcpServer, fields: Record<string, unknown>, signal: AbortSignal): Promise<Outcome> {
  const planned = planUpdate(deps, name, existing, fields);
  if ("error" in planned) return planned;
  const { dropped } = planned;
  let server = planned.server;
  let moved: Array<{ from: string; to: string }> = [];
  if (!isRemoteMcpServer(server) && !isRemoteMcpServer(existing) && !sameRun(server, existing)) {
    const kept = deps.botKeep(server);
    if (!kept.ok) return { status: kept.status, error: kept.error };
    ({ server, moved } = kept);
  }
  const saved = deps.config.replace(name, server);
  if ("error" in saved) return refused(saved);
  planned.commit();
  deps.decide(`Changed MCP server ${name}`, "full-access");
  const cleared = dropped.length
    ? ` The destination or OAuth client id changed, so these saved values were cleared: ${dropped.join(", ")}. If it still needs them, ask again with request_credential (delivery ref) and send the secretRef with action update.`
    : "";
  const where = folderText(deps, server, moved);
  const changed: Line[] = [["server.mcp.changed", { name }], ...(dropped.length ? [["server.mcp.keysCleared"] as Line] : [])];
  if (!server.enabled) {
    say(deps, { action: "update", name }, ...changed);
    return { status: 200, text: `Changed MCP server ${name}. It is off.${cleared}${where}`, dropped };
  }
  const outcome = await probe(deps, name, server, signal);
  say(deps, { action: "update", name }, ...changed, outcome.line);
  return { status: 200, text: `Changed MCP server ${name}.${cleared}${where} ${outcome.text} ${when(deps).arrive}`, dropped };
}

async function enable(deps: Ctx, name: string, server: StoredMcpServer, signal: AbortSignal): Promise<Outcome> {
  const on = deps.config.setEnabled(name, true);
  if ("error" in on) return refused(on);
  joinBotList(deps, name);
  const outcome = await probe(deps, name, server, signal);
  deps.decide(`Turned on MCP server ${name}`, "full-access");
  say(deps, { action: "enable", name }, ["server.mcp.turnedOn", { name }], outcome.line);
  return { status: 200, text: `Turned on MCP server ${name}. ${outcome.text}${selection(deps, name)} ${when(deps).arrive}` };
}

function disable(deps: Deps, name: string): Outcome {
  const off = deps.config.setEnabled(name, false);
  if ("error" in off) return refused(off);
  deps.decide(`Turned off MCP server ${name}`, deps.fullAccess() ? "full-access" : "level");
  say(deps, { action: "disable", name }, ["server.mcp.turnedOff", { name }]);
  return { status: 200, text: `Turned off MCP server ${name}. ${WHEN.live.leave}` };
}

/** Runs what is already on, as the next turn would anyway, so it takes no card at any level. */
async function restart(deps: Deps, name: string, server: StoredMcpServer, signal: AbortSignal): Promise<Outcome> {
  if (isRemoteMcpServer(server)) return { status: 400, error: `${name} is reached by its address, so it has no process to restart. Call mcp_server with action test to check it.` };
  if (!server.enabled) return { status: 403, error: `${name} is off. Call mcp_server with action enable ${deps.fullAccess() ? "first" : "to ask the person to turn it on"}.` };
  const restarted = deps.config.restart(name);
  if ("error" in restarted) return refused(restarted);
  const outcome = await probe(deps, name, server, signal);
  deps.decide(`Restarted MCP server ${name}`, deps.fullAccess() ? "full-access" : "level");
  say(deps, { action: "restart", name }, ["server.mcp.restarted", { name }], outcome.line);
  return { status: 200, text: `Restarted MCP server ${name}. Its saved keys stay. ${outcome.text} ${WHEN.restart}` };
}

/** A sign-in is the person's own act, so it takes a card at every level; a personal server's card signs in the turn's
 * person. */
function signIn(deps: Deps, name: string, server: StoredMcpServer, owner: ReturnType<typeof mcpOwner>): Outcome {
  if (server.runsOn) return { status: 409, error: runsElsewhere(server.runsOn) };
  if (!isRemoteMcpServer(server)) return { status: 400, error: "Only servers reached by URL can be signed in to." };
  if (owner === "shared" && !deps.teamAdmin()) return { status: 403, error: `Ask a workspace admin to sign in to ${name}.` };
  if (!server.enabled) {
    return { status: 403, error: `${name} is off. Call mcp_server with action enable ${deps.fullAccess() ? "first" : "to ask the person to turn it on"}.` };
  }
  if (owner === "shared" && deps.authState(name, server.url) === "signed-in") {
    return { status: 200, text: `${name} is already signed in. Call mcp_server with action test to check it.` };
  }
  const card = deps.requestSignIn(name, server);
  if ("error" in card) return card;
  say(deps, { action: "sign_in", name }, ["server.mcp.askedSignIn", { name }]);
  return { status: 202, text: `A Sign in card for ${name} is now visible to the person. End this turn and wait; OpenMausBot resumes you when they finish.` };
}

async function signOut(deps: Deps, name: string, server: StoredMcpServer): Promise<Outcome> {
  if (!isRemoteMcpServer(server)) return { status: 400, error: `${name} runs a command, so it has no sign-in.` };
  await deps.signOut(name, server.url);
  deps.decide(`Signed out of MCP server ${name}`, deps.fullAccess() ? "full-access" : "level");
  say(deps, { action: "sign_out", name }, ["server.mcp.signedOut", { name }]);
  return { status: 200, text: `Signed out of MCP server ${name}. It stays ${server.enabled ? "on" : "off"}; call mcp_server with action sign_in to sign in again.` };
}

function remove(deps: Ctx, name: string, server: StoredMcpServer): Outcome {
  const refusal = deps.policyRefusal(name, server);
  if (refusal) return { status: 403, error: refusal };
  const gone = deps.config.remove(name);
  if ("error" in gone) return refused(gone);
  deps.decide(`Removed MCP server ${name}`, "full-access");
  say(deps, { action: "remove", name }, ["server.mcp.removed", { name }]);
  return { status: 200, text: `Removed MCP server ${name}, its saved keys and its sign-in. ${when(deps).leave}` };
}

/** Runs a change the person allowed on its card as Full access would, against the server as it is now, so a proposal
 * made before a newer change never overwrites it. */
export async function applyMcpChange(deps: Deps, request: Pick<McpChangeRequest, "action" | "name" | "targetHash">, fields?: McpUpdateFields): Promise<McpApplied> {
  const { name } = request;
  const language = deps.language();
  const servers = deps.cfg().mcpServers ?? {};
  if (!Object.hasOwn(servers, name)) return { state: "failed", text: `${name} no longer exists.`, note: serverLine(language, "server.mcp.card.gone", { name }) };
  const parsed = parseStoredMcpServer(name, servers[name]);
  if (parsed.ok && targetHash(parsed.server) !== request.targetHash) {
    return { state: "failed", text: `${name} changed since you were asked, so nothing was applied.`, note: serverLine(language, "server.mcp.card.changedSince", { name }) };
  }
  if (fields && !deps.redeem(trimmedRefs(fields)).ok) return { state: "expired", text: MCP_KEY_EXPIRED, note: serverLine(language, "server.mcp.card.keyExpired") };
  const approved: Ctx = { ...deps, approved: true, fullAccess: () => true, teamAdmin: () => true, decide: () => {}, activity: () => {} };
  const outcome = await act(approved, { ...fields, action: request.action, name }, new AbortController().signal);
  if ("error" in outcome) return outcome.busy ? { state: "busy" } : { state: "failed", text: outcome.error };
  return { state: "applied", text: outcome.text };
}

/** What a card's answer must still find: a different address or command is a different server. */
const targetHash = (server: StoredMcpServer) => createHash("sha256").update(botServerTarget(server)).digest("hex");

function propose(deps: Deps, action: McpCardAction, name: string, server: StoredMcpServer, fields: Record<string, unknown>): Outcome {
  if (action === "update") {
    const planned = planUpdate(deps, name, server, fields);
    if ("error" in planned) return planned;
    const refusal = deps.policyRefusal(name, planned.server);
    if (refusal) return { status: 403, error: refusal };
    const { lines, keys, clientSecret } = botChangeLines(server, planned.server, fields);
    if (!lines.length && !keys.length && !clientSecret && !planned.dropped.length) return { status: 200, text: `${name} already has these settings, so nothing changed.` };
    const language = deps.language();
    const subtitle = [...lines, ...keys.map((key) => serverLine(language, "server.mcp.card.newKey", { key })),
      ...(clientSecret ? [serverLine(language, "server.mcp.card.newClientSecret")] : []),
      ...(planned.dropped.length ? [serverLine(language, "server.mcp.card.cleared", { items: planned.dropped.join(", ") })] : [])].join("\n");
    return ask(deps, { action, name, subtitle, targetHash: targetHash(server), fields });
  }
  const refusal = deps.policyRefusal(name, server);
  if (refusal) return { status: 403, error: refusal };
  if (action === "remove") {
    const others = deps.usedBy(name);
    const language = deps.language();
    return ask(deps, { action, name, targetHash: targetHash(server), subtitle: others.length
      ? serverLine(language, "server.mcp.card.usedBy", { names: others.join(", ") }) : serverLine(language, "server.mcp.card.usedByNone") });
  }
  if (server.enabled && (!deps.sender.mcpServers || deps.sender.mcpServers.includes(name))) return { status: 200, text: `${name} is already on.` };
  return ask(deps, { action, name, subtitle: turnOnText(deps, server), targetHash: targetHash(server) });
}

function ask(deps: Deps, proposal: Parameters<Deps["requestApproval"]>[0]): Outcome {
  const card = deps.requestApproval(proposal);
  say(deps, { action: proposal.action, name: proposal.name }, [ASKED[proposal.action], { name: proposal.name }]);
  return { status: 202, text: card.text };
}

function turnOnText(deps: Deps, server: StoredMcpServer): string {
  const where = server.runsOn ? serverLine(deps.language(), "server.mcp.card.elsewhere", { computer: server.runsOn.label })
    : serverLine(deps.language(), isRemoteMcpServer(server) ? "server.mcp.card.internet" : "server.mcp.card.local");
  return `${botServerTarget(server)}\n${where}`;
}

const when = (deps: Ctx) => (deps.approved ? WHEN.approved : WHEN.live);

async function test(deps: Deps, name: string, server: StoredMcpServer, signal: AbortSignal): Promise<Outcome> {
  if (!server.enabled && !deps.fullAccess()) {
    return { status: 403, error: `${name} is off, and testing it would start it. Call mcp_server with action enable to ask the person to turn it on.` };
  }
  const outcome = await probe(deps, name, server, signal);
  say(deps, { action: "test", name }, ["server.mcp.tested", { name }], outcome.line);
  return { status: 200, text: `MCP server ${name}: ${outcome.text}` };
}

async function probe(deps: Deps, name: string, server: StoredMcpServer, signal: AbortSignal): Promise<{ text: string; line: Line }> {
  const result = await deps.config.test(name, {
    signal,
    asBot: { id: deps.sender.id, cwd: deps.ownCwd() },
    person: (url) => deps.testAs(name, url),
    lender: deps.lender?.() ?? null,
  });
  if ("error" in result) return { text: `Not tested: ${result.error}`, line: ["server.mcp.testFailed"] };
  const probed = result.body as McpProbeResult;
  if (probed.ok) {
    const names = probed.tools.slice(0, MAX_TOOL_NAMES).map((tool) => tool.name);
    const total = probed.total ?? probed.tools.length;
    const more = total > names.length ? ` and ${total - names.length} more` : "";
    return {
      text: names.length ? `Test: it started and listed its tools: ${names.join(", ")}${more}. That does not show what they return: call one to check.` : "Test: it started, but it has no tools.",
      line: [total === 1 ? "server.mcp.testTools.one" : "server.mcp.testTools.many", { count: String(total) }],
    };
  }
  if (probed.auth === "required") {
    return { text: `Test: needs sign-in. Call mcp_server with action sign_in and name ${name}, then end your turn.`, line: ["server.mcp.testSignIn"] };
  }
  if (probed.reason === "keys") {
    const keys = isRemoteMcpServer(server) ? Object.keys(server.headers) : Object.keys(server.env);
    return {
      text: `Test: needs a key${keys.length ? ` (${keys.join(", ")})` : ""}. Ask for it with request_credential (delivery ref) and send the secretRef with action update. Tell the person they can enter it on the computer or an iPhone.`,
      line: ["server.mcp.testKey"],
    };
  }
  return { text: `Test: failed. ${probed.error}`, line: ["server.mcp.testFailed"] };
}

function refused(result: McpConfigRefusal): { status: number; error: string; busy?: true } {
  return result.error === MCP_CONFIG_BUSY ? { status: result.status, error: `${result.error} Try again in a moment.`, busy: true } : { status: result.status, error: result.error };
}

/** Same command, arguments and environment: nothing a bot's folder rules judge has changed. */
function sameRun(a: StoredStdioMcpServer, b: StoredStdioMcpServer): boolean {
  const env = (server: StoredStdioMcpServer) => JSON.stringify(Object.entries(server.env).sort(([x], [y]) => x.localeCompare(y)));
  return a.command === b.command && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i]) && env(a) === env(b);
}

function joinBotList(deps: Deps, name: string): void {
  if (deps.sender.mcpServers && !deps.sender.mcpServers.includes(name)) deps.addToBotList(name);
}

function selection(deps: Deps, name: string): string {
  return deps.canUse(name) ? "" : ` Your tool selection leaves ${name} out. The person can change that in your settings.`;
}

function folderText(deps: Deps, server: StoredMcpServer, moved: ReadonlyArray<{ to: string }>): string {
  const elsewhere = server.runsOn ? ` It runs on ${server.runsOn.label}, the person's own computer, and its tools reach you through it while it is online.` : "";
  if (isRemoteMcpServer(server)) return elsewhere;
  return elsewhere + (server.bot ? " It uses files in your own folder, so it works only for you, not for other bots." : "")
    + (moved.length ? ` Its files were in this conversation's temporary folder, so they were copied to ${moved.map(({ to }) => relative(deps.ownCwd(), to)).join(", ")} in your own folder, and it runs from there: change them there.` : "");
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

function say(deps: Deps, call: McpCall, ...lines: Line[]): void {
  const language = deps.language();
  deps.activity(lines.map(([key, params]) => serverLine(language, key, params)).join(" · "), call);
}

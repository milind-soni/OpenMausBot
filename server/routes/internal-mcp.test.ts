import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createMcpConfig, type McpConfigDeps } from "../host/mcp-config.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { addBotMcpServer, keepForBot } from "../mcp-bot-servers.ts";
import { botListing, mcpOwner } from "../mcp-bot-rules.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import * as probeModule from "../mcp-probe.ts";
import { listMcpServers, parseStoredMcpServer, type StoredMcpServer } from "../mcp-registry.ts";
import { SecretVault } from "../secret-vault.ts";
import type { OptionCardData, WireMessage } from "../../shared/wire.ts";
import type { BotRecord } from "../store.ts";
import { McpRequestService } from "../host/mcp-requests.ts";
import { applyMcpChange, createInternalMcpRoutes, otherBotsGiven, showMcpActivity, type InternalMcpDeps } from "./internal-mcp.ts";
import { PASS, type RouteContext } from "./table.ts";

const BOT = "kiwi";
const THREAD = "thread-1";
const MAC = { environmentId: "env-mac", label: "Ada's Mac" };
const OWNER_ONLY = "MCP servers are managed by the owner.";
const ASK_ADMIN = "Ask a workspace admin to add it.";

const linear = { type: "http", url: "https://mcp.linear.app/mcp", headers: {}, enabled: true };
const notes = { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "saved-token" }, enabled: true };
const PATH_TOKEN = "Zk9QxW2mT7aBcD4eF6gH8jK1";
const USER_TOKEN = "tok3n9876userinfo";
const zapier = { type: "http", url: `https://mcp.zapier.com/api/mcp/s/${PATH_TOKEN}/mcp`, headers: { "X-Api-Key": "zap-header-value" }, enabled: true };
const userinfo = `https://ada:${USER_TOKEN}@mcp.example.com/mcp-server-production/mcp`;
/** The fixture's DNS: a public name, a name on the person's network, and one that resolves to both. Others fail. */
const DNS: Record<string, string[]> = { "mcp.linear.app": ["34.117.59.81"], "intranet.example": ["10.0.0.5"], "split.example": ["34.117.59.81", "192.168.1.9"] };

interface Options {
  full?: boolean;
  guest?: boolean;
  admin?: boolean;
  personal?: string[];
  mcpServers?: string[];
  leftOut?: string[];
  servers?: Record<string, unknown>;
  refuse?: (name: string) => string | undefined;
  boxed?: boolean;
  usedBy?: Record<string, string[]>;
  signInRefusal?: { status: number; error: string };
  /** Lending: how a server on another computer is tested there, whose computers this turn may use, and where an added
   * server that needs the person's computer runs. */
  testElsewhere?: McpConfigDeps["testElsewhere"];
  lender?: string | null;
  place?: InternalMcpDeps["place"];
}

function fixture(options: Options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-internal-mcp-"));
  const cfg: Pick<AppConfig, "mcpServers" | "postiz"> = { mcpServers: structuredClone(options.servers ?? {}) };
  const mcpOAuth = new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json") });
  let busy = false;
  const config = createMcpConfig({
    cfg, sessions: { isLive: () => true }, mcpOAuth,
    teamConnections: { personMcp: () => options.personal ?? [], people: {} as TeamConnectionsHost["people"] },
    cloudHome: null, fallbackPublicUrl: null,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpServerResponse: () => ({ servers: listMcpServers(cfg.mcpServers) }),
    mcpPolicyRefusal: (name) => options.refuse?.(name),
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    savedCustomDomain: () => null,
    changed: () => {},
    ...(options.testElsewhere ? { testElsewhere: options.testElsewhere } : {}),
  });
  let clock = Date.now();
  const vault = new SecretVault(() => clock);
  const owner = { botId: BOT, threadId: THREAD };
  const sender = { id: BOT, ...(options.mcpServers ? { mcpServers: [...options.mcpServers] } : {}), toolScope: undefined as unknown };
  const listedOn: Array<{ bot: string; name: string }> = [];
  const decided: Array<{ summary: string; applied: string }> = [];
  const lines: string[] = [];
  const chat: Array<{ id: string; kind: "options"; card: OptionCardData }> = [];
  const answers: string[] = [];
  const decisions: string[] = [];
  const signIns: Array<{ name: string; url: string }> = [];
  const service = () => new McpRequestService({
    store: {
      messagesFor: () => chat,
      appendMessage: (_threadId, message) => { const row = { ...message, id: `card-${chat.length + 1}` }; chat.push(row); return row; },
      patchMessage: (_threadId, id, patch) => { const row = chat.find((item) => item.id === id); if (row) row.card = patch.card; },
    },
    teamCloud: false,
    apply: (request, fields) => applyMcpChange(deps, request, fields),
    answer: (_threadId, _messageId, text) => { answers.push(text); return true; },
    decide: (row) => { decisions.push(row.decision); },
  });
  let cards = service();
  let body: unknown = {};
  const deps: InternalMcpDeps = {
    readBody: async () => body as Record<string, unknown>,
    sender, threadId: THREAD,
    fullAccess: () => options.full ?? true,
    guestDriven: () => options.guest ?? false,
    teamAdmin: () => options.admin ?? true,
    canUse: (name) => !options.leftOut?.includes(name),
    config, cfg: () => cfg as AppConfig,
    personal: () => options.personal ?? [],
    authState: (name, url) => mcpOAuth.authState(name, url),
    managedBy: (name) => options.refuse?.(name) ? "Acme IT" : undefined,
    policyRefusal: (name) => options.refuse?.(name),
    signOut: (name, url) => mcpOAuth.signOut(name, url),
    testAs: () => null,
    redeem: (raw) => vault.redeem(raw, owner, (path) => path.length === 2 && (path[0] === "env" || path[0] === "headers" || (path[0] === "oauth" && path[1] === "clientSecret")), "mcp_server's env, headers and oauth.clientSecret"),
    addToBotList: (name) => { listedOn.push({ bot: sender.id, name }); },
    botAdd: (current, raw) => addBotMcpServer(current, raw, BOT, dataDir, options.boxed ?? false),
    botKeep: (server) => keepForBot(server, BOT, dataDir, options.boxed ?? false),
    ownCwd: () => dataDir,
    decide: (summary, applied) => { decided.push({ summary, applied }); },
    activity: (label) => { lines.push(label); },
    language: () => undefined,
    usedBy: (name) => options.usedBy?.[name] ?? [],
    requestApproval: ({ action, name, subtitle, targetHash, fields }) => cards.propose({ action, name, botId: BOT, threadId: THREAD, targetHash }, subtitle, fields),
    requestSignIn: (name, server) => {
      if (options.signInRefusal) return options.signInRefusal;
      signIns.push({ name, url: server.url });
      return { posted: true };
    },
    ...(options.lender !== undefined ? { lender: () => options.lender ?? null } : {}),
    ...(options.place ? { place: options.place } : {}),
    lookupHost: async (host) => {
      const addresses = DNS[host];
      if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return addresses.map((address) => ({ address }));
    },
  };
  const route = createInternalMcpRoutes(deps);
  const ref = (value: string) => vault.saveRef(owner, `card-${value}`, "Key", value);

  async function call(method: "GET" | "POST", payload: unknown = {}) {
    body = payload;
    const json = vi.fn();
    const res = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse;
    const ctx: RouteContext = {
      req: {} as IncomingMessage, res, path: "/api/internal/mcp-servers", method, url: new URL("http://fixture.invalid/api/internal/mcp-servers"),
      auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: vi.fn(async () => payload), json,
    };
    const out = await route(ctx);
    expect(out).not.toBe(PASS);
    expect(json).toHaveBeenCalledOnce();
    const [, status, sent] = json.mock.calls[0]!;
    return { status: status as number, body: sent as { text?: string; error?: string; dropped?: string[] } };
  }
  const post = (payload: Record<string, unknown>) => call("POST", payload);
  const stored = (name: string): StoredMcpServer | undefined => {
    const raw = cfg.mcpServers?.[name];
    if (raw === undefined) return undefined;
    const parsed = parseStoredMcpServer(name, raw);
    return parsed.ok ? parsed.server : undefined;
  };
  const setBusy = (value: boolean) => { busy = value; };
  const card = () => chat.at(-1)?.card;
  const respond = (behavior: "allow" | "deny") => cards.respond({ botId: BOT, threadId: THREAD, requestId: card()!.requestId!, behavior }, true);
  const later = (ms: number) => { clock += ms; };
  /** A fresh request service over the same chat, as after OpenMausBot restarts. */
  const restart = () => { cards = service(); };
  return { cfg, config, mcpOAuth, deps, sender, call, post, stored, ref, listedOn, decided, lines, dataDir, setBusy, chat, card, respond, answers, decisions, later, signIns, restart };
}

async function createInternalMcpRoutesCall(deps: InternalMcpDeps, payload: Record<string, unknown>) {
  const json = vi.fn();
  const res = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse;
  await createInternalMcpRoutes({ ...deps, readBody: async () => payload })({
    req: {} as IncomingMessage, res, path: "/api/internal/mcp-servers", method: "POST", url: new URL("http://fixture.invalid/api/internal/mcp-servers"),
    auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: vi.fn(async () => payload), json,
  });
  const [, status, body] = json.mock.calls[0]!;
  return { status, body };
}

function probeWith(result: probeModule.McpProbeResult) {
  return vi.spyOn(probeModule, "probeMcpServer").mockResolvedValue(result);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("internal mcp_server restart", () => {
  it("restarts a command server at any level, keeping its saved keys, spending no secretRef and saying what the test showed", async () => {
    probeWith({ ok: true, tools: [{ name: "read_mail" }] });
    for (const full of [true, false]) {
      const { post, stored, cfg, decided, lines, chat, ref } = fixture({ full, servers: { notes } });
      const key = ref("spare-key");
      const before = structuredClone(cfg.mcpServers);
      const { status, body } = await post({ action: "restart", name: "notes" });
      expect(status).toBe(200);
      expect(body.text).toBe("Restarted MCP server notes. Its saved keys stay. Test: it started and listed its tools: read_mail. That does not show what they return: call one to check. This turn keeps talking to the old process; your next turn starts the new code.");
      expect(cfg.mcpServers).toEqual(before);
      expect(stored("notes")).toMatchObject({ env: { NOTES_TOKEN: "saved-token" }, enabled: true });
      expect(chat, "no card: it runs what is already on").toEqual([]);
      expect(decided).toEqual([{ summary: "Restarted MCP server notes", applied: full ? "full-access" : "level" }]);
      expect(lines.at(-1)).toContain("Restarted MCP server notes");
      expect((await post({ action: "update", name: "notes", env: { NOTES_TOKEN: key } })).status, "the unused ref still works").not.toBe(400);
    }
  });

  it("a secretRef still works once, after a restart like any other time", async () => {
    probeWith({ ok: true, tools: [{ name: "read_mail" }] });
    const { post, ref } = fixture();
    const key = ref("the-password");
    expect((await post({ action: "add", name: "mail", command: "mail-mcp", env: { PASSWORD: key } })).status).toBe(201);
    expect((await post({ action: "restart", name: "mail" })).status).toBe(200);
    const again = await post({ action: "add", name: "mail2", command: "mail-mcp", env: { PASSWORD: key } });
    expect(again.status).toBe(400);
    expect(again.body.error).toContain("was already used");
  });

  it("refuses what has no process to restart here", async () => {
    probeWith({ ok: true, tools: [] });
    const { post } = fixture({ servers: { linear, notes: { ...notes, enabled: false }, away: { ...notes, runsOn: MAC } } });
    expect(await post({ action: "restart", name: "linear" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("has no process to restart") } });
    expect(await post({ action: "restart", name: "notes" })).toMatchObject({ status: 403, body: { error: "notes is off. Call mcp_server with action enable first." } });
    expect((await post({ action: "restart", name: "away" })).status, "on another computer").toBe(403);
    expect((await post({ action: "restart", name: "missing" })).status).toBe(404);
  });

  it("is an admin's on a team's shared server, and a guest's turn gets nothing", async () => {
    probeWith({ ok: true, tools: [] });
    expect(await fixture({ admin: false, servers: { notes } }).post({ action: "restart", name: "notes" })).toMatchObject({ status: 403, body: { error: ASK_ADMIN } });
    expect(await fixture({ guest: true, servers: { notes } }).post({ action: "restart", name: "notes" })).toMatchObject({ status: 403, body: { error: OWNER_ONLY } });
  });

  it("says plainly that a test only proves the server started", async () => {
    probeWith({ ok: true, tools: [] });
    const { post } = fixture({ servers: { notes } });
    expect((await post({ action: "test", name: "notes" })).body.text).toBe("MCP server notes: Test: it started, but it has no tools.");
  });
});

describe("internal mcp_server route, Full access", () => {
  it("add saves the server on, tests it as the bot and returns the tool names", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "search_notes" }, { name: "create_note" }] });
    const { post, stored, dataDir, decided, lines } = fixture();
    const { status, body } = await post({ action: "add", name: "notes", command: "notes-mcp", args: ["--stdio"] });
    expect(status).toBe(201);
    expect(stored("notes")).toMatchObject({ command: "notes-mcp", args: ["--stdio"], enabled: true });
    expect(probe.mock.calls[0]?.[3]).toMatchObject({ asBot: { id: BOT, cwd: dataDir } });
    expect(body.text).toContain("search_notes, create_note");
    expect(body.text).toContain("The new tools arrive on your next turn.");
    expect(decided).toEqual([{ summary: "Added MCP server notes and turned it on", applied: "full-access" }]);
    expect(lines).toEqual(["Added MCP server notes · Turned on · Test: 2 tools"]);
  });

  it("add of a server other bots get too tells the person which bots, and where to switch it off for one", async () => {
    probeWith({ ok: true, tools: [{ name: "search_notes" }] });
    const { post, lines } = fixture({ usedBy: { notes: ["Clive", "Mo"] } });
    const { status, body } = await post({ action: "add", name: "notes", command: "notes-mcp" });
    expect(status).toBe(201);
    expect(body.text).toContain("It is on for your other bots too: Clive and Mo. Tell the person that, and that they can switch it off for one bot in that bot's settings, under Apps it can use.");
    expect(lines).toEqual(["Added MCP server notes · Turned on · Test: 1 tool · Also on for Clive, Mo: switch it off for one in its settings, under Apps it can use"]);
  });

  it("add of a server no other bot gets says nothing about other bots", async () => {
    probeWith({ ok: true, tools: [{ name: "search_notes" }] });
    const { post, lines } = fixture();
    const { body } = await post({ action: "add", name: "notes", command: "notes-mcp" });
    expect(body.text).not.toContain("other bots");
    expect(lines).toEqual(["Added MCP server notes · Turned on · Test: 1 tool"]);
  });

  it("enable of a server other bots get too tells the person which bots, and where to switch it off for one", async () => {
    probeWith({ ok: true, tools: [{ name: "search" }] });
    const { post, lines } = fixture({ servers: { linear: { ...linear, enabled: false } }, usedBy: { linear: ["Clive"] } });
    const { status, body } = await post({ action: "enable", name: "linear" });
    expect(status).toBe(200);
    expect(body.text).toContain("It is on for your other bots too: Clive.");
    expect(lines).toEqual(["Turned on MCP server linear · Test: 1 tool · Also on for Clive: switch it off for one in its settings, under Apps it can use"]);
  });

  it("enable of a server that was already on for everyone, joining only this bot's list, says nothing about other bots", async () => {
    probeWith({ ok: true, tools: [{ name: "search" }] });
    const { post, lines } = fixture({ servers: { linear }, mcpServers: [], usedBy: { linear: ["Clive"] } });
    const { status, body } = await post({ action: "enable", name: "linear" });
    expect(status).toBe(200);
    expect(body.text).not.toContain("other bots");
    expect(lines).toEqual(["Turned on MCP server linear · Test: 1 tool"]);
  });

  it("add of an OAuth server returns \"needs sign-in\" and tells the bot to call sign_in", async () => {
    probeWith({ ok: false, error: probeModule.SIGN_IN_REQUIRED, auth: "required" });
    const { post, stored, mcpOAuth, lines } = fixture();
    const { status, body } = await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" });
    expect(status).toBe(201);
    expect(stored("linear")).toMatchObject({ enabled: true });
    expect(body.text).toContain("needs sign-in");
    expect(body.text).toMatch(/action sign_in/);
    expect(mcpOAuth.authState("linear", "https://mcp.linear.app/mcp")).toBe("needs-sign-in");
    expect(lines).toEqual(["Added MCP server linear · Turned on · Test: needs sign-in"]);
  });

  it("add puts the name on the bot's explicit mcpServers list and on no other bot's", async () => {
    probeWith({ ok: true, tools: [] });
    const listed = fixture({ mcpServers: ["github"] });
    await listed.post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" });
    expect(listed.listedOn).toEqual([{ bot: BOT, name: "linear" }]);

    const everyServer = fixture();
    await everyServer.post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" });
    expect(everyServer.listedOn).toEqual([]);
  });

  it("update merges, and an args change returns dropped with the env key name", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "search_notes" }] });
    const { post, stored } = fixture({ servers: { notes } });
    const { status, body } = await post({ action: "update", name: "notes", args: ["-y", "notes-mcp@2"] });
    expect(status).toBe(200);
    expect(stored("notes")).toMatchObject({ command: "npx", args: ["-y", "notes-mcp@2"], env: {}, enabled: true });
    expect(body.dropped).toEqual(["env NOTES_TOKEN"]);
    expect(body.text).toContain("NOTES_TOKEN");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("update that keeps the destination keeps the saved secrets", async () => {
    probeWith({ ok: true, tools: [] });
    const { post, stored } = fixture({ servers: { notes } });
    const { body } = await post({ action: "update", name: "notes", resultBudget: 5000 });
    expect(stored("notes")).toMatchObject({ env: { NOTES_TOKEN: "saved-token" }, resultBudget: 5000 });
    expect(body.dropped).toBeUndefined();
  });

  it("a new address drops the sign-in only when there was one to drop", async () => {
    probeWith({ ok: true, tools: [] });
    const signedIn = fixture({ servers: { linear } });
    signedIn.mcpOAuth.adopt("linear", linear.url, { url: linear.url, state: "signed-in", tokens: { access: "token" } });
    const moved = await signedIn.post({ action: "update", name: "linear", url: "https://mcp.linear.app/v2" });
    expect(moved.body.dropped).toEqual(["sign-in"]);
    expect(signedIn.mcpOAuth.authState("linear", "https://mcp.linear.app/v2")).toBe("none");

    const never = fixture({ servers: { linear } });
    const quiet = await never.post({ action: "update", name: "linear", url: "https://mcp.linear.app/v2" });
    expect(quiet.body.dropped).toBeUndefined();
  });

  it("enable then disable round-trips; disable applies when not Full access", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "search" }] });
    const full = fixture({ servers: { linear: { ...linear, enabled: false } } });
    expect((await full.post({ action: "enable", name: "linear" })).status).toBe(200);
    expect(full.stored("linear")?.enabled).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect((await full.post({ action: "disable", name: "linear" })).status).toBe(200);
    expect(full.stored("linear")?.enabled).toBe(false);

    const ask = fixture({ full: false, servers: { linear } });
    const off = await ask.post({ action: "disable", name: "linear" });
    expect(off.status).toBe(200);
    expect(ask.stored("linear")?.enabled).toBe(false);
  });

  it("sign_out applies when not Full access", async () => {
    const { post, mcpOAuth } = fixture({ full: false, servers: { linear } });
    mcpOAuth.adopt("linear", linear.url, { url: linear.url, state: "signed-in", tokens: { access: "token" } });
    const { status } = await post({ action: "sign_out", name: "linear" });
    expect(status).toBe(200);
    expect(mcpOAuth.authState("linear", linear.url)).toBe("none");
  });

  it("test runs with asBot and is refused on a server that is off when not Full access", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "search" }] });
    const full = fixture({ servers: { notes: { ...notes, enabled: false } } });
    const tested = await full.post({ action: "test", name: "notes" });
    expect(tested.status).toBe(200);
    expect(tested.body.text).toContain("search");
    expect(probe.mock.calls[0]?.[3]).toMatchObject({ asBot: { id: BOT, cwd: full.dataDir } });

    probe.mockClear();
    const ask = fixture({ full: false, servers: { notes: { ...notes, enabled: false }, linear } });
    expect((await ask.post({ action: "test", name: "notes" })).status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
    expect((await ask.post({ action: "test", name: "linear" })).status).toBe(200);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("remove deletes the server and forgets its sign-in", async () => {
    const { post, cfg, mcpOAuth } = fixture({ servers: { linear } });
    mcpOAuth.adopt("linear", linear.url, { url: linear.url, state: "signed-in", tokens: { access: "token" } });
    const { status, body } = await post({ action: "remove", name: "linear" });
    expect(status).toBe(200);
    expect(cfg.mcpServers).toEqual({});
    expect(mcpOAuth.authState("linear", linear.url)).toBe("none");
    expect(body.text).toContain("linear");
  });

  it("refuses another bot's own server for every change and for test", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const theirs = { ...notes, bot: "scout" };
    const { post, stored } = fixture({ servers: { notes: theirs } });
    for (const action of ["update", "enable", "disable", "sign_out", "remove", "test"]) {
      const out = await post({ action, name: "notes", args: ["x"] });
      expect(out, action).toEqual({ status: 403, body: { error: "That server belongs to another bot." } });
    }
    expect(stored("notes")).toMatchObject({ args: ["-y", "notes-mcp"], enabled: true, bot: "scout" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a Team Cloud personal server for changes", async () => {
    const { post, stored } = fixture({ servers: { linear }, personal: ["linear"] });
    for (const action of ["update", "enable", "disable", "remove"]) {
      const out = await post({ action, name: "linear", url: "https://elsewhere.example/mcp" });
      expect(out, action).toEqual({ status: 403, body: { error: "This connection is each person's own. Change it in Settings." } });
    }
    expect(stored("linear")).toMatchObject({ url: linear.url, enabled: true });
  });

  it("never changes, turns on or removes a server that runs on another computer, and never starts it here", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, stored, cfg } = fixture({ servers: { notes: { ...notes, enabled: false, runsOn: MAC } } });
    const before = structuredClone(cfg.mcpServers);
    for (const change of [{ action: "enable" }, { action: "disable" }, { action: "update", command: "evil", args: [] }, { action: "remove" }]) {
      expect(await post({ ...change, name: "notes" })).toEqual({ status: 403, body: { error: "This server runs on Ada's Mac, so it can't be changed here." } });
    }
    expect(cfg.mcpServers).toEqual(before);
    expect(stored("notes")?.enabled).toBe(false);
    expect((await post({ action: "test", name: "notes" })).body.text).toBe("MCP server notes: Not tested: This server runs on Ada's Mac, so it isn't started here.");
    expect(probe).not.toHaveBeenCalled();
  });

  it("tests a server that runs on another computer there, for the person this turn acts for", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const testElsewhere = vi.fn<NonNullable<McpConfigDeps["testElsewhere"]>>(async () => ({ status: 200, body: { ok: true, tools: [{ name: "search_notes" }] } }));
    const { post } = fixture({ servers: { notes: { ...notes, runsOn: MAC } }, testElsewhere, lender: "cloud-home" });
    expect((await post({ action: "test", name: "notes" })).body.text).toBe("MCP server notes: Test: it started and listed its tools: search_notes. That does not show what they return: call one to check.");
    expect(testElsewhere).toHaveBeenCalledWith("notes", expect.objectContaining({ command: "npx", runsOn: MAC }), "cloud-home", expect.any(AbortSignal));
    expect(probe).not.toHaveBeenCalled();

    testElsewhere.mockResolvedValueOnce({ status: 409, error: "notes runs on your Mac (Ada's Mac), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off." });
    const offline = await post({ action: "test", name: "notes" });
    expect(offline.body.text).toBe("MCP server notes: Not tested: notes runs on your Mac (Ada's Mac), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off.");
    expect(offline.body.text).not.toContain("Could not reach");
  });

  it("a server the bot adds that needs the person's computer is marked as running there, and the person's card turns it on", async () => {
    probeWith({ ok: true, tools: [] });
    const testElsewhere = vi.fn<NonNullable<McpConfigDeps["testElsewhere"]>>(async () => ({ status: 200, body: { ok: true, tools: [{ name: "search_notes" }] } }));
    const place = vi.fn<NonNullable<InternalMcpDeps["place"]>>(async (server) => ({ ok: true, server: { ...server, runsOn: MAC } }));
    const { post, stored, card, respond, chat } = fixture({ full: false, testElsewhere, lender: "cloud-home", place });
    const added = await post({ action: "add", name: "local", type: "http", url: "http://127.0.0.1:19501/mcp" });
    expect(added.status).toBe(201);
    expect(added.body.text).toContain("It runs on Ada's Mac, the person's own computer, and its tools reach you through it while it is online.");
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ url: "http://127.0.0.1:19501/mcp" }), undefined);
    expect(stored("local")).toMatchObject({ url: "http://127.0.0.1:19501/mcp", enabled: false, runsOn: MAC });
    expect(card()?.subtitle).toBe("http://127.0.0.1:19501/mcp\nRuns on Ada's Mac.");
    expect(chat).toHaveLength(1);
    expect((await respond("allow"))?.status).toBe(200);
    expect(stored("local")?.enabled).toBe(true);
    expect(testElsewhere).toHaveBeenCalledWith("local", expect.objectContaining({ runsOn: MAC }), "cloud-home", expect.any(AbortSignal));
  });

  it("an add that can't tell which lent computer runs it saves nothing and says what to ask; a named one is passed on", async () => {
    const place = vi.fn<NonNullable<InternalMcpDeps["place"]>>(async () => ({ ok: false, error: "This server runs on the person's own computer, and several are lent to My Cloud: Ada's Mac, Studio. Ask the person which one in one short question, then add it again with computer set to its name." }));
    const { post, cfg } = fixture({ place });
    const refused = await post({ action: "add", name: "local", command: "/Users/ada/bin/notes-mcp" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Ask the person which one");
    expect(cfg.mcpServers).toEqual({});
    place.mockImplementationOnce(async (server) => ({ ok: true, server: { ...server, runsOn: { environmentId: "env-studio", label: "Studio" } } }));
    expect((await post({ action: "add", name: "local", command: "/Users/ada/bin/notes-mcp", computer: "Studio" })).status).toBe(201);
    expect(place).toHaveBeenLastCalledWith(expect.objectContaining({ command: "/Users/ada/bin/notes-mcp" }), "Studio");
    expect(cfg.mcpServers?.local).toMatchObject({ runsOn: { environmentId: "env-studio", label: "Studio" } });
  });

  it("refuses removing a server the organisation's policy refuses, with the policy's words", async () => {
    const refuse = (name: string) => (name === "linear" ? "Acme IT hasn't approved this MCP server." : undefined);
    const { post, cfg } = fixture({ servers: { linear }, refuse });
    expect(await post({ action: "remove", name: "linear" })).toEqual({ status: 403, body: { error: "Acme IT hasn't approved this MCP server." } });
    expect(cfg.mcpServers).toEqual({ linear });
  });

  it("refuses with the policy's words where the organisation's policy refuses the server", async () => {
    const refuse = (name: string) => (name === "linear" ? "Acme IT hasn't approved this MCP server." : undefined);
    const { post, stored } = fixture({ servers: { linear: { ...linear, enabled: false } }, refuse });
    const out = await post({ action: "enable", name: "linear" });
    expect(out).toEqual({ status: 403, body: { error: "Acme IT hasn't approved this MCP server." } });
    expect(stored("linear")?.enabled).toBe(false);
  });

  it("a non-admin on a Team Cloud is refused with \"Ask a workspace admin to add it.\" for add, update, enable, disable, sign_out and remove", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, cfg } = fixture({ admin: false, servers: { linear } });
    const before = structuredClone(cfg.mcpServers);
    for (const payload of [
      { action: "add", name: "github", url: "https://api.github.example/mcp" },
      { action: "update", name: "linear", url: "https://mcp.linear.app/v2" },
      { action: "enable", name: "linear" },
      { action: "disable", name: "linear" },
      { action: "sign_out", name: "linear" },
      { action: "remove", name: "linear" },
    ]) {
      expect(await post(payload), payload.action).toEqual({ status: 403, body: { error: ASK_ADMIN } });
    }
    expect(cfg.mcpServers).toEqual(before);
    expect(probe).not.toHaveBeenCalled();
  });

  it("every action, list included, is refused in a guest-driven thread with \"MCP servers are managed by the owner.\"", async () => {
    const { call, post, cfg } = fixture({ guest: true, servers: { linear } });
    expect(await call("GET")).toEqual({ status: 403, body: { error: OWNER_ONLY } });
    for (const action of ["list", "add", "update", "enable", "disable", "restart", "test", "sign_in", "sign_out", "remove"]) {
      expect(await post({ action, name: "linear" }), action).toEqual({ status: 403, body: { error: OWNER_ONLY } });
    }
    expect(cfg.mcpServers).toEqual({ linear });
  });

  it("add for a bot whose tool selection leaves the server out says so and does not widen toolScope", async () => {
    probeWith({ ok: true, tools: [] });
    const { post, sender } = fixture({ leftOut: ["linear"] });
    const { body } = await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" });
    expect(body.text).toContain("Your tool selection leaves linear out. The person can change that in your settings.");
    expect(sender.toolScope).toBeUndefined();
  });

  it("stripped keys (bot, runsOn, apps, enabled) in the body are ignored", async () => {
    probeWith({ ok: true, tools: [] });
    const ask = fixture({ full: false });
    const added = await ask.post({ action: "add", name: "notes", command: "notes-mcp", bot: "scout", runsOn: MAC, apps: false, enabled: true });
    expect(added.status).toBe(201);
    const saved = ask.cfg.mcpServers?.notes as Record<string, unknown>;
    expect(saved).toMatchObject({ command: "notes-mcp", enabled: false });
    expect(saved).not.toHaveProperty("bot");
    expect(saved).not.toHaveProperty("runsOn");
    expect(saved).not.toHaveProperty("apps");

    const full = fixture({ servers: { linear } });
    expect((await full.post({ action: "update", name: "linear", enabled: false, apps: false, runsOn: MAC })).status).toBe(200);
    expect(full.cfg.mcpServers?.linear).toEqual(linear);
  });

  it("a secretRef is committed only after the change persists", async () => {
    probeWith({ ok: true, tools: [] });
    const refuse = (name: string) => (name === "blocked" ? "Not approved." : undefined);
    const { post, ref, stored } = fixture({ refuse });
    const key = ref("lin_secret");
    const refused = await post({ action: "add", name: "blocked", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${key}` } });
    expect(refused.status).toBe(403);
    const added = await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${key}` } });
    expect(added.status).toBe(201);
    expect(stored("linear")).toMatchObject({ headers: { Authorization: "Bearer lin_secret" } });
    const reused = await post({ action: "add", name: "again", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${key}` } });
    expect(reused.body.error).toContain("already used");
  });

  it("an update whose only change is a fresh secretRef keeps the other saved keys", async () => {
    probeWith({ ok: true, tools: [] });
    const { post, ref, stored } = fixture({ servers: { notes: { ...notes, env: { NOTES_TOKEN: "saved-token", NOTES_SPACE: "saved-space" } } } });
    const { status, body } = await post({ action: "update", name: "notes", env: { NOTES_TOKEN: ref("fresh-token") } });
    expect(status).toBe(200);
    expect(stored("notes")).toMatchObject({ command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "fresh-token", NOTES_SPACE: "saved-space" } });
    expect(body.dropped).toBeUndefined();
  });

  it("an update the config refuses leaves its secretRef unspent", async () => {
    probeWith({ ok: true, tools: [] });
    const refuse = (name: string) => (name === "notes" ? "Not approved." : undefined);
    const blocked = fixture({ servers: { notes }, refuse });
    const key = blocked.ref("fresh-token");
    expect(await blocked.post({ action: "update", name: "notes", env: { NOTES_TOKEN: key } })).toEqual({ status: 403, body: { error: "Not approved." } });
    expect(blocked.stored("notes")).toMatchObject({ env: { NOTES_TOKEN: "saved-token" } });
    expect((await blocked.post({ action: "add", name: "other", url: "https://other.example/mcp", headers: { Authorization: key } })).status).toBe(201);
    expect(blocked.stored("other")).toMatchObject({ headers: { Authorization: "fresh-token" } });
  });

  it("an update across transports is refused and changes nothing", async () => {
    const { post, cfg } = fixture({ servers: { linear, notes } });
    expect(await post({ action: "update", name: "linear", command: "npx" })).toEqual({ status: 400, body: { error: "linear is reached by its address: to switch, remove it and add it again." } });
    expect(await post({ action: "update", name: "notes", url: "https://notes.example/mcp" })).toEqual({ status: 400, body: { error: "notes runs a command: to switch, remove it and add it again." } });
    expect(cfg.mcpServers).toEqual({ linear, notes });
  });

  it("a busy config says to try again, on add, on the switch after add, and on update", async () => {
    const busy = fixture({ servers: { linear } });
    busy.setBusy(true);
    const tryAgain = { error: "MCP servers are already being updated. Try again in a moment." };
    expect(await busy.post({ action: "add", name: "github", url: "https://api.github.example/mcp" })).toEqual({ status: 409, body: tryAgain });
    expect(await busy.post({ action: "update", name: "linear", url: "https://mcp.linear.app/v2" })).toEqual({ status: 409, body: tryAgain });

    const between = fixture();
    between.deps.config = { ...between.config, setEnabled: () => ({ status: 409, error: "MCP servers are already being updated." }) };
    const out = await createInternalMcpRoutesCall(between.deps, { action: "add", name: "github", url: "https://api.github.example/mcp" });
    expect(out).toEqual({ status: 409, body: { error: "Saved github, but it is still off: MCP servers are already being updated. Try again in a moment." } });
  });

  it("an update to an address the organisation's policy refuses is refused with the policy's words", async () => {
    const refuse = (name: string) => (name === "linear" ? "Acme IT hasn't approved this MCP server." : undefined);
    const { post, stored } = fixture({ servers: { linear }, refuse });
    expect(await post({ action: "update", name: "linear", url: "https://mcp.linear.app/v2" })).toEqual({ status: 403, body: { error: "Acme IT hasn't approved this MCP server." } });
    expect(stored("linear")).toMatchObject({ url: linear.url });
  });

  it("an update keeps the add path's folder rules where bots are boxed", async () => {
    probeWith({ ok: true, tools: [] });
    const boxed = fixture({ boxed: true, servers: { notes } });
    const theirs = join(boxed.dataDir, "workspaces", "scout", "server.py");
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, "");
    expect(await boxed.post({ action: "update", name: "notes", command: "python3", args: [theirs] })).toEqual({
      status: 400, body: { error: "That command uses files in another bot's folder, which only that bot can reach. Use files in your own folder." },
    });
    expect(boxed.stored("notes")).toMatchObject({ command: "npx" });

    const script = join(boxed.dataDir, "task-workspaces", BOT, THREAD, "srv", "server.py");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "");
    const { status, body } = await boxed.post({ action: "update", name: "notes", command: "python3", args: [script] });
    expect(status).toBe(200);
    expect(boxed.stored("notes")).toMatchObject({ command: "python3", args: [join(boxed.dataDir, "workspaces", BOT, "tools", "srv", "server.py")], bot: BOT });
    expect(existsSync(join(boxed.dataDir, "workspaces", BOT, "tools", "srv", "server.py"))).toBe(true);
    expect(body.text).toContain("copied to");
  });

  it("an update that leaves the command alone skips the folder rules, so a shared server across bots' folders still changes", async () => {
    probeWith({ ok: true, tools: [] });
    const boxed = fixture({ boxed: true });
    const across = { command: "python3", args: [join(boxed.dataDir, "workspaces", BOT, "a.py"), join(boxed.dataDir, "workspaces", "scout", "b.py")], env: {}, enabled: true };
    boxed.cfg.mcpServers = { shared: across };
    const { status } = await boxed.post({ action: "update", name: "shared", resultBudget: 5000, args: across.args });
    expect(status).toBe(200);
    expect(boxed.stored("shared")).toMatchObject({ args: across.args, resultBudget: 5000 });
    expect(boxed.stored("shared")).not.toHaveProperty("bot");
    const moved = await boxed.post({ action: "update", name: "shared", args: [across.args[1]!] });
    expect(moved.status).toBe(400);
  });

  it("update swaps a resupplied secretRef, padded or not, and keeps it when the destination moves", async () => {
    probeWith({ ok: true, tools: [] });
    const { post, ref, stored } = fixture({ servers: { notes } });
    const key = ref("fresh-token");
    const { body } = await post({ action: "update", name: "notes", args: ["-y", "notes-mcp@2"], env: { NOTES_TOKEN: `  ${key} ` } });
    expect(stored("notes")).toMatchObject({ args: ["-y", "notes-mcp@2"], env: { NOTES_TOKEN: "fresh-token" } });
    expect(body.dropped).toBeUndefined();
  });

  it("list names the computer a server runs on and marks a policy-refused one as managed", async () => {
    const refuse = (name: string) => (name === "linear" ? "Not approved." : undefined);
    const { call } = fixture({ servers: { linear, notes: { ...notes, runsOn: MAC } }, refuse });
    const { body } = await call("GET");
    const rows = JSON.parse(body.text!.slice(body.text!.indexOf("\n") + 1)) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({ name: "linear", owner: "managed", managedBy: "Acme IT", forThisBot: true }),
      expect.objectContaining({ name: "notes", owner: "elsewhere", runsOn: "Ada's Mac", forThisBot: true }),
    ]);
  });

  it("an update that sends back the address list showed keeps the saved address, headers and sign-in; a new address drops them", async () => {
    probeWith({ ok: true, tools: [] });
    const { call, post, stored, mcpOAuth } = fixture({ servers: { zap: zapier } });
    mcpOAuth.adopt("zap", zapier.url, { url: zapier.url, state: "signed-in", tokens: { access: "token" } });
    const listed = await call("GET");
    const shown = (JSON.parse(listed.body.text!.slice(listed.body.text!.indexOf("\n") + 1)) as Array<{ url: string }>)[0]!.url;

    const kept = await post({ action: "update", name: "zap", url: shown, resultBudget: 4000 });
    expect(kept.status).toBe(200);
    expect(kept.body.dropped).toBeUndefined();
    expect(stored("zap")).toMatchObject({ url: zapier.url, headers: { "X-Api-Key": "zap-header-value" }, resultBudget: 4000 });
    expect(mcpOAuth.authState("zap", zapier.url)).toBe("signed-in");

    const moved = await post({ action: "update", name: "zap", url: "https://mcp.zapier.com/api/mcp/s/Other123Token456abc/mcp" });
    expect(moved.body.dropped).toEqual(["header X-Api-Key", "sign-in"]);
    expect(stored("zap")).toMatchObject({ url: "https://mcp.zapier.com/api/mcp/s/Other123Token456abc/mcp", headers: {} });
  });

  it("list returns botListing rows for servers this bot can see and hides another bot's own", async () => {
    const servers = { linear, notes: { ...notes, bot: BOT }, scout: { ...notes, bot: "scout" }, docs: { type: "http", url: "https://docs.example/mcp?key=1", headers: { "X-Key": "k" }, enabled: false } };
    const { call } = fixture({ servers, personal: ["docs"] });
    const { status, body } = await call("GET");
    expect(status).toBe(200);
    const parse = (name: string) => { const parsed = parseStoredMcpServer(name, servers[name as keyof typeof servers]); if (!parsed.ok) throw new Error(parsed.error); return parsed.server; };
    const row = (name: string, owner: ReturnType<typeof mcpOwner>) => botListing(name, parse(name), { owner, authState: "none", forThisBot: true });
    expect(JSON.parse(body.text!.slice(body.text!.indexOf("\n") + 1))).toEqual([row("linear", "shared"), row("notes", "own"), row("docs", "person")]);
    expect(body.text).not.toContain("scout");
    expect(body.text).not.toContain("key=1");
  });
});

describe("internal mcp_server route, below Full access", () => {
  const PROPOSED = "A card is now visible to the person. End this turn and wait for the decision.";

  it("a non-Full add of a URL server turns it on and tests it, with no card", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "list_issues" }] });
    const { post, stored, lines, chat, decided } = fixture({ full: false });
    const { status, body } = await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp?team=acme" });
    expect(status).toBe(201);
    expect(stored("linear")?.enabled).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(body.text).toContain("Added MCP server linear and turned it on.");
    expect(body.text).not.toContain(PROPOSED);
    expect(decided).toEqual([{ summary: "Added MCP server linear and turned it on", applied: "level" }]);
    expect(lines).toEqual(["Added MCP server linear · Turned on · Test: 1 tool"]);
    expect(chat).toHaveLength(0);
  });

  it.each([
    "http://localhost:3000/mcp", "https://192.168.1.5/mcp", "http://docs.example/mcp", "https://127.0.0.1:8799/mcp",
    "https://printer.local/mcp", "https://intranet.example/mcp", "https://split.example/mcp", "https://nowhere.example/mcp",
  ])("a non-Full add of %s, not a public https address, saves it off and posts a Turn on card", async (url) => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, stored, chat, card, decided } = fixture({ full: false });
    const { status, body } = await post({ action: "add", name: "local", type: "http", url });
    expect(status).toBe(201);
    expect(stored("local")?.enabled).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(body.text).toContain(PROPOSED);
    expect(decided).toEqual([]);
    expect(chat).toHaveLength(1);
    expect(card()).toMatchObject({ title: "Turn on local?", options: ["Turn on", "Cancel"], mcpRequest: { action: "enable", name: "local" } });
  });

  it("a non-Full add of a command server saves it off and posts a Turn on card, since turning it on runs a program", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, stored, lines, chat, card } = fixture({ full: false });
    const { status, body } = await post({ action: "add", name: "notes", command: "notes-mcp", args: ["--stdio"] });
    expect(status).toBe(201);
    expect(stored("notes")?.enabled).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(body.text).toContain(PROPOSED);
    expect(lines).toEqual(["Added MCP server notes · Switched off"]);
    expect(chat).toHaveLength(1);
    expect(card()).toEqual({
      title: "Turn on notes?",
      subtitle: "notes-mcp --stdio\nRuns on this computer.",
      options: ["Turn on", "Cancel"], requestId: expect.any(String), tool: "mcp_server", fixedOptions: true,
      mcpRequest: { requestId: card()!.requestId, botId: BOT, threadId: THREAD, action: "enable", name: "notes", targetHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  it("a Turn on card for a command server shows its command with secrets hidden and says it runs on this computer", async () => {
    const { post, card, lines } = fixture({ full: false, servers: { notes: { ...notes, args: ["notes-mcp", "--api-key", "sk-live-123"], enabled: false } } });
    expect((await post({ action: "enable", name: "notes" })).status).toBe(202);
    expect(card()?.subtitle).toBe("npx notes-mcp --api-key ***\nRuns on this computer.");
    expect(JSON.stringify(card())).not.toContain("sk-live-123");
    expect(lines).toEqual(["Asked to turn on MCP server notes"]);
  });

  it("allow applies the change, tests it and resumes the bot with the test result", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "list_issues" }, { name: "create_issue" }] });
    const { post, respond, stored, card, answers, decisions, dataDir, listedOn } = fixture({ full: false, mcpServers: ["notes"], servers: { linear: { ...linear, enabled: false } } });
    expect((await post({ action: "enable", name: "linear" })).body.text).toBe(PROPOSED);
    expect(stored("linear")?.enabled).toBe(false);

    expect(await respond("allow")).toMatchObject({ status: 200, body: { ok: true, alreadySettled: false } });
    expect(stored("linear")?.enabled).toBe(true);
    expect(listedOn).toEqual([{ bot: BOT, name: "linear" }]);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[3]).toMatchObject({ asBot: { id: BOT, cwd: dataDir } });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("Turned on MCP server linear. Test: it started and listed its tools: list_issues, create_issue. That does not show what they return: call one to check.");
    expect(answers[0]).not.toContain("next turn");
    expect(card()).toMatchObject({ answered: "allow", mcpRequest: { resumed: true, result: { state: "applied" } } });
    expect(decisions).toEqual(["card-shown", "user-approved"]);
  });

  it("deny resumes the bot with the deny text and changes nothing", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, respond, cfg, card, answers, decisions } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    await post({ action: "enable", name: "linear" });
    expect(await respond("deny")).toMatchObject({ status: 200, body: { ok: true, alreadySettled: false } });
    expect(cfg.mcpServers).toEqual({ linear: { ...linear, enabled: false } });
    expect(probe).not.toHaveBeenCalled();
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("The person kept it off. Don't add it again unless they ask.");
    expect(card()).toMatchObject({ answered: "deny", mcpRequest: { resumed: true, result: { state: "denied" } } });
    expect(decisions).toEqual(["card-shown", "user-denied"]);
  });

  it("an expired secretRef on allow marks the card expired and resumes with \"The key expired. Ask for it again with request_credential.\"", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, respond, stored, card, answers, ref, later } = fixture({ full: false, servers: { notes } });
    const fresh = ref("fresh-token");
    expect((await post({ action: "update", name: "notes", env: { NOTES_TOKEN: fresh } })).status).toBe(202);
    expect(card()?.subtitle).toBe("new key for NOTES_TOKEN");

    later(61 * 60_000);
    expect(await respond("allow")).toMatchObject({ status: 200 });
    expect(stored("notes")).toHaveProperty("env", { NOTES_TOKEN: "saved-token" });
    expect(probe).not.toHaveBeenCalled();
    expect(card()).toMatchObject({ expired: true, options: [], held: "The key expired before this was answered.", mcpRequest: { result: { state: "expired" } } });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("The key expired. Ask for it again with request_credential.");
  });

  it("a second allow returns alreadySettled and applies nothing", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, respond, stored, config, answers } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    await post({ action: "enable", name: "linear" });
    await respond("allow");
    expect("error" in config.setEnabled("linear", false)).toBe(false);
    expect(await respond("allow")).toMatchObject({ status: 200, body: { alreadySettled: true } });
    expect(stored("linear")?.enabled).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
    expect(answers).toHaveLength(1);
  });

  it("allow after the server was removed resumes with \"linear no longer exists\"", async () => {
    const { post, respond, cfg, config, card, answers } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    await post({ action: "enable", name: "linear" });
    expect("error" in config.remove("linear")).toBe(false);
    await respond("allow");
    expect(cfg.mcpServers).toEqual({});
    expect(card()).toMatchObject({ expired: true, held: "linear no longer exists.", mcpRequest: { result: { state: "failed" } } });
    expect(answers[0]).toContain("linear no longer exists");
  });

  it("allow after the server's address or command changed applies nothing and resumes with \"notes changed since you were asked, so nothing was applied.\"", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, respond, stored, config, card, answers } = fixture({ full: false, servers: { notes: { ...notes, enabled: false } } });
    await post({ action: "enable", name: "notes" });
    expect("error" in config.replace("notes", { ...notes, args: ["-y", "other-mcp"], enabled: false } as StoredMcpServer)).toBe(false);
    await respond("allow");
    expect(stored("notes")).toMatchObject({ args: ["-y", "other-mcp"], enabled: false });
    expect(probe).not.toHaveBeenCalled();
    expect(card()).toMatchObject({ expired: true, held: "notes changed after this was asked, so nothing was applied.", mcpRequest: { result: { state: "failed" } } });
    expect(answers[0]).toContain("notes changed since you were asked, so nothing was applied.");
  });

  it("a busy config during allow answers 409 and leaves the card open, and a later allow applies it", async () => {
    probeWith({ ok: true, tools: [] });
    const { post, respond, stored, card, answers, setBusy } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    await post({ action: "enable", name: "linear" });
    setBusy(true);
    expect(await respond("allow")).toEqual({ status: 409, body: { error: "MCP servers are already being updated. Try again in a moment." } });
    expect(stored("linear")?.enabled).toBe(false);
    expect(card()).not.toHaveProperty("answered");
    expect(card()).not.toHaveProperty("expired");
    expect(answers).toEqual([]);
    setBusy(false);
    expect(await respond("allow")).toMatchObject({ status: 200, body: { result: { state: "applied" } } });
    expect(stored("linear")?.enabled).toBe(true);
  });

  it("no field value the bot sent, literal or secretRef, reaches the stored card message", async () => {
    const { post, chat, ref } = fixture({ full: false, servers: { notes } });
    const fresh = ref("fresh-token");
    expect((await post({ action: "update", name: "notes", args: ["-y", "notes-mcp", "--token", "sk-live-9"], env: { NOTES_TOKEN: fresh } })).status).toBe(202);
    const stored = JSON.stringify(chat);
    for (const sent of [fresh, "sk-live-9", "fresh-token", "saved-token"]) expect(stored, sent).not.toContain(sent);
    expect(Object.keys(chat[0]!.card.mcpRequest!).sort()).toEqual(["action", "botId", "name", "requestId", "targetHash", "threadId"]);
  });

  it("a literal under a secret's name shows as a new key, never its value, while other literals still show", async () => {
    const commands = fixture({ full: false, servers: { notes } });
    await commands.post({ action: "update", name: "notes", env: { API_TOKEN: "plainopaque123xyz", LOG_LEVEL: "debug" } });
    expect(commands.card()?.subtitle).toContain("env.LOG_LEVEL → debug");
    expect(commands.card()?.subtitle).toContain("new key for API_TOKEN");
    expect(JSON.stringify(commands.chat)).not.toContain("plainopaque123xyz");

    const remote = fixture({ full: false, servers: { linear } });
    await remote.post({ action: "update", name: "linear", headers: { "X-Api-Key": "opaque-value-123", Authorization: "Bearer abc123" } });
    expect(remote.card()?.subtitle).toBe("new key for X-Api-Key\nnew key for Authorization");
    expect(JSON.stringify(remote.chat)).not.toMatch(/opaque-value-123|abc123/);
  });

  it("the card's targetHash is the hash of the display target, so a secret in the args or url cannot be guessed from it", async () => {
    const value = "sk-live-hunter2-secret";
    const keyed = { command: "npx", args: ["-y", "notes-mcp", "--api-key", value], enabled: false };
    const local = fixture({ full: false, servers: { notes: keyed } });
    await local.post({ action: "enable", name: "notes" });
    const hash = local.card()!.mcpRequest!.targetHash;
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(hash).toBe(sha("npx -y notes-mcp --api-key ***"));
    expect(hash).not.toBe(sha(JSON.stringify(["npx", "-y", "notes-mcp", "--api-key", value])));
    expect(JSON.stringify(local.card())).not.toContain(value);

    const urlKey = "Zk9QxW2mT7aBcD4eF6gH8jK1";
    const remote = fixture({ full: false, servers: { zap: { type: "http", url: `https://mcp.zapier.com/api/mcp/s/${urlKey}/mcp`, headers: {}, enabled: false } } });
    await remote.post({ action: "enable", name: "zap" });
    expect(remote.card()!.mcpRequest!.targetHash).toBe(sha("https://mcp.zapier.com/api/mcp/s/…/mcp"));
  });

  it("a client-id-only update does not say the destination changed, and a url change still names it", async () => {
    probeWith({ ok: true, tools: [] });
    const app = { ...linear, oauth: { clientId: "omb-app", clientSecret: "old-client-secret" } };
    const idOnly = await fixture({ servers: { linear: app } }).post({ action: "update", name: "linear", oauth: { clientId: "other-app" } });
    expect(idOnly.body.dropped).toEqual(["oauth client secret"]);
    expect(idOnly.body.text).toContain("OAuth client id changed");
    expect(idOnly.body.text).toContain("request_credential");
    expect(idOnly.body.text).not.toMatch(/destination changed/);
    const moved = await fixture({ servers: { linear: app } }).post({ action: "update", name: "linear", url: "https://mcp.linear.app/v2" });
    expect(moved.body.text).toMatch(/destination or OAuth client id changed/);
  });

  it("a new literal OAuth client secret shows as its own change line without its value", async () => {
    probeWith({ ok: true, tools: [] });
    const signedApp = { ...linear, enabled: false, oauth: { clientId: "omb-app", clientSecret: "old-client-secret" } };
    const { post, respond, stored, card } = fixture({ full: false, servers: { linear: signedApp } });
    expect((await post({ action: "update", name: "linear", oauth: { clientSecret: "new-client-secret" } })).status).toBe(202);
    expect(card()?.subtitle).toBe("new OAuth client secret");
    expect(JSON.stringify(card())).not.toMatch(/new-client-secret|old-client-secret/);
    await respond("allow");
    expect(stored("linear")).toMatchObject({ oauth: { clientId: "omb-app", clientSecret: "new-client-secret" } });
  });

  it("a Change card lists each field as old → new with no secret value, and allow merges onto the server as it is then", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "search_notes" }] });
    const { post, respond, stored, config, card, answers, ref } = fixture({ full: false, servers: { notes } });
    const fresh = ref("fresh-token");
    await post({ action: "update", name: "notes", args: ["-y", "notes-mcp", "--token", "sk-live-9"], env: { NOTES_TOKEN: fresh, LOG_LEVEL: "debug" } });
    expect(card()?.title).toBe("Change notes?");
    expect(card()?.options).toEqual(["Change", "Cancel"]);
    expect(card()?.subtitle).toBe("args: -y notes-mcp → -y notes-mcp --token ***\nenv.LOG_LEVEL → debug\nnew key for NOTES_TOKEN");
    expect(JSON.stringify(card()), "no saved or redeemed secret value is stored").not.toMatch(/fresh-token|saved-token/);

    expect("error" in config.replace("notes", { ...notes, resultBudget: 4000 } as StoredMcpServer)).toBe(false);
    await respond("allow");
    expect(stored("notes")).toMatchObject({ resultBudget: 4000, args: ["-y", "notes-mcp", "--token", "sk-live-9"], enabled: true });
    expect(stored("notes")).toHaveProperty("env", { NOTES_TOKEN: "fresh-token", LOG_LEVEL: "debug" });
    expect(probe).toHaveBeenCalledOnce();
    expect(answers[0]).toContain("Changed MCP server notes.");
  });

  it("a Remove card names the other bots that use the server, and allow removes it", async () => {
    const { post, respond, cfg, card } = fixture({ full: false, servers: { linear }, usedBy: { linear: ["Clive", "Mo"] } });
    expect((await post({ action: "remove", name: "linear" })).status).toBe(202);
    expect(card()).toMatchObject({ title: "Remove linear?", subtitle: "Used by Clive, Mo.", options: ["Remove", "Cancel"] });
    expect(cfg.mcpServers).toHaveProperty("linear");
    await respond("allow");
    expect(cfg.mcpServers).toEqual({});
  });

  it("a key in an address's path or userinfo reaches neither the bot's list nor a Turn on or Change card", async () => {
    const { call, post, card, chat, lines } = fixture({ full: false, servers: { zap: { ...zapier, enabled: false }, team: { ...linear, url: userinfo, enabled: false } } });
    const listed = await call("GET");
    const rows = JSON.parse(listed.body.text!.slice(listed.body.text!.indexOf("\n") + 1)) as Array<{ name: string; url: string }>;
    expect(rows.map((row) => [row.name, row.url]), "a stored address with userinfo never parses, so it is not listed").toEqual([["zap", "https://mcp.zapier.com/api/mcp/s/…/mcp"]]);

    expect((await post({ action: "enable", name: "zap" })).status).toBe(202);
    expect(card()?.subtitle.split("\n")[0]).toBe("https://mcp.zapier.com/api/mcp/s/…/mcp");
    const refused = [await post({ action: "enable", name: "team" }), await post({ action: "update", name: "zap", url: userinfo })];
    expect(refused.map((outcome) => outcome.status)).toEqual([400, 400]);
    expect((await post({ action: "update", name: "zap", url: "https://mcp.example.com/mcp-server-production/mcp" })).status).toBe(202);
    expect(card()?.subtitle.split("\n")[0]).toBe("url: https://mcp.zapier.com/api/mcp/s/…/mcp → https://mcp.example.com/mcp-server-production/mcp");

    const everything = JSON.stringify([listed, refused, chat, lines]);
    for (const token of [PATH_TOKEN, USER_TOKEN]) expect(everything).not.toContain(token);
  });

  it("a proposal the organisation's policy refuses posts no card", async () => {
    const { post, chat } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } }, refuse: (name) => (name === "linear" ? "Acme IT blocks linear." : undefined) });
    for (const action of ["enable", "remove"]) expect(await post({ action, name: "linear" }), action).toEqual({ status: 403, body: { error: "Acme IT blocks linear." } });
    expect(chat).toEqual([]);
  });

  it("sign_in asks for a Sign in card at any level, in one activity line, and tells the bot to end its turn", async () => {
    for (const full of [true, false]) {
      const { post, signIns, lines, decided } = fixture({ full, servers: { linear } });
      expect(await post({ action: "sign_in", name: "linear" })).toEqual({ status: 202, body: {
        text: "A Sign in card for linear is now visible to the person. End this turn and wait; OpenMausBot resumes you when they finish.",
      } });
      expect(signIns).toEqual([{ name: "linear", url: linear.url }]);
      expect(lines).toEqual(["Asked to sign in to MCP server linear"]);
      expect(decided).toEqual([]);
    }
    const personal = fixture({ servers: { linear }, personal: ["linear"], admin: false });
    expect((await personal.post({ action: "sign_in", name: "linear" })).status).toBe(202);
    expect(personal.signIns).toEqual([{ name: "linear", url: linear.url }]);
  });

  it("sign_in on a server that is off posts no card and tells the bot to call enable", async () => {
    const off = { linear: { ...linear, enabled: false } };
    const full = fixture({ servers: off });
    expect(await full.post({ action: "sign_in", name: "linear" })).toEqual({ status: 403, body: { error: "linear is off. Call mcp_server with action enable first." } });
    const ask = fixture({ full: false, servers: off });
    expect(await ask.post({ action: "sign_in", name: "linear" })).toEqual({ status: 403, body: { error: "linear is off. Call mcp_server with action enable to ask the person to turn it on." } });
    expect([...full.signIns, ...ask.signIns]).toEqual([]);
  });

  it("sign_in refuses what no card could sign in to, and passes on the card's own refusal", async () => {
    const { post, signIns, mcpOAuth, lines } = fixture({ servers: { linear, notes, far: { ...linear, runsOn: MAC } } });
    expect(await post({ action: "sign_in", name: "notes" })).toEqual({ status: 400, body: { error: "Only servers reached by URL can be signed in to." } });
    expect(await post({ action: "sign_in", name: "far" })).toEqual({ status: 409, body: { error: "This server runs on Ada's Mac, so it isn't started here." } });
    expect(await post({ action: "sign_in", name: "gone" })).toEqual({ status: 404, body: { error: "gone no longer exists. Call mcp_server with action list to see the servers." } });
    mcpOAuth.adopt("linear", linear.url, { url: linear.url, state: "signed-in", tokens: { access: "token" } });
    expect(await post({ action: "sign_in", name: "linear" })).toEqual({ status: 200, body: { text: "linear is already signed in. Call mcp_server with action test to check it." } });
    expect(signIns).toEqual([]);
    expect(lines).toEqual([]);

    const member = fixture({ admin: false, servers: { linear } });
    expect(await member.post({ action: "sign_in", name: "linear" })).toEqual({ status: 403, body: { error: "Ask a workspace admin to sign in to linear." } });
    const refused = fixture({ servers: { linear }, signInRefusal: { status: 409, error: "Nobody can sign in to linear from here." } });
    expect(await refused.post({ action: "sign_in", name: "linear" })).toEqual({ status: 409, body: { error: "Nobody can sign in to linear from here." } });
    expect(refused.lines).toEqual([]);
  });

  it("an existing name says to use update", async () => {
    const { post } = fixture({ servers: { linear } });
    expect(await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" }))
      .toEqual({ status: 409, body: { error: "linear already exists. Use update, or pick another name." } });
  });
});

describe("a card answered after OpenMausBot restarts", () => {
  it("Turn on applies and resumes the bot with the test result", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "list_issues" }] });
    const { post, respond, restart, stored, card, answers } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    await post({ action: "enable", name: "linear" });
    restart();
    expect(await respond("allow")).toMatchObject({ status: 200, body: { result: { state: "applied" } } });
    expect(stored("linear")?.enabled).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(card()).toMatchObject({ answered: "allow", mcpRequest: { resumed: true, result: { state: "applied" } } });
    expect(answers[0]).toContain("Turned on MCP server linear. Test: it started and listed its tools: list_issues.");
  });

  it("Remove removes the server", async () => {
    const { post, respond, restart, cfg, card } = fixture({ full: false, servers: { linear } });
    await post({ action: "remove", name: "linear" });
    restart();
    expect(await respond("allow")).toMatchObject({ status: 200, body: { result: { state: "applied" } } });
    expect(cfg.mcpServers).toEqual({});
    expect(card()).toMatchObject({ answered: "allow" });
  });

  it("a server whose address or command changed meanwhile is left alone", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, respond, restart, stored, config, card, answers } = fixture({ full: false, servers: { notes: { ...notes, enabled: false } } });
    await post({ action: "enable", name: "notes" });
    expect("error" in config.replace("notes", { ...notes, args: ["-y", "other-mcp"], enabled: false } as StoredMcpServer)).toBe(false);
    restart();
    await respond("allow");
    expect(stored("notes")).toMatchObject({ args: ["-y", "other-mcp"], enabled: false });
    expect(probe).not.toHaveBeenCalled();
    expect(card()).toMatchObject({ expired: true, held: "notes changed after this was asked, so nothing was applied.", mcpRequest: { result: { state: "failed" } } });
    expect(answers[0]).toContain("notes changed since you were asked, so nothing was applied.");
  });

  it("a Change card expires, and no field the bot sent is on the stored card", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, respond, restart, stored, card, chat, answers, ref } = fixture({ full: false, servers: { notes } });
    const fresh = ref("fresh-token");
    await post({ action: "update", name: "notes", args: ["-y", "notes-mcp", "--token", "sk-live-9"], env: { NOTES_TOKEN: fresh } });
    restart();
    await respond("allow");
    expect(stored("notes")).toMatchObject({ args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "saved-token" } });
    expect(probe).not.toHaveBeenCalled();
    expect(card()).toMatchObject({ expired: true, held: "OpenMausBot restarted, so this request expired.", mcpRequest: { result: { state: "expired" } } });
    expect(answers[0]).toContain("OpenMausBot restarted, so this request expired. Ask again if you still need it.");
    for (const sent of [fresh, "sk-live-9", "fresh-token", "saved-token"]) expect(JSON.stringify(chat), sent).not.toContain(sent);
  });

  it("Cancel settles as the person's no", async () => {
    const { post, respond, restart, stored, card, answers } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    await post({ action: "enable", name: "linear" });
    restart();
    await respond("deny");
    expect(stored("linear")?.enabled).toBe(false);
    expect(card()).toMatchObject({ answered: "deny", mcpRequest: { result: { state: "denied" } } });
    expect(answers[0]).toContain("The person kept it off. Don't add it again unless they ask.");
  });
});

describe("the activity line", () => {
  const row = (extra: Partial<WireMessage> = {}): WireMessage => ({
    id: "m1", at: 1, role: "bot", kind: "activity", turnId: "turn-1", tool: { name: "mcp__agents__mcp_server", input: "{}", itemId: "i1" }, ...extra,
  }) as WireMessage;
  function store(messages: WireMessage[]) {
    return {
      messages,
      messagesFor: () => messages,
      patchMessage: (_thread: string, id: string, patch: Partial<WireMessage>) => { const at = messages.findIndex((m) => m.id === id); messages[at] = { ...messages[at]!, ...patch }; },
      appendMessage: (_thread: string, message: Omit<WireMessage, "id" | "at">) => { messages.push({ ...message, id: `m${messages.length + 1}`, at: 2 } as WireMessage); },
    };
  }

  it("one mcp_server call leaves exactly one visible row, carrying the label, with the tool's own name kept", () => {
    const thread = store([row()]);
    showMcpActivity(thread, { threadId: THREAD, turnId: "turn-1" }, { action: "add", name: "linear" }, "Added MCP server linear · Turned on · Test: needs sign-in");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.tool).toEqual({ name: "mcp__agents__mcp_server", input: "{}", itemId: "i1", label: "Added MCP server linear · Turned on · Test: needs sign-in" });
  });

  it("in a room, labels the speaking bot's own open row of this turn and never another bot's", () => {
    const kiwi = { botId: BOT, name: "Kiwi", color: "green" };
    const thread = store([row({ id: "m1", from: { botId: "scout", name: "Scout", color: "blue" } }), row({ id: "m2", from: kiwi })]);
    showMcpActivity(thread, { threadId: THREAD, turnId: "turn-1", from: kiwi }, { action: "disable", name: "linear" }, "Turned off MCP server linear");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages.find((m) => m.id === "m2")?.tool?.label).toBe("Turned off MCP server linear");
    expect(thread.messages.find((m) => m.id === "m1")?.tool?.label).toBeUndefined();
  });

  it("two calls started together each label their own row, and no row is added", () => {
    const input = (action: string, name: string) => JSON.stringify({ action, name }, null, 2);
    const thread = store([
      row({ id: "a", tool: { name: "mcp__agents__mcp_server", input: input("add", "linear"), itemId: "a" } }),
      row({ id: "b", tool: { name: "mcp__agents__mcp_server", input: input("add", "github"), itemId: "b" } }),
    ]);
    showMcpActivity(thread, { threadId: THREAD, turnId: "turn-1" }, { action: "add", name: "linear" }, "Added MCP server linear");
    thread.messages[0] = { ...thread.messages[0]!, tool: { ...thread.messages[0]!.tool!, ok: true } };
    showMcpActivity(thread, { threadId: THREAD, turnId: "turn-1" }, { action: "add", name: "github" }, "Added MCP server github");
    expect(thread.messages.map((m) => [m.id, m.tool?.label])).toEqual([["a", "Added MCP server linear"], ["b", "Added MCP server github"]]);
  });

  it("finds its row by name on a bridged turn and falls back to the newest open row when no input names it", () => {
    const bridged = store([
      row({ id: "a", tool: { name: "mcp_server", input: JSON.stringify({ name: "mcp_server", arguments: { action: "remove", name: "docs" } }, null, 2) } }),
      row({ id: "b", tool: { name: "agents__mcp_server", input: "{}" } }),
    ]);
    showMcpActivity(bridged, { threadId: THREAD, turnId: "turn-1" }, { action: "remove", name: "docs" }, "Removed MCP server docs");
    expect(bridged.messages.find((m) => m.id === "a")?.tool?.label).toBe("Removed MCP server docs");
    showMcpActivity(bridged, { threadId: THREAD, turnId: "turn-1" }, { action: "test", name: "other" }, "Tested MCP server other");
    expect(bridged.messages.find((m) => m.id === "b")?.tool?.label).toBe("Tested MCP server other");
    expect(bridged.messages).toHaveLength(2);
  });

  it("adds a row, in this turn, only when the turn has no open mcp_server row to carry it", () => {
    for (const messages of [[], [row({ tool: { name: "mcp__agents__mcp_server", ok: true } })], [row({ turnId: "turn-0" })], [row({ tool: { name: "Bash" } })]]) {
      const thread = store([...messages]);
      showMcpActivity(thread, { threadId: THREAD, turnId: "turn-1" }, { action: "remove", name: "linear" }, "Removed MCP server linear");
      expect(thread.messages, JSON.stringify(messages)).toHaveLength(messages.length + 1);
      expect(thread.messages.at(-1)).toMatchObject({ turnId: "turn-1", tool: { name: "mcp_server", label: "Removed MCP server linear", ok: true } });
    }
  });

  it("with no live turn, never labels a row an earlier turn left open", () => {
    const thread = store([row()]);
    showMcpActivity(thread, { threadId: THREAD }, { action: "remove", name: "linear" }, "Removed MCP server linear");
    expect(thread.messages[0]!.tool?.label).toBeUndefined();
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]).not.toHaveProperty("turnId");
  });
});

describe("which other bots a server notice names", () => {
  const bot = (id: string, more: Partial<BotRecord> = {}) => ({ id, name: id.toUpperCase(), ...more }) as BotRecord;
  const everyone = (_bot: BotRecord) => true;

  it("names the other bots that get the server, not the sender or hidden ones", () => {
    const sender = bot("a");
    expect(otherBotsGiven([sender, bot("b"), bot("c", { hidden: true }), bot("d")], sender, (b) => b.id !== "d")).toEqual(["B"]);
  });

  it("leaves out a bot only admins see when people who are not admins see the sender", () => {
    const sender = bot("a");
    const bots = [sender, bot("b"), bot("secret", { visibility: "admins" }), bot("few", { visibility: { people: ["x@example.com"] } })];
    expect(otherBotsGiven(bots, sender, everyone)).toEqual(["B"]);
  });

  it("names a restricted bot to a sender whose audience it covers", () => {
    const sender = bot("a", { visibility: { people: ["x@example.com"] } });
    const bots = [sender, bot("b"), bot("secret", { visibility: "admins" }), bot("few", { visibility: { people: ["x@example.com", "y@example.com"] } })];
    expect(otherBotsGiven(bots, sender, everyone)).toEqual(["B", "FEW"]);
    expect(otherBotsGiven(bots, bot("admin", { visibility: "admins" }), everyone)).toEqual(["A", "B", "SECRET", "FEW"]);
  });
});

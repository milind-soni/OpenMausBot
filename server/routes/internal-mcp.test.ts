import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createMcpConfig } from "../host/mcp-config.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { addBotMcpServer } from "../mcp-bot-servers.ts";
import { botListing, mcpOwner } from "../mcp-bot-rules.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import * as probeModule from "../mcp-probe.ts";
import { listMcpServers, parseStoredMcpServer, type StoredMcpServer } from "../mcp-registry.ts";
import { SecretVault } from "../secret-vault.ts";
import { createInternalMcpRoutes, type InternalMcpDeps } from "./internal-mcp.ts";
import { PASS, type RouteContext } from "./table.ts";

const BOT = "kiwi";
const THREAD = "thread-1";
const MAC = { environmentId: "env-mac", label: "Ada's Mac" };
const OWNER_ONLY = "MCP servers are managed by the owner.";
const ASK_ADMIN = "Ask a workspace admin to add it.";

const linear = { type: "http", url: "https://mcp.linear.app/mcp", headers: {}, enabled: true };
const notes = { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "saved-token" }, enabled: true };

interface Options {
  full?: boolean;
  guest?: boolean;
  admin?: boolean;
  personal?: string[];
  mcpServers?: string[];
  leftOut?: string[];
  servers?: Record<string, unknown>;
  refuse?: (name: string) => string | undefined;
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
  });
  const vault = new SecretVault();
  const owner = { botId: BOT, threadId: THREAD };
  const sender = { id: BOT, ...(options.mcpServers ? { mcpServers: [...options.mcpServers] } : {}), toolScope: undefined as unknown };
  const listedOn: Array<{ bot: string; name: string }> = [];
  const decided: string[] = [];
  const lines: string[] = [];
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
    signOut: (name, url) => mcpOAuth.signOut(name, url),
    testAs: () => null,
    redeem: (raw) => vault.redeem(raw, owner, (path) => path.length === 2 && (path[0] === "env" || path[0] === "headers" || (path[0] === "oauth" && path[1] === "clientSecret")), "mcp_server's env, headers and oauth.clientSecret"),
    addToBotList: (name) => { listedOn.push({ bot: sender.id, name }); },
    botAdd: (current, raw) => addBotMcpServer(current, raw, BOT, dataDir, false),
    ownCwd: () => dataDir,
    decide: (summary) => { decided.push(summary); },
    activity: (label) => { lines.push(label); },
    language: () => undefined,
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
  return { cfg, config, mcpOAuth, deps, sender, call, post, stored, ref, listedOn, decided, lines, dataDir };
}

function probeWith(result: probeModule.McpProbeResult) {
  return vi.spyOn(probeModule, "probeMcpServer").mockResolvedValue(result);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("internal mcp_server route, Full access", () => {
  it("add saves the server on, tests it as the bot and returns the tool names", async () => {
    const probe = probeWith({ ok: true, tools: [{ name: "search_notes" }, { name: "create_note" }] });
    const { post, stored, dataDir, decided } = fixture();
    const { status, body } = await post({ action: "add", name: "notes", command: "notes-mcp", args: ["--stdio"] });
    expect(status).toBe(201);
    expect(stored("notes")).toMatchObject({ command: "notes-mcp", args: ["--stdio"], enabled: true });
    expect(probe.mock.calls[0]?.[3]).toMatchObject({ asBot: { id: BOT, cwd: dataDir } });
    expect(body.text).toContain("search_notes, create_note");
    expect(body.text).toContain("The new tools arrive on your next turn.");
    expect(decided).toHaveLength(1);
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

  it("refuses a server that runs on another computer", async () => {
    const { post, stored } = fixture({ servers: { notes: { ...notes, enabled: false, runsOn: MAC } } });
    const out = await post({ action: "enable", name: "notes" });
    expect(out).toEqual({ status: 403, body: { error: "This server runs on Ada's Mac, so it can't be changed here." } });
    expect(stored("notes")?.enabled).toBe(false);
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
    for (const action of ["list", "add", "update", "enable", "disable", "test", "sign_in", "sign_out", "remove"]) {
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

  it("update swaps a resupplied secretRef, padded or not, and keeps it when the destination moves", async () => {
    probeWith({ ok: true, tools: [] });
    const { post, ref, stored } = fixture({ servers: { notes } });
    const key = ref("fresh-token");
    const { body } = await post({ action: "update", name: "notes", args: ["-y", "notes-mcp@2"], env: { NOTES_TOKEN: `  ${key} ` } });
    expect(stored("notes")).toMatchObject({ args: ["-y", "notes-mcp@2"], env: { NOTES_TOKEN: "fresh-token" } });
    expect(body.dropped).toBeUndefined();
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
  it("add saves the server off and changes nothing else", async () => {
    const probe = probeWith({ ok: true, tools: [] });
    const { post, stored, lines } = fixture({ full: false });
    const { status, body } = await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" });
    expect(status).toBe(201);
    expect(stored("linear")?.enabled).toBe(false);
    expect(body.text).toContain("switched off");
    expect(probe).not.toHaveBeenCalled();
    expect(lines).toEqual(["Added MCP server linear · Off"]);
  });

  it("update, enable and remove ask the person to change it in Settings", async () => {
    const { post, cfg } = fixture({ full: false, servers: { linear: { ...linear, enabled: false } } });
    for (const action of ["update", "enable", "remove"]) {
      const out = await post({ action, name: "linear", url: "https://mcp.linear.app/v2" });
      expect(out.status, action).toBe(403);
      expect(out.body.error, action).toContain("Ask the person to change this in Settings");
    }
    expect(cfg.mcpServers).toEqual({ linear: { ...linear, enabled: false } });
  });

  it("sign_in is not built yet", async () => {
    const { post } = fixture({ servers: { linear } });
    expect(await post({ action: "sign_in", name: "linear" })).toEqual({ status: 501, body: { error: "Not yet" } });
  });

  it("an existing name says to use update", async () => {
    const { post } = fixture({ servers: { linear } });
    expect(await post({ action: "add", name: "linear", url: "https://mcp.linear.app/mcp" }))
      .toEqual({ status: 409, body: { error: "linear already exists. Use update, or pick another name." } });
  });
});

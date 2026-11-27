// The host as a Team Cloud runs it: a real sign-in store and a fake authorization server on loopback. No real service is
// called and HOME is a temporary folder.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TeamAdminSummary } from "../cloud-team-admin.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { createConnectionHealthHost, type ConnectionHealthHostDeps } from "./connection-health-host.ts";

let root = "", tokenUrl = "", answer: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
let tokenServer: Server;
const realHome = process.env.HOME;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omb-health-host-"));
  process.env.HOME = join(root, "home");
  tokenServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body)));
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  const address = tokenServer.address();
  tokenUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/token`;
});
afterAll(async () => {
  process.env.HOME = realHome;
  await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const TRACKER = "https://tracker.example/mcp?token=query-never-shown";
const NOTES = "https://notes.example/mcp";
const servers = {
  tracker: { type: "http", url: TRACKER, headers: {} },
  flaky: { type: "http", url: "https://flaky.example/mcp", headers: { "X-Api-Key": "key-never-shown" } },
  notes: { type: "http", url: NOTES, headers: {} },
};
const ROSTER = [{ email: "ada@acme.test" }, { email: "ben@acme.test" }, { email: "cleo@acme.test" }];
const keyOf = (email: string) => `p_${email.split("@")[0]}`;
const signIn = (manager: McpOAuthManager, name: string, url: string, tokens: { access: string; refresh?: string; expiresAt?: number }) =>
  manager.adopt(name, url, { url, state: "signed-in", clientId: "client-1", tokenEndpoint: tokenUrl, tokens });

let dir = "", host: ReturnType<typeof createConnectionHealthHost>, teamOAuth: McpOAuthManager, own: Record<string, McpOAuthManager>;
let ownApps: Array<{ person: string; email: string; services: Record<string, { connected: boolean; pending: boolean; status: string; accounts: { id: string; status: string }[] }> | null }>;
let turnPerson: string | null;
const START = Date.parse("2026-11-10T10:00:00Z");
let now = START;

beforeEach(() => {
  now = START;
  dir = mkdtempSync(join(root, "data-"));
  turnPerson = null;
  ownApps = [];
  const refreshed: Array<(person: string | null, name: string, outcome: Parameters<NonNullable<ConstructorParameters<typeof McpOAuthManager>[0]["onRefresh"]>>[1]) => void> = [];
  teamOAuth = new McpOAuthManager({ file: join(dir, "mcp-oauth.json"), onRefresh: (name, outcome) => refreshed[0]?.(null, name, outcome) });
  own = Object.fromEntries(ROSTER.map(({ email }) => [keyOf(email), new McpOAuthManager({ file: join(dir, `${keyOf(email)}.json`), onRefresh: (name, outcome) => refreshed[0]?.(keyOf(email), name, outcome) })]));
  const deps: ConnectionHealthHostDeps<{ name: string; servers: string[]; hidden?: boolean; defaultBot?: { person?: string }; connectorScopes?: { apps: Record<string, unknown> } }> = {
    dataDir: dir,
    mcpServers: () => servers,
    mcpOAuth: teamOAuth,
    connections: {
      personMcp: () => ["notes"], personApps: () => ["gmail"], turnPerson: () => turnPerson,
      ownAppsServices: async () => ownApps,
      people: { oauth: (person) => own[person]!, key: () => null, appsAccess: () => null },
    },
    bots: () => [
      { name: "Scout", servers: ["tracker", "flaky"] },
      { name: "Clerk", servers: ["tracker"], connectorScopes: { apps: { slack: "read" } } },
      { name: "Old", servers: ["tracker"], hidden: true },
      { name: "MausBot", servers: ["tracker"], defaultBot: { person: "ada@acme.test" } },
    ],
    botServers: (bot) => bot.servers,
    roster: () => ROSTER,
    personKey: keyOf,
    personName: (email) => (email === "olive@acme.test" ? "Olive" : null),
    asleep: () => false, wokeAt: () => null,
    now: () => now,
  };
  host = createConnectionHealthHost(deps);
  refreshed.push(host.refreshed);
});

const summary = (): TeamAdminSummary => ({
  v: 1,
  apps: { available: true, services: [{ slug: "slack", status: "ACTIVE", accounts: [{ id: "ca_1", alias: null, status: "ACTIVE" }] }, { slug: "github", status: "EXPIRED", accounts: [{ id: "ca_2", alias: null, status: "EXPIRED" }] }] },
  mcp: Object.entries(servers).map(([name, server]) => ({ name, transport: "http" as const, host: new URL(server.url).host, enabled: true,
    signedIn: teamOAuth.authState(name, server.url) === "none" ? null : teamOAuth.authState(name, server.url) === "signed-in", secrets: Object.keys(server.headers) })),
  keys: [], ai: { keys: [], engines: [] },
  scopes: { apps: ["gmail"], mcp: ["notes"] },
  people: { apps: { gmail: [] }, mcp: { notes: [] } },
});
const read = async () => {
  const out = await host.adminRead(summary());
  return { out, mcp: Object.fromEntries(out.mcp.map((entry) => [entry.name, entry])), apps: Object.fromEntries(out.apps.services.map((entry) => [entry.slug, entry])) };
};
const step = (tool: string, ok: boolean, output?: string) => host.toolStep({ threadId: "t1", tool, ok, ...(output === undefined ? {} : { output }) });
const REFUSED_401 = 'The MCP server "tracker" refused the sign-in or key it was sent (HTTP 401), so nothing ran.';

describe("health from real calls", () => {
  it("a 401 on a tool call renews the sign-in; when the server refuses the renewal, the sign-in ends and it needs a sign-in", async () => {
    signIn(teamOAuth, "tracker", TRACKER, { access: "access-never-shown", refresh: "refresh-never-shown", expiresAt: now + 3_600_000 });
    await step("mcp__tracker__list_issues", true, "[]");
    expect((await read()).mcp.tracker).toMatchObject({ health: "working", lastUsedAt: "2026-11-10T10:00:00.000Z" });
    answer = { status: 400, body: { error: "invalid_grant" } };
    await step("mcp__tracker__list_issues", false, REFUSED_401);
    expect(teamOAuth.authState("tracker", TRACKER)).toBe("needs-sign-in");
    const { mcp, out } = await read();
    expect(mcp.tracker).toMatchObject({ signedIn: false, health: "needs-sign-in", lastError: "sign-in" });
    expect(JSON.stringify(out)).not.toMatch(/never-shown|token=|Bearer/);
  });

  it("a 401 the renewal fixes leaves it as it was, and the next call says how it is", async () => {
    signIn(teamOAuth, "tracker", TRACKER, { access: "old-never-shown", refresh: "refresh-never-shown", expiresAt: now + 3_600_000 });
    await step("mcp__tracker__list_issues", true, "[]");
    answer = { status: 200, body: { access_token: "new-never-shown", expires_in: 3600 } };
    await step("mcp__tracker__list_issues", false, REFUSED_401);
    expect([teamOAuth.authState("tracker", TRACKER), await teamOAuth.accessToken("tracker", TRACKER)]).toEqual(["signed-in", "new-never-shown"]);
    expect((await read()).mcp.tracker.health).toBe("working");
  });

  it("a refresh rejected as a turn starts marks it needs a sign-in", async () => {
    signIn(teamOAuth, "tracker", TRACKER, { access: "a-never-shown", refresh: "r-never-shown", expiresAt: Date.now() - 1_000 });
    answer = { status: 401, body: { error: "invalid_client" } };
    expect(await teamOAuth.accessToken("tracker", TRACKER)).toBeNull();
    expect((await read()).mcp.tracker).toMatchObject({ health: "needs-sign-in", lastError: "refresh-rejected" });
  });

  it("a key the server refuses is refused; a network failure counts once it repeats; a success after it is working", async () => {
    await step("mcp__flaky__search", false, "HTTP 401 dialing https://flaky.example/mcp");
    expect((await read()).mcp.flaky).toMatchObject({ health: "refused", lastError: "refused" });
    await step("mcp__flaky__search", false, "ECONNREFUSED 127.0.0.1:443");
    expect((await read()).mcp.flaky.health).toBe("refused");
    now += 60_000;
    await step("mcp__flaky__search", false, "Error: MCP error -32001: Request timed out");
    expect((await read()).mcp.flaky).toMatchObject({ health: "unreachable", lastError: "timeout", checkedAt: "2026-11-10T10:01:00.000Z" });
    now += 60_000;
    await step("mcp__flaky__search", false, "thread not found");
    expect((await read()).mcp.flaky).toEqual(expect.objectContaining({ health: "working", checkedAt: "2026-11-10T10:02:00.000Z", lastUsedAt: "2026-11-10T10:02:00.000Z" }));
    expect((await read()).mcp.flaky.lastError).toBeUndefined();
  });

  it("an app call's failure and a provider's own status both show, normalised", async () => {
    const reply = (text: string) => new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
    host.appCall({ slugs: ["SLACK_SEND_MESSAGE"], status: 200, bytes: reply(JSON.stringify({ successful: false, error: "token_revoked: the token has been revoked" })), contentType: "application/json" });
    const { apps } = await read();
    expect(apps.slack).toMatchObject({ health: "needs-sign-in", lastError: "sign-in", lastUsedAt: "2026-11-10T10:00:00.000Z", accounts: [{ id: "ca_1", status: "ACTIVE", health: "working" }] });
    expect(apps.github).toMatchObject({ health: "needs-sign-in", lastError: "account-inactive", accounts: [{ status: "EXPIRED", health: "needs-sign-in" }] });
    host.appCall({ slugs: ["SLACK_SEND_MESSAGE"], status: 200, bytes: reply(JSON.stringify({ successful: true })), contentType: "application/json" });
    expect((await read()).apps.slack.health).toBe("working");
  });

  it("does not expire a working app because its error metadata names resource 401", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Message not found", resource: "/messages/401" }) }] },
    }));
    host.appCall({ slugs: ["SLACK_SEND_MESSAGE"], status: 200, bytes, contentType: "application/json" });
    const { apps } = await read();
    expect(apps.slack).toMatchObject({ health: "working", lastUsedAt: "2026-11-10T10:00:00.000Z" });
    expect(apps.slack.lastError).toBeUndefined();
  });
});

describe("the admin read", () => {
  it("says who added a connection and when, which team bots use it, and when a sign-in nothing can refresh ends", async () => {
    host.added("mcp", "tracker", "Olive@acme.test");
    host.added("app", "slack", "ben@acme.test");
    signIn(teamOAuth, "tracker", TRACKER, { access: "a-never-shown", expiresAt: now + 86_400_000 });
    const { mcp, apps } = await read();
    expect(mcp.tracker).toMatchObject({ addedBy: { email: "olive@acme.test", name: "Olive" }, addedAt: "2026-11-10T10:00:00.000Z", bots: ["Scout", "Clerk"], expiresAt: "2026-11-11T10:00:00.000Z" });
    expect(mcp.flaky).toMatchObject({ bots: ["Scout"] });
    expect(mcp.flaky.addedBy).toBeUndefined();
    expect(apps.slack).toMatchObject({ addedBy: { email: "ben@acme.test", name: null }, bots: ["Scout", "Clerk"] });
    expect(apps.github.bots).toEqual(["Scout"]);
    teamOAuth.forget("tracker");
    signIn(teamOAuth, "tracker", TRACKER, { access: "a-never-shown", expiresAt: now - 1 });
    expect((await read()).mcp.tracker).toMatchObject({ health: "needs-sign-in", lastError: "expired" });
  });

  it("forgets what it kept about a connection once it is removed", async () => {
    host.added("mcp", "tracker", "olive@acme.test");
    host.removed("mcp", "tracker");
    expect((await read()).mcp.tracker.addedBy).toBeUndefined();
  });
});

describe("each person's own", () => {
  it("states three members' own connections: connected, needs a sign-in, not connected", async () => {
    signIn(own.p_ada!, "notes", NOTES, { access: "ada-never-shown" });
    signIn(own.p_ben!, "notes", NOTES, { access: "ben-never-shown" });
    own.p_ben!.markNeedsSignIn("notes", NOTES);
    ownApps = [
      { person: "p_ada", email: "ada@acme.test", services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "a", status: "ACTIVE" }] } } },
      { person: "p_ben", email: "ben@acme.test", services: { gmail: { connected: false, pending: false, status: "EXPIRED", accounts: [{ id: "b", status: "EXPIRED" }] } } },
    ];
    const { out } = await read();
    expect(out.people?.states).toEqual({
      mcp: { notes: { "ada@acme.test": "connected", "ben@acme.test": "needs-sign-in", "cleo@acme.test": "not-connected" } },
      apps: { gmail: { "ada@acme.test": "connected", "ben@acme.test": "needs-sign-in", "cleo@acme.test": "not-connected" } },
    });
    // Their own call refused: Ada needs to sign in again, and it says so.
    turnPerson = "p_ada";
    answer = { status: 400, body: { error: "invalid_grant" } };
    await host.toolStep({ threadId: "ada-private", tool: "mcp__notes__search", ok: false, output: 'The MCP server "notes" needs a sign-in before its tools work (HTTP 401)' });
    expect((await read()).out.people?.states?.mcp.notes?.["ada@acme.test"]).toBe("needs-sign-in");
  });

  it("says nothing about what a member did, a connection nobody asked them for, or someone not on the team", async () => {
    signIn(own.p_ada!, "notes", NOTES, { access: "ada-never-shown" });
    ownApps = [{ person: "p_ada", email: "ada@acme.test", services: {
      gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "a", status: "ACTIVE" }] },
      dropbox: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "d", status: "ACTIVE" }] },
    } }, { person: "p_zed", email: "zed@acme.test", services: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] } } }];
    turnPerson = "p_ada";
    await host.toolStep({ threadId: "ada-private", tool: "mcp__notes__search", ok: true, output: "[]" });
    host.appCall({ person: "p_ada", slugs: ["GMAIL_FETCH_EMAILS"], status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{\"successful\":true}" }] } })), contentType: "application/json" });
    // Not asked of everyone, so a turn that acts for nobody has no own server: nothing is kept.
    turnPerson = null;
    await host.toolStep({ threadId: "room", tool: "mcp__notes__search", ok: false, output: "ECONNREFUSED" });
    const { out, mcp } = await read();
    expect(Object.keys(out.people?.states?.apps ?? {})).toEqual(["gmail"]);
    expect(Object.keys(out.people?.states?.apps.gmail ?? {})).toEqual(["ada@acme.test", "ben@acme.test", "cleo@acme.test"]);
    for (const field of ["health", "checkedAt", "lastError", "lastUsedAt", "expiresAt"]) expect(mcp.notes).not.toHaveProperty(field);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/dropbox|zed@|never-shown|ada-private/);
  });
});

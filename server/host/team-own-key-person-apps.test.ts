// A Team Cloud with its own Composio project key: each person's own apps go to that project as their own Composio user,
// and nothing reaches the managed connected-apps service. The real Composio client code (server/composio.ts) runs against
// a loopback project (OMB_COMPOSIO_API) beside a loopback service that records whatever reaches it.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Audience } from "../audience.ts";
import * as composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createTeamConnectionRoutes } from "../routes/team-connections.ts";
import { memberComposioUser } from "../team-connections.ts";
import { startFakeComposioProject, type FakeComposioProject } from "../testing/fake-composio-project.ts";
import { createTeamConnectionsHost } from "./team-connections-host.ts";

const TEAM = { id: "team-acme-1", name: "Acme" };
const KEY = "ak_team_project_key";
const EMAILS = { ada: "ada@acme.test", cleo: "cleo@acme.test", ben: "ben@acme.test" };
const ADA = personKey({ id: "", email: EMAILS.ada }), CLEO = personKey({ id: "", email: EMAILS.cleo }), BEN = personKey({ id: "", email: EMAILS.ben });
const ADA_USER = memberComposioUser(TEAM.id, ADA), CLEO_USER = memberComposioUser(TEAM.id, CLEO);
const SERVICE_TOKEN = "5".repeat(64), ADA_SERVICE_TOKEN = "a".repeat(64);
const AUDIENCES: Record<string, Audience> = { "ada-chat": `member:${ADA}`, "cleo-chat": `member:${CLEO}`, "room-chat": "room:launch", "main-chat": "team" };
const GMAIL_CALL = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] } } };

let project: FakeComposioProject;
let service: { url: string; requests: string[]; server: Server };
let fetched: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  project = await startFakeComposioProject(KEY);
  const requests: string[] = [];
  let installs = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/installations") return res.end(JSON.stringify({ installationId: `inst-${++installs}`, token: String(installs).repeat(64).slice(0, 64) }));
    if (req.url?.endsWith("/authorize")) return res.end(JSON.stringify({ url: "https://backend.composio.dev/link/lk_service" }));
    return res.end(JSON.stringify({ services: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  service = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, server };
});

afterAll(async () => {
  await project.close();
  service.server.closeAllConnections();
  await new Promise<void>((resolve) => service.server.close(() => resolve()));
});

beforeEach(() => {
  fetched = [];
  service.requests.length = 0;
  project.requests.length = 0; project.toolCalls.length = 0; project.links.length = 0; project.accounts.length = 0; project.down = false;
  vi.stubEnv("OMB_COMPOSIO_API", project.api);
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  });
  // The installation a Team Cloud made on the service before its admin saved a key is still held.
  composio.setManagedBrokerAccess({ url: service.url, token: SERVICE_TOKEN });
});

afterEach(() => {
  composio.setManagedBrokerAccess(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup(options: { key?: string | null; dataDir?: string; requester?: Record<string, string>; refuse?: string } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "omb-team-own-key-"));
  const cfg = { composio: options.key === null ? {} : { apiKey: options.key ?? KEY, userId: "openmausbot_team" } } as AppConfig;
  const requester: Record<string, string> = { "ada-chat": ADA, "cleo-chat": CLEO, "room-chat": ADA, "main-chat": ADA, ...options.requester };
  const host = createTeamConnectionsHost({
    team: TEAM, dataDir, cfg: () => cfg, adminOrigin: "https://cloud.example.test", harnessUrl: "http://127.0.0.1:1",
    audienceOf: (threadId) => AUDIENCES[threadId] ?? "team",
    requester: (threadId) => requester[threadId] ?? null,
    roster: () => [{ person: BEN, email: EMAILS.ben, role: "admin" as const }, { person: ADA, email: EMAILS.ada, role: "member" as const }, { person: CLEO, email: EMAILS.cleo, role: "member" as const }],
    mint: (capability) => `tok-${capability.threadId}-${capability.connectorsFor ?? "team"}`,
    mcpOAuth: new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json") }),
    botMcp: () => ({}), isOwnerLive: () => true, brokerUrl: () => service.url, composio,
  });
  host.scopes.set("app", "gmail", "person");
  const route = createTeamConnectionRoutes({
    host, cfg: () => cfg, composio, publicOrigin: null,
    policy: { appRefusal: () => options.refuse, mcpRefusal: () => undefined },
  });
  const as = async (email: string, method: string, path: string) => {
    const auth: RequestAuth = { kind: "session", via: "bearer", scopes: ["client"], session: {
      id: `s-${email}`, tokenHash: "0".repeat(64), label: "Desktop", scopes: ["client"], createdAt: 1, lastSeenAt: 1, expiresAt: 9_000,
      email, teamRole: "member", membershipAuthority: "team",
    } };
    let answer: { status: number; body: any } | undefined;
    await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://localhost${path}`), path, method, auth,
      json: (_res, status, body) => { answer = { status, body }; }, readBody: async () => ({}),
    });
    return answer!;
  };
  /** One tool call through a member's own bridge, as the relay makes it once `relayActor` let it through. */
  const ownCall = async (threadId: string, person: string) => {
    const actor = host.relayActor({ threadId, generation: "g", connectorsFor: person });
    if (actor.refusal) return { refusal: actor.refusal };
    const [asThem, installation] = host.via(actor.access);
    const answer = await composio.relayMcp(asThem, GMAIL_CALL, undefined, undefined, undefined, installation);
    return { text: new TextDecoder().decode(answer.bytes) };
  };
  const stored = () => JSON.parse(readFileSync(join(dataDir, "people-connections", "project-apps.json"), "utf8")) as { people: Record<string, { userId: string; sessionId?: string; again?: true }>; removals: string[] };
  /** As a member's installation on the service was saved, before the team had a key. */
  const onService = (person: string, email: string, token: string) => (host.people as unknown as { write(name: string, value: unknown): void })
    .write("apps.json", { v: 1, brokerUrl: service.url, people: { [person]: { email, installationId: `inst-${email}`, token } } });
  const connect = async (email: string, user: string) => {
    const started = await as(email, "POST", "/api/team/my-connections/apps/gmail/connect");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    return project.connect(user, "gmail");
  };
  const myGmail = async (email: string) => (await as(email, "GET", "/api/team/my-connections")).body.apps[0] as { connected: boolean; reconnect?: true };
  return { host, cfg, dataDir, as, ownCall, stored, onService, connect, myGmail };
}

const offService = () => {
  expect(service.requests, "requests that reached the managed connected-apps service").toEqual([]);
  expect(fetched.filter((url) => !url.startsWith(project.origin)), "requests that left for anywhere but the team's project").toEqual([]);
};

describe("each person's own apps with the team's own Composio key", () => {
  it("connects, lists, calls, disconnects and removes on leaving in the team's project, and sends the service nothing", async () => {
    const { host, cfg, as, ownCall, connect, myGmail } = setup();
    expect(ADA_USER).toMatch(/^omb_member_[0-9a-f]{32}$/);
    expect(ADA_USER).not.toBe(CLEO_USER);
    expect(await myGmail(EMAILS.ada)).toEqual({ slug: "gmail", name: "Gmail", connected: false, accounts: [] });

    const started = await as(EMAILS.ada, "POST", "/api/team/my-connections/apps/gmail/connect");
    expect(started).toMatchObject({ status: 200, body: { url: expect.stringMatching(/^https:\/\/backend\.composio\.dev\/link\//) } });
    expect(project.links).toEqual([{ user: ADA_USER, toolkit: "gmail" }]);
    const adaAccount = project.connect(ADA_USER, "gmail");
    const cleoAccount = await connect(EMAILS.cleo, CLEO_USER);
    const teamAccount = project.connect("openmausbot_team", "slack");

    expect(await myGmail(EMAILS.ada)).toMatchObject({ connected: true, accounts: [{ id: adaAccount, status: "ACTIVE" }] });
    expect(await myGmail(EMAILS.cleo)).toMatchObject({ connected: true, accounts: [{ id: cleoAccount, status: "ACTIVE" }] });
    expect((await host.adminExtras()).people).toMatchObject({ apps: { gmail: [EMAILS.ada, EMAILS.cleo] } });

    expect((await ownCall("ada-chat", ADA)).text).toContain(adaAccount);
    expect((await ownCall("cleo-chat", CLEO)).text).toContain(cleoAccount);
    expect(project.toolCalls.map((call) => call.user)).toEqual([ADA_USER, CLEO_USER]);
    // The team's own bridge is the team's Composio user: it holds neither member's Gmail.
    const team = new TextDecoder().decode((await composio.relayMcp(cfg, GMAIL_CALL)).bytes);
    expect(team).toContain(teamAccount);
    expect(team).not.toContain(adaAccount);
    expect(Object.keys(await composio.connectedServices(cfg))).toEqual(["slack"]);
    expect(cfg.composio?.userId, "the team's saved Composio user is never a member's").toBe("openmausbot_team");

    expect(await as(EMAILS.ada, "DELETE", "/api/team/my-connections/apps/gmail")).toEqual({ status: 200, body: { ok: true } });
    expect(project.accounts.map((account) => account.id).sort()).toEqual([cleoAccount, teamAccount].sort());
    expect((await myGmail(EMAILS.ada)).connected).toBe(false);

    const again = project.connect(ADA_USER, "gmail");
    await host.forgetPerson(ADA);
    expect(project.accounts.map((account) => account.id), "her connections left the project with her").not.toContain(again);
    expect(project.accounts.map((account) => account.id).sort()).toEqual([cleoAccount, teamAccount].sort());
    expect(host.relayActor({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/own apps aren't connected here any more/);

    expect(project.requests.every((request) => request.apiKey === KEY)).toBe(true);
    offService();
  });

  it("never uses one member's connection for another member, an admin, a shared chat or work that acts for nobody", async () => {
    const { host, ownCall, connect } = setup();
    const adaAccount = await connect(EMAILS.ada, ADA_USER);
    await connect(EMAILS.cleo, CLEO_USER);

    for (const [thread, person, why] of [["cleo-chat", ADA, "her bridge in Cleo's chat"], ["ada-chat", CLEO, "Cleo's bridge in her chat"], ["room-chat", ADA, "a room reads it"], ["main-chat", ADA, "the bot's main chat"]] as const) {
      expect((await ownCall(thread, person)).refusal, why).toMatch(/no longer acts for/);
    }
    const admin = setup({ requester: { "ada-chat": BEN } });
    await admin.host.people.ensureAppsAccess(ADA, EMAILS.ada);
    expect((await admin.ownCall("ada-chat", ADA)).refusal, "an admin writing in her chat").toMatch(/no longer acts for/);
    const routine = setup({ requester: { "ada-chat": "" } });
    await routine.host.people.ensureAppsAccess(ADA, EMAILS.ada);
    expect((await routine.ownCall("ada-chat", ADA)).refusal, "a routine in her chat").toMatch(/no longer acts for/);
    expect(project.toolCalls, "no refused call reached Composio").toEqual([]);

    const bot = { id: "scout", name: "Scout" };
    expect((await host.appsIntegrations(bot, "ada-chat", "g")).composioOwn).toBeDefined();
    for (const thread of ["room-chat", "main-chat"]) expect((await host.appsIntegrations(bot, thread, "g")).composioOwn, thread).toBeUndefined();
    expect((await admin.host.appsIntegrations(bot, "ada-chat", "g")).composioOwn).toBeUndefined();

    expect((await ownCall("cleo-chat", CLEO)).text).not.toContain(adaAccount);
    expect(project.toolCalls.map((call) => call.user)).toEqual([CLEO_USER]);
    offService();
  });

  it("uses a member's Session only while it is their own Composio user's", async () => {
    const first = setup();
    const adaAccount = await first.connect(EMAILS.ada, ADA_USER);
    const teamAccount = project.connect("openmausbot_team", "gmail");
    await composio.relayMcp(first.cfg, GMAIL_CALL);
    const teamSession = [...project.sessions].find(([, user]) => user === "openmausbot_team")![0];
    const file = first.stored();
    file.people[ADA]!.sessionId = teamSession;
    (first.host.people as unknown as { write(name: string, value: unknown): void }).write("project-apps.json", file);

    const restarted = setup({ dataDir: first.dataDir });
    const answer = (await restarted.ownCall("ada-chat", ADA)).text!;
    expect(answer).toContain(adaAccount);
    expect(answer).not.toContain(teamAccount);
    expect(project.sessions.get(restarted.stored().people[ADA]!.sessionId!)).toBe(ADA_USER);
  });

  it("removes a leaver's connections later when Composio can't be reached as they leave, and before they can connect again", async () => {
    const { host, stored, connect, as } = setup();
    const account = await connect(EMAILS.ada, ADA_USER);
    project.down = true;
    await host.forgetPerson(ADA);
    expect(stored()).toMatchObject({ people: {}, removals: [ADA_USER] });
    expect(project.accounts.map((entry) => entry.id)).toEqual([account]);
    // She joins again while Composio is still away: no link until what she left is gone.
    expect((await as(EMAILS.ada, "POST", "/api/team/my-connections/apps/gmail/connect")).status).toBe(502);
    project.down = false;
    host.primeApps();
    await expect.poll(() => project.accounts.length).toBe(0);
    await expect.poll(() => stored().removals).toEqual([]);
    offService();
  });

  it("refuses an app the team's rules don't allow before anything is asked of Composio", async () => {
    const { as } = setup({ refuse: "Acme does not allow Gmail. Ask a team admin." });
    expect(await as(EMAILS.ada, "POST", "/api/team/my-connections/apps/gmail/connect")).toEqual({ status: 403, body: { error: "Acme does not allow Gmail. Ask a team admin.", code: "managed_policy" } });
    expect(project.requests).toEqual([]);
    offService();
  });
});

describe("a team that changes where its apps connect", () => {
  it("asks a member who connected on the service to connect again once the team saves a key, and leaves the service alone", async () => {
    const { host, cfg, onService, myGmail, as } = setup();
    onService(ADA, EMAILS.ada, ADA_SERVICE_TOKEN);
    expect(host.people.appsAccess(ADA)).toBeNull();
    expect(await myGmail(EMAILS.ada)).toEqual({ slug: "gmail", name: "Gmail", connected: false, reconnect: true, accounts: [] });
    expect((await myGmail(EMAILS.cleo)).reconnect, "Cleo never connected anything").toBeUndefined();
    const line = await host.callRefusal({ threadId: "ada-chat", generation: "g" }, [{ slug: "GMAIL_FETCH_EMAILS" }]);
    expect(line).toMatch(/needs to connect theirs again: Acme changed where its apps connect/);
    expect(line).toContain('"Connect your Gmail again here: https://cloud.example.test/cloud/team/team-acme-1"');
    expect(await host.adminExtras()).toMatchObject({ appsLeftOnService: 1 });
    offService();

    expect((await as(EMAILS.ada, "POST", "/api/team/my-connections/apps/gmail/connect")).status).toBe(200);
    project.connect(ADA_USER, "gmail");
    expect(await myGmail(EMAILS.ada)).toMatchObject({ connected: true });
    expect((await myGmail(EMAILS.ada)).reconnect).toBeUndefined();
    offService();

    // The key is removed: her installation on the service was kept, so it is hers again.
    cfg.composio = { ...cfg.composio, apiKey: "" };
    expect(host.people.appsAccess(ADA)).toEqual({ url: service.url, token: ADA_SERVICE_TOKEN });
    expect((await host.adminExtras() as { appsLeftOnService?: number }).appsLeftOnService).toBeUndefined();
  });

  it("asks a member who connected in the team's project to connect again once the key is removed or names another project", async () => {
    const { host, cfg, connect, myGmail, stored } = setup();
    await connect(EMAILS.ada, ADA_USER);
    expect(stored().people[ADA]?.sessionId).toBeTruthy();

    cfg.composio = { ...cfg.composio, apiKey: "" };
    expect(host.people.appsAccess(ADA)).toBeNull();
    expect(await myGmail(EMAILS.ada)).toMatchObject({ connected: false, reconnect: true });
    expect(service.requests, "nothing is asked of the service for someone with no installation there").toEqual([]);

    cfg.composio = { ...cfg.composio, apiKey: KEY };
    expect(await myGmail(EMAILS.ada), "the same key again: the same Composio user, still connected").toMatchObject({ connected: true });

    cfg.composio = { ...cfg.composio, apiKey: "ak_another_project" };
    expect(host.people.appsElsewhere(ADA)).toBe(true);
    expect(stored().people[ADA]).toEqual({ email: EMAILS.ada, userId: ADA_USER, again: true });
  });

  it("works with the service switched off and a key, and says an admin must add a key without one", async () => {
    vi.stubEnv("OMB_COMPOSIO_BROKER", "off");
    const keyed = setup();
    await keyed.connect(EMAILS.ada, ADA_USER);
    expect(await keyed.myGmail(EMAILS.ada)).toMatchObject({ connected: true });
    expect((await keyed.ownCall("ada-chat", ADA)).text).toContain(ADA_USER);
    expect((await keyed.as(EMAILS.ada, "GET", "/api/team/my-connections")).body.ownApps).toBeUndefined();
    offService();

    const before = project.requests.length;
    const bare = setup({ key: null });
    expect(await bare.as(EMAILS.ada, "POST", "/api/team/my-connections/apps/gmail/connect")).toEqual({ status: 409, body: {
      error: "Your own apps can't be connected on Acme yet. Ask an admin to add the team's Composio key.",
      errorKey: "serverError.team.ownAppsNeedKey", errorParams: { team: "Acme" }, code: "own_apps_need_key",
    } });
    expect((await bare.as(EMAILS.ada, "GET", "/api/team/my-connections")).body).toMatchObject({ ownApps: "needs-key", apps: [{ slug: "gmail", connected: false }] });
    expect(await bare.host.callRefusal({ threadId: "ada-chat", generation: "g" }, [{ slug: "GMAIL_FETCH_EMAILS" }]))
      .toContain(`"Gmail can't be connected on Acme yet. Ask an admin to add the team's Composio key."`);
    expect(project.requests.length).toBe(before);
    offService();
  });

  it("keeps a member's apps on the service while the team has no key", async () => {
    const { as, host, dataDir } = setup({ key: null });
    const started = await as(EMAILS.ada, "POST", "/api/team/my-connections/apps/gmail/connect");
    expect(started).toEqual({ status: 200, body: { url: "https://backend.composio.dev/link/lk_service" } });
    expect(service.requests).toEqual(["POST /v1/installations", "POST /v1/connectors/gmail/authorize"]);
    expect(host.people.appsAccess(ADA)).toMatchObject({ url: service.url });
    expect((await as(EMAILS.ada, "GET", "/api/team/my-connections")).body).not.toHaveProperty("ownApps");
    expect(() => readFileSync(join(dataDir, "people-connections", "project-apps.json"))).toThrow();
    expect(project.requests).toEqual([]);
  });
});

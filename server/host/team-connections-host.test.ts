import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Audience } from "../audience.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { personKey } from "../person-key.ts";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { createTeamConnectionsHost } from "./team-connections-host.ts";

const ADA = personKey({ id: "", email: "ada@acme.test" });
const BEN = personKey({ id: "", email: "ben@acme.test" });
const CLEO = personKey({ id: "", email: "cleo@acme.test" });
const ADA_ACCESS = { url: "https://broker.test", token: "a".repeat(64) };

/** Ada's private chat (she or Ben, an admin, may write in it), Cleo's, a group chat and the bot's main chat. */
const AUDIENCES: Record<string, Audience> = { "ada-chat": `member:${ADA}`, "cleo-chat": `member:${CLEO}`, "room-chat": "room:launch", "main-chat": "team" };

function setup(options: { team?: boolean; requester?: Record<string, string>; servers?: Record<string, unknown> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-connections-"));
  const requester = { "ada-chat": ADA, "cleo-chat": CLEO, "room-chat": ADA, "main-chat": ADA, ...options.requester };
  const cfg = { mcpServers: options.servers ?? {
    mail: { type: "http", url: "https://mail.example/mcp", headers: { Authorization: "Bearer team-mail-key" }, enabled: true },
    console: { type: "http", url: "https://console.example/mcp", headers: { Authorization: "Bearer team-console-key" }, enabled: true },
  } } as unknown as AppConfig;
  const minted: Array<{ threadId: string; connectorsFor?: string }> = [];
  const composio = {
    configured: () => true,
    mcpIntegration: vi.fn(async (_cfg: AppConfig, context: { commsToken: string; as?: unknown }) => ({ command: "node", args: ["bridge"], env: { TOKEN: context.commsToken, AS: context.as ? "own" : "team" } })),
    connectedServices: vi.fn(async (_cfg: AppConfig, as?: { token: string }) => (as?.token === ADA_ACCESS.token
      ? { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE", alias: "ada@gmail.example" }] } } : {})),
    connectedServiceSlugs: vi.fn(async () => ["google_search_console"] as readonly string[]),
    authorizeService: vi.fn(),
    removeService: vi.fn(),
  };
  const host = createTeamConnectionsHost({
    team: options.team === false ? null : { id: "team-acme-1", name: "Acme" },
    dataDir, cfg: () => cfg, adminOrigin: "https://cloud.example.test", harnessUrl: "http://127.0.0.1:1",
    audienceOf: (threadId) => (options.team === false ? "team" : AUDIENCES[threadId] ?? "team"),
    requester: (threadId) => requester[threadId as keyof typeof requester] ?? null,
    mint: (capability) => { minted.push(capability); return `tok-${capability.threadId}-${capability.connectorsFor ?? "team"}`; },
    mcpOAuth: new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json") }),
    botMcp: () => Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).map(([name, raw]) => {
      const server = raw as { url: string; headers: Record<string, string> };
      return [name, { type: "http", url: server.url, headers: server.headers } as McpServerSpec];
    })),
    isSessionLive: () => true,
    brokerUrl: () => ADA_ACCESS.url,
    composio: composio as never,
  });
  return { host, dataDir, minted, composio };
}

/** Ada has her own installation, and her own key for the mail server; Gmail and mail are each person's. */
function adaConnected(host: ReturnType<typeof setup>["host"], dataDir: string) {
  host.scopes.set("app", "gmail", "person");
  host.scopes.set("mcp", "mail", "person");
  const file = join(dataDir, "people-connections", "apps.json");
  host.people.putKey(ADA, "ada@acme.test", "mail", { url: "https://mail.example/mcp", header: "Authorization", value: "Bearer ada-own-mail-key" });
  // As ensureAppsAccess saves it after the service registered her.
  (host.people as unknown as { write(name: string, value: unknown): void }).write("apps.json", { v: 1, brokerUrl: ADA_ACCESS.url, people: { [ADA]: { email: "ada@acme.test", installationId: "inst-ada", token: ADA_ACCESS.token } } });
  return file;
}

describe("whose connection a turn may use", () => {
  it("defaults every app and server to the team's", () => {
    const { host } = setup();
    expect(host.scopes.scope("app", "gmail")).toBe("team");
    expect(host.scopes.scope("mcp", "mail")).toBe("team");
    expect(host.personApps()).toEqual([]);
  });

  it("is a member only in her private chat, and only for her own message", () => {
    const { host } = setup({ requester: { "ada-chat": ADA } });
    expect(host.turnPerson("ada-chat")).toBe(ADA);
    expect(host.turnPerson("room-chat"), "a group chat is nobody's own").toBeNull();
    expect(host.turnPerson("main-chat"), "the bot's main chat is the team's").toBeNull();
    expect(host.turnPerson("cleo-chat")).toBe(CLEO);
    const admin = setup({ requester: { "ada-chat": BEN } }).host;
    expect(admin.turnPerson("ada-chat"), "an admin writing in Ada's chat is not Ada").toBeNull();
    const routine = setup({ requester: { "ada-chat": "" } }).host;
    expect(routine.turnPerson("ada-chat"), "a routine or a webhook proves nobody").toBeNull();
    expect(setup({ team: false }).host.turnPerson("ada-chat"), "off a team nothing is anyone's").toBeNull();
  });
});

describe("apps each person connects", () => {
  it("mounts a member's own bridge only in her own turn, minted for her", async () => {
    const { host, dataDir, minted } = setup();
    adaConnected(host, dataDir);
    const own = await host.appsIntegrations({ id: "scout", name: "Scout" }, "ada-chat", "gen-1");
    expect(own.composio?.env.AS).toBe("team");
    expect(own.composioOwn?.env.AS).toBe("own");
    expect(minted.map((entry) => entry.connectorsFor)).toEqual([undefined, ADA]);
    for (const thread of ["room-chat", "main-chat", "cleo-chat"]) {
      const elsewhere = await host.appsIntegrations({ id: "scout", name: "Scout" }, thread, "gen-1");
      expect(elsewhere.composio, thread).toBeDefined();
      expect(elsewhere.composioOwn, thread).toBeUndefined();
    }
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect((await admin.host.appsIntegrations({ id: "scout", name: "Scout" }, "ada-chat", "gen-1")).composioOwn).toBeUndefined();
  });

  it("relays a member's own bridge to her installation, and refuses it once the turn isn't hers", () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    expect(host.relayActor({ threadId: "ada-chat", generation: "g", connectorsFor: ADA })).toEqual({ access: ADA_ACCESS });
    expect(host.relayActor({ threadId: "ada-chat", generation: "g" })).toEqual({});
    expect(host.relayActor({ threadId: "cleo-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/one person's own apps/);
    expect(host.relayActor({ threadId: "room-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/one person's own apps/);
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect(admin.host.relayActor({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/one person's own apps/);
  });

  it("refuses a person's app through the team's bridge, and a team app through her own", async () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    const team = { threadId: "room-chat", generation: "g" };
    expect(await host.callRefusal(team, [{ slug: "GMAIL_FETCH_EMAILS" }])).toMatch(/Gmail is connected by each person in Acme and works only in that person's own private chat/);
    expect(await host.callRefusal(team, [{ slug: "SLACK_SEND_MESSAGE" }]), "a team app passes").toBeNull();
    expect(await host.callRefusal({ threadId: "ada-chat", generation: "g" }, [{ slug: "GMAIL_SEND_EMAIL" }])).toMatch(/through the own_apps tools/);
    expect(await host.callRefusal({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }, [{ slug: "GMAIL_SEND_EMAIL" }])).toBeNull();
    expect(await host.callRefusal({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }, [{ slug: "SLACK_SEND_MESSAGE" }])).toMatch(/Slack is Acme's/);
    expect(await host.callRefusal(team, [{ slug: "COMPOSIO_PROXY_EXECUTE" }]), "no team connection to a person's app").toBeNull();
  });

  it("refuses opaque code on the team's bridge while the team still holds a connection to a person's app", async () => {
    const { host, composio } = setup();
    host.scopes.set("app", "google_search_console", "person");
    expect(await host.callRefusal({ threadId: "room-chat", generation: "g" }, [{ slug: "COMPOSIO_PROXY_EXECUTE" }])).toMatch(/Google Search Console is connected by each person/);
    composio.connectedServiceSlugs.mockResolvedValue([]);
    expect(await host.callRefusal({ threadId: "room-chat", generation: "g" }, [{ slug: "COMPOSIO_PROXY_EXECUTE" }])).toBeNull();
  });

  it("answers a connection card for a person's app with the one plain line, never a card", () => {
    const { host } = setup();
    host.scopes.set("app", "gmail", "person");
    expect(host.connectRefusal({ threadId: "ada-chat", generation: "g" }, ["gmail"])).toContain("\"Connect your Gmail here: https://cloud.example.test/cloud/team/team-acme-1\"");
    expect(host.connectRefusal({ threadId: "room-chat", generation: "g" }, ["gmail"])).toMatch(/can't be used here/);
    expect(host.connectRefusal({ threadId: "room-chat", generation: "g" }, ["slack"]), "a team app keeps its card").toBeNull();
    expect(host.connectRefusal({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }, ["slack"])).toMatch(/ask an admin/);
    expect(setup({ team: false }).host.connectRefusal({ threadId: "ada-chat", generation: "g" }, ["gmail"])).toBeNull();
  });
});

describe("MCP servers each person connects", () => {
  it("gives a member's own turn her key, never the team's, and no other turn either", async () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    const own = await host.turnMcp({}, "ada-chat", "g");
    expect(own.mail).toEqual({ type: "http", url: "https://mail.example/mcp", headers: { Authorization: "Bearer ada-own-mail-key" } });
    expect(own.console, "the team's server is the team's, with its key").toEqual({ type: "http", url: "https://console.example/mcp", headers: { Authorization: "Bearer team-console-key" } });
    for (const thread of ["room-chat", "main-chat", "cleo-chat"]) {
      const elsewhere = await host.turnMcp({}, thread, "g");
      expect(elsewhere.mail, thread).toBeUndefined();
      expect(JSON.stringify(elsewhere), thread).not.toContain("ada-own-mail-key");
      expect(JSON.stringify(elsewhere), thread).not.toContain("team-mail-key");
    }
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect((await admin.host.turnMcp({}, "ada-chat", "g")).mail, "Ben writing in Ada's chat").toBeUndefined();
    expect(host.engineMcp({}).mail, "with no conversation in view: the team's only").toBeUndefined();
  });

  it("pins a member's key to the server's address: re-pointed, it is not sent", async () => {
    const { host, dataDir } = setup({ servers: { mail: { type: "http", url: "https://elsewhere.example/mcp", headers: {}, enabled: true } } });
    adaConnected(host, dataDir);
    expect((await host.turnMcp({}, "ada-chat", "g")).mail).toBeUndefined();
  });

  it("keeps members' keys in a folder of its own that no backup carries", () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    const folder = join(dataDir, "people-connections");
    if (process.platform !== "win32") {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder, "mcp-keys.json")).mode & 0o777).toBe(0o600);
    }
    for (const file of ["people-connections/mcp-keys.json", "people-connections/apps.json", `people-connections/mcp-oauth/${ADA}.json`]) expect(excludedWorkspaceAuthPath(file), file).toBe(true);
    expect(excludedWorkspaceAuthPath("team-connection-scopes.json"), "the scopes hold no secret").toBe(false);
    host.forgetServer("mail");
    expect(readFileSync(join(folder, "mcp-keys.json"), "utf8")).not.toContain("ada-own-mail-key");
    expect(host.scopes.scope("mcp", "mail")).toBe("team");
  });
});

describe("what the bot and the admins are told", () => {
  it("tells her own turn what is hers and how to connect the rest; elsewhere, that it works only in each person's chat", () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    host.scopes.set("app", "outlook", "person");
    const own = host.prompt("ada-chat", { composioOwn: {}, custom: { mail: {} } });
    expect(own).toContain("Gmail and Outlook are ada@acme.test's own: use them through the own_apps tools");
    expect(own).toContain("The MCP server mail acts as ada@acme.test's own account.");
    const missing = host.prompt("ada-chat", { custom: {} });
    expect(missing).toContain("Each person connects these for themselves, and this person hasn't yet: Gmail, Outlook and mail.");
    expect(missing).toContain("\"Connect your <name> here: https://cloud.example.test/cloud/team/team-acme-1\"");
    expect(host.prompt("room-chat", {})).toContain("work only in that person's own private chat with you");
    expect(setup().host.prompt("room-chat", {}), "nothing each person's: nothing said").toBe("");
  });

  it("says who connected what for the admin read, by address, never a secret", async () => {
    const { host, dataDir } = setup();
    adaConnected(host, dataDir);
    const extras = await host.adminExtras();
    expect(extras).toEqual({ scopes: { apps: ["gmail"], mcp: ["mail"] }, people: { apps: { gmail: ["ada@acme.test"] }, mcp: { mail: ["ada@acme.test"] } } });
    expect(JSON.stringify(extras)).not.toMatch(/ada-own-mail-key|aaaaaaaa/);
    expect(await setup({ team: false }).host.adminExtras()).toEqual({});
  });
});

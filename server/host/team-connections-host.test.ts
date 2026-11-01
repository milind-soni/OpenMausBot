import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Audience } from "../audience.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { personKey } from "../person-key.ts";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { appsFromCreator } from "../inherited-apps.ts";
import { APP_TOOLS_ENV } from "../connector-app-tools.ts";
import { createTeamConnectionsHost } from "./team-connections-host.ts";

const ADA = personKey({ id: "", email: "ada@acme.test" });
const BEN = personKey({ id: "", email: "ben@acme.test" });
const CLEO = personKey({ id: "", email: "cleo@acme.test" });
const OLIVE = personKey({ id: "", email: "olive@acme.test" });
const ADA_ACCESS = { url: "https://broker.test", token: "a".repeat(64) };
const CLEO_ACCESS = { url: "https://broker.test", token: "c".repeat(64) };

/** Ada's private chat, Cleo's, Olive's, a group chat, the bot's main chat and a thread a bot opened for work handed on. Who each
 * turn acts for is acting-person.ts's answer (the `requester`); "" is a turn that acts for nobody, as a routine's. */
const AUDIENCES: Record<string, Audience> = {
  "ada-chat": `member:${ADA}`, "cleo-chat": `member:${CLEO}`, "olive-chat": `member:${OLIVE}`, "room-chat": "room:launch", "main-chat": "team", "work-chat": "team",
  // Work her own request handed on, opened in the receiving bot's chat with her (handOnFor); Cleo's likewise.
  "ada-work": `member:${ADA}`, "cleo-work": `member:${CLEO}`,
};

/** The members the Admin paired: Olive owns the team, Ben is an admin, Ada and Cleo are Users. */
const ROSTER = [
  { person: OLIVE, email: "olive@acme.test", role: "owner" as const }, { person: BEN, email: "ben@acme.test", role: "admin" as const },
  { person: ADA, email: "ada@acme.test", role: "member" as const }, { person: CLEO, email: "cleo@acme.test", role: "member" as const },
];

function setup(options: { team?: boolean; requester?: Record<string, string>; servers?: Record<string, unknown>; roster?: typeof ROSTER } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-connections-"));
  const requester = { "ada-chat": ADA, "cleo-chat": CLEO, "room-chat": ADA, "main-chat": ADA, "work-chat": ADA, "ada-work": ADA, "cleo-work": CLEO, ...options.requester };
  const cfg = { mcpServers: options.servers ?? {
    mail: { type: "http", url: "https://mail.example/mcp", headers: { Authorization: "Bearer team-mail-key" }, enabled: true },
    console: { type: "http", url: "https://console.example/mcp", headers: { Authorization: "Bearer team-console-key" }, enabled: true },
  } } as unknown as AppConfig;
  const minted: Array<{ threadId: string; connectorsFor?: string }> = [];
  const composio = {
    configured: () => true,
    mcpIntegration: vi.fn(async (_cfg: AppConfig, context: { commsToken: string; as?: unknown }) => ({ command: "node", args: ["bridge"], env: { TOKEN: context.commsToken, AS: context.as ? "own" : "team" } })),
    connectedServices: vi.fn(async (_cfg: AppConfig, as?: { token: string }) => (as?.token === ADA_ACCESS.token || as?.token === CLEO_ACCESS.token
      ? { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE", alias: "own@gmail.example" }] } } : {})),
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
    ...(options.roster ? { roster: () => options.roster! } : {}),
    brokerUrl: () => ADA_ACCESS.url,
    composio: composio as never,
  });
  return { host, dataDir, minted, composio };
}

/** Ada has her own installation, and her own key for the mail server; Gmail and mail are each person's. With `cleo`, Cleo
 * has her own installation and key too. */
function adaConnected(host: ReturnType<typeof setup>["host"], dataDir: string, options: { cleo?: boolean } = {}) {
  host.scopes.set("app", "gmail", "person");
  host.scopes.set("mcp", "mail", "person");
  const file = join(dataDir, "people-connections", "apps.json");
  host.people.putKey(ADA, "ada@acme.test", "mail", { url: "https://mail.example/mcp", header: "Authorization", value: "Bearer ada-own-mail-key" });
  if (options.cleo) host.people.putKey(CLEO, "cleo@acme.test", "mail", { url: "https://mail.example/mcp", header: "Authorization", value: "Bearer cleo-own-mail-key" });
  // As ensureAppsAccess saves it after the service registered her.
  (host.people as unknown as { write(name: string, value: unknown): void }).write("apps.json", { v: 1, brokerUrl: ADA_ACCESS.url, people: {
    [ADA]: { email: "ada@acme.test", installationId: "inst-ada", token: ADA_ACCESS.token },
    ...(options.cleo ? { [CLEO]: { email: "cleo@acme.test", installationId: "inst-cleo", token: CLEO_ACCESS.token } } : {}),
  } });
  return file;
}

describe("whose connection a turn may use", () => {
  it("defaults every app and server to the team's", () => {
    const { host } = setup();
    expect(host.scopes.scope("app", "gmail")).toBe("team");
    expect(host.scopes.scope("mcp", "mail")).toBe("team");
    expect(host.personApps()).toEqual([]);
  });

  it("is the person the turn acts for, only in a chat that is theirs alone, where nobody else reads what their apps bring back", () => {
    const { host } = setup({ requester: { "room-chat": ADA, "main-chat": BEN, "work-chat": CLEO } });
    expect(host.turnPerson("ada-chat")).toBe(ADA);
    expect(host.turnPerson("ada-work"), "work her request handed on, in the receiving bot's chat with her").toBe(ADA);
    expect(host.turnPerson("cleo-chat")).toBe(CLEO);
    expect(host.turnPerson("room-chat"), "her own line in a group chat: others read it").toBeNull();
    expect(host.turnPerson("main-chat"), "his own line in the bot's main chat: others read it").toBeNull();
    expect(host.turnPerson("work-chat"), "work handed on into a thread others read").toBeNull();
    const admin = setup({ requester: { "ada-chat": BEN, "ada-work": BEN } }).host;
    for (const thread of ["ada-chat", "ada-work"]) expect(admin.turnPerson(thread), `Ben's request never acts for anyone in Ada's chat (${thread})`).toBeNull();
    const routine = setup({ requester: { "ada-chat": "", "ada-work": "" } }).host;
    for (const thread of ["ada-chat", "ada-work"]) expect(routine.turnPerson(thread), `a routine or a webhook acts for nobody (${thread})`).toBeNull();
    expect(setup({ team: false }).host.turnPerson("ada-chat"), "off a team nothing is anyone's").toBeNull();
  });

  it("opens work a person's request hands on in the receiving bot's chat with them, when they connected anything of their own", () => {
    const { host, dataDir } = setup({ requester: { "main-chat": CLEO, "work-chat": "" } });
    expect(host.handOnFor("room-chat", "g"), "nothing of hers connected: the work opens where it always did").toBeNull();
    adaConnected(host, dataDir);
    for (const thread of ["room-chat", "ada-chat"]) expect(host.handOnFor(thread, "g"), thread).toBe(ADA);
    expect(host.handOnFor("main-chat", "g"), "Cleo connected nothing of hers").toBeNull();
    expect(host.handOnFor("work-chat", "g"), "work nobody's request started").toBeNull();
    const keyOnly = setup();
    keyOnly.host.scopes.set("mcp", "mail", "person");
    keyOnly.host.people.putKey(ADA, "ada@acme.test", "mail", { url: "https://mail.example/mcp", header: "Authorization", value: "Bearer ada-own-mail-key" });
    expect(keyOnly.host.handOnFor("room-chat", "g"), "her own key for a server is hers too").toBe(ADA);
    expect(setup({ team: false }).host.handOnFor("room-chat", "g")).toBeNull();
  });
});

describe("apps each person connects", () => {
  it("mounts a member's own bridge only in her own chats, minted for her, and in no other", async () => {
    const { host, dataDir, minted } = setup({ requester: { "main-chat": CLEO } });
    adaConnected(host, dataDir);
    const own = await host.appsIntegrations({ id: "scout", name: "Scout" }, "ada-chat", "gen-1");
    expect(own.composio?.env.AS).toBe("team");
    expect(own.composioOwn?.env.AS).toBe("own");
    expect(minted.map((entry) => entry.connectorsFor)).toEqual([undefined, ADA]);
    minted.length = 0;
    expect((await host.appsIntegrations({ id: "helper", name: "Helper" }, "ada-work", "gen-1")).composioOwn?.env.AS, "work her request handed on, in its chat with her").toBe("own");
    expect(minted.map((entry) => entry.connectorsFor)).toEqual([undefined, ADA]);
    for (const thread of ["room-chat", "work-chat", "main-chat", "cleo-chat"]) {
      const elsewhere = await host.appsIntegrations({ id: "scout", name: "Scout" }, thread, "gen-1");
      expect(elsewhere.composio, thread).toBeDefined();
      expect(elsewhere.composioOwn, `${thread}: others read it, or it is someone else's`).toBeUndefined();
    }
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect((await admin.host.appsIntegrations({ id: "scout", name: "Scout" }, "ada-chat", "gen-1")).composioOwn).toBeUndefined();
  });

  it("never gives one person's work another's: work Ada's request handed on gets only Ada's, Cleo's only Cleo's", async () => {
    const { host, dataDir, minted, composio } = setup();
    adaConnected(host, dataDir, { cleo: true });
    await host.appsIntegrations({ id: "helper", name: "Helper" }, "ada-work", "gen-ada");
    await host.appsIntegrations({ id: "helper", name: "Helper" }, "cleo-work", "gen-cleo");
    await host.appsIntegrations({ id: "scout", name: "Scout" }, "room-chat", "gen-room");
    expect(minted.filter((entry) => entry.connectorsFor).map((entry) => [entry.threadId, entry.connectorsFor])).toEqual([["ada-work", ADA], ["cleo-work", CLEO]]);
    const owns = composio.mcpIntegration.mock.calls.map(([, context]) => context as typeof context & { threadId: string }).filter((context) => context.as);
    expect(owns.map((context) => [context.threadId, context.as])).toEqual([["ada-work", ADA_ACCESS], ["cleo-work", CLEO_ACCESS]]);
    // A bridge minted for one person is refused in a turn that acts for the other, and anywhere others read, on every call.
    expect(host.relayActor({ threadId: "ada-work", generation: "gen-ada", connectorsFor: ADA })).toEqual({ access: ADA_ACCESS });
    expect(host.relayActor({ threadId: "ada-work", generation: "gen-ada", connectorsFor: CLEO }).refusal).toMatch(/cleo@acme.test's own apps, and this turn no longer acts for cleo@acme.test/);
    expect(host.relayActor({ threadId: "cleo-work", generation: "gen-cleo", connectorsFor: ADA }).refusal).toMatch(/ada@acme.test's own apps/);
    expect(host.relayActor({ threadId: "room-chat", generation: "gen-room", connectorsFor: ADA }).refusal, "her own room line: the room reads it").toMatch(/ada@acme.test's own apps/);
    expect(host.relayActor({ threadId: "cleo-chat", generation: "g", connectorsFor: ADA }).refusal, "her bridge in Cleo's private chat").toMatch(/ada@acme.test's own apps/);
    // Each turn's MCP servers carry only its own person's key, and a chat others read carries none.
    const ada = JSON.stringify(await host.turnMcp(BOT, "ada-work", "gen-ada")), cleo = JSON.stringify(await host.turnMcp(BOT, "cleo-work", "gen-cleo"));
    const room = JSON.stringify(await host.turnMcp(BOT, "room-chat", "gen-room"));
    expect(ada).toContain("ada-own-mail-key");
    expect(ada).not.toContain("cleo-own-mail-key");
    expect(cleo).toContain("cleo-own-mail-key");
    expect(cleo).not.toContain("ada-own-mail-key");
    expect(room).not.toMatch(/own-mail-key/);
  });

  it("relays a member's own bridge to her installation, and refuses it once the turn doesn't act for her", () => {
    const { host, dataDir } = setup({ requester: { "room-chat": "" } });
    adaConnected(host, dataDir);
    expect(host.relayActor({ threadId: "ada-chat", generation: "g", connectorsFor: ADA })).toEqual({ access: ADA_ACCESS });
    expect(host.relayActor({ threadId: "ada-chat", generation: "g" })).toEqual({});
    const refused = host.relayActor({ threadId: "cleo-chat", generation: "g", connectorsFor: ADA }).refusal;
    expect(refused).toMatch(/ada@acme.test's own apps, and this turn no longer acts for ada@acme.test: it was stopped, or someone else wrote in it since/);
    expect(refused, "never worked around").toContain("Don't try it another way (the browser or another tool).");
    expect(host.relayActor({ threadId: "room-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/no longer acts for ada@acme.test/);
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect(admin.host.relayActor({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/no longer acts for/);
    // Her installation went (she disconnected, or left): one line with where to connect again.
    const gone = setup();
    gone.host.scopes.set("app", "gmail", "person");
    expect(gone.host.relayActor({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }).refusal).toMatch(/own apps aren't connected here any more.*"Connect your apps again here: https:\/\/cloud.example.test\/cloud\/team\/team-acme-1"/);
  });

  it("gives a bot a Chief made the Chief's grants, never a connection: each turn still gets only its own person's", async () => {
    const { host, dataDir, composio } = setup({ requester: { "main-chat": CLEO } });
    adaConnected(host, dataDir);
    const inherited = appsFromCreator({ createdBy: "ada@acme.test", connectorTools: { gmail: { tools: "*" } } }, { createdBy: "ada@acme.test" });
    const made = { id: "scout-helper", name: "Scout's helper", ...inherited };
    for (const thread of ["ada-chat", "cleo-chat", "main-chat"]) await host.appsIntegrations(made, thread, "gen-1");
    const contexts = composio.mcpIntegration.mock.calls.map(([, context]) => context as typeof context & { threadId: string; connectorTools?: unknown });
    expect(contexts.every((context) => JSON.stringify(context.connectorTools) === JSON.stringify({ gmail: { tools: "*" } }))).toBe(true);
    expect(contexts.filter((context) => context.as).map((context) => [context.threadId, context.as])).toEqual([["ada-chat", ADA_ACCESS]]);
    expect(await host.callRefusal({ threadId: "cleo-chat", generation: "gen-1" }, [{ slug: "GMAIL_FETCH_EMAILS" }]), "Cleo's chat never reaches Ada's Gmail").toMatch(/Connect your Gmail/);
  });

  it("refuses a person's app through the team's bridge, and a team app through her own", async () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    const team = { threadId: "main-chat", generation: "g" };
    const nobody = await host.callRefusal(team, [{ slug: "GMAIL_FETCH_EMAILS" }]);
    expect(nobody).toMatch(/Gmail is each person's own in Acme, and this work doesn't act for one person/);
    expect(nobody, "the fix, in one line, never \"open a private chat\"").toContain("\"Gmail is each person's own, so I can't use it here. Ask me yourself and I'll use yours, or an admin can connect Gmail for the whole team: https://cloud.example.test/cloud/team/team-acme-1/apps.\"");
    expect(nobody).toContain("Don't try it another way (the browser or another tool).");
    expect(nobody).not.toMatch(/private chat/);
    const shared = await host.callRefusal({ threadId: "room-chat", generation: "g" }, [{ slug: "GMAIL_FETCH_EMAILS" }]);
    expect(shared, "her own room line: the room reads what it brings back").toMatch(/^Gmail is ada@acme.test's own, and others read this chat, so what it brings back can't come here and it isn't used here\./);
    expect(shared, "and how it gets done instead").toContain("To use it, hand that part on: to yourself with start_thread, or to a teammate with coordinate_bots. It runs in that bot's chat with ada@acme.test, with ada@acme.test's own apps, and only a line saying where the result is comes back here: say only that here.");
    expect(shared).toContain("Don't try it another way (the browser or another tool).");
    expect(await host.callRefusal({ threadId: "ada-work", generation: "g" }, [{ slug: "GMAIL_FETCH_EMAILS" }]), "work handed on into her chat: hers, through her bridge").toMatch(/Gmail here is ada@acme.test's own: use it through the own_apps tools/);
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
    const { host } = setup({ requester: { "main-chat": "" } });
    host.scopes.set("app", "gmail", "person");
    expect(host.connectRefusal({ threadId: "ada-chat", generation: "g" }, ["gmail"])).toContain("\"Connect your Gmail here: https://cloud.example.test/cloud/team/team-acme-1\"");
    expect(host.connectRefusal({ threadId: "room-chat", generation: "g" }, ["gmail"]), "her own room line: where to connect hers").toContain("\"Connect your Gmail here: https://cloud.example.test/cloud/team/team-acme-1\"");
    expect(host.connectRefusal({ threadId: "main-chat", generation: "g" }, ["gmail"])).toMatch(/this work doesn't act for one person/);
    expect(host.connectRefusal({ threadId: "room-chat", generation: "g" }, ["slack"]), "a team app keeps its card").toBeNull();
    expect(host.connectRefusal({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }, ["slack"])).toMatch(/Slack is Acme's, connected once for everyone by its owner or an admin/);
    expect(setup({ team: false }).host.connectRefusal({ threadId: "ada-chat", generation: "g" }, ["gmail"])).toBeNull();
  });
});

const BOT = { id: "bot-1", name: "Bot" };

describe("MCP servers each person connects", () => {
  it("gives a turn that acts for her her key, never the team's, and no other turn either", async () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    const own = await host.turnMcp(BOT, "ada-chat", "g");
    expect(own.mail).toEqual({ type: "http", url: "https://mail.example/mcp", headers: { Authorization: "Bearer ada-own-mail-key" } });
    expect(own.console, "the team's server is the team's, with its key").toEqual({ type: "http", url: "https://console.example/mcp", headers: { Authorization: "Bearer team-console-key" } });
    expect((await host.turnMcp(BOT, "ada-work", "g")).mail, "work her request handed on, in its chat with her").toEqual(own.mail);
    for (const thread of ["room-chat", "work-chat", "main-chat", "cleo-chat"]) {
      const elsewhere = await host.turnMcp(BOT, thread, "g");
      expect(elsewhere.mail, thread).toBeUndefined();
      expect(JSON.stringify(elsewhere), thread).not.toContain("ada-own-mail-key");
      expect(JSON.stringify(elsewhere), thread).not.toContain("team-mail-key");
    }
    const admin = setup({ requester: { "ada-chat": BEN } });
    adaConnected(admin.host, admin.dataDir);
    expect((await admin.host.turnMcp(BOT, "ada-chat", "g")).mail, "Ben writing in Ada's chat").toBeUndefined();
    expect(host.engineMcp(BOT).mail, "with no conversation in view: the team's only").toBeUndefined();
  });

  it("pins a member's key to the server's address: re-pointed, it is not sent", async () => {
    const { host, dataDir } = setup({ servers: { mail: { type: "http", url: "https://elsewhere.example/mcp", headers: {}, enabled: true } } });
    adaConnected(host, dataDir);
    expect((await host.turnMcp(BOT, "ada-chat", "g")).mail).toBeUndefined();
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
  it("tells a turn that acts for her what is hers and how to connect the rest; one that acts for nobody, why and what to do", () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    host.scopes.set("app", "outlook", "person");
    const own = host.prompt("ada-work", "g", { composioOwn: {}, custom: { mail: {} } });
    expect(own).toContain("Gmail and Outlook are ada@acme.test's own: use them through the own_apps tools");
    expect(own).toContain("The MCP server mail acts as ada@acme.test's own account.");
    expect(own, "never for anyone else's request").toContain("They are used only for ada@acme.test's request: if someone else asks for something from them, say they are ada@acme.test's.");
    const shared = host.prompt("room-chat", "g", {});
    expect(shared, "her own room line: others read it").toContain("Gmail, Outlook and mail are each person's own in Acme, used only in a chat that is theirs alone. Others read this chat, so ada@acme.test's own aren't here");
    expect(shared).toContain("hand that part on: to yourself with start_thread, or to a teammate with coordinate_bots. It runs in that bot's chat with ada@acme.test");
    const cleos = setup({ requester: { "room-chat": CLEO } }).host;
    cleos.scopes.set("app", "gmail", "person");
    expect(cleos.prompt("room-chat", "g", {}), "Cleo connected nothing yet").toMatch(/and this person hasn't connected any yet\. .*"Connect your <name> here: https:\/\/cloud\.example\.test\/cloud\/team\/team-acme-1"\./);
    const missing = host.prompt("ada-chat", "g", { custom: {} });
    expect(missing).toContain("Each person connects these for themselves, and ada@acme.test hasn't connected them yet, or their sign-in ended: Gmail, Outlook and mail.");
    expect(missing).toContain("\"Connect your <name> here: https://cloud.example.test/cloud/team/team-acme-1\"");
    expect(missing).toContain("don't try it another way (the browser or another tool)");
    const nobody = host.prompt("main-chat", "g", {});
    expect(nobody).toContain("Gmail, Outlook and mail are each person's own in Acme: they work for the person whose own message started the work");
    expect(nobody).toContain("Ask me yourself and I'll use yours, or an admin can connect <name> for the whole team: https://cloud.example.test/cloud/team/team-acme-1/apps.");
    expect(nobody).not.toMatch(/private chat/);
    expect(setup().host.prompt("room-chat", "g", {}), "nothing each person's: nothing said").toBe("");
  });

  it("says whose own account a step used: a person's app through her bridge, or a person's server, in a turn that acts for her", () => {
    const { host, dataDir } = setup({ requester: { "main-chat": "" } });
    adaConnected(host, dataDir);
    const named = (tool: string, input?: unknown, thread = "ada-work") => host.toolWhose(thread, "g", tool, input);
    expect(named("mcp__own_apps__GMAIL_FETCH_EMAILS")).toEqual({ whose: { person: "ada@acme.test", app: "Gmail" } });
    expect(named("mcp__own_apps__COMPOSIO_MULTI_EXECUTE_TOOL", JSON.stringify({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] })), "a meta-tool names its app tools").toEqual({ whose: { person: "ada@acme.test", app: "Gmail" } });
    expect(named("GMAIL_FETCH_EMAILS"), "an engine that names the tool alone").toEqual({ whose: { person: "ada@acme.test", app: "Gmail" } });
    expect(named("gmail.fetch_emails"), "an app tool").toEqual({ whose: { person: "ada@acme.test", app: "Gmail" } });
    expect(named("mcp__mail__read_inbox"), "her own MCP server").toEqual({ whose: { person: "ada@acme.test", app: "mail" } });
    expect(named("mcp__console__query"), "the team's server").toEqual({});
    expect(named("mcp__composio__SLACK_SEND_MESSAGE"), "a team app").toEqual({});
    expect(named("mcp__own_apps__GMAIL_FETCH_EMAILS", undefined, "main-chat"), "a turn that acts for nobody").toEqual({});
    expect(host.toolWhose("ada-work", undefined, "mcp__own_apps__GMAIL_FETCH_EMAILS"), "no turn running").toEqual({});
    expect(named("mcp__own_apps__GMAIL_FETCH_EMAILS", undefined, "room-chat"), "a chat others read uses none of hers").toEqual({});
    const cleos = setup();
    adaConnected(cleos.host, cleos.dataDir);
    expect(cleos.host.toolWhose("cleo-work", "g", "mcp__own_apps__GMAIL_FETCH_EMAILS"), "Cleo connected nothing of hers").toEqual({});
    expect(cleos.host.toolWhose("cleo-work", "g", "mcp__mail__read_inbox")).toEqual({});
    const named2 = setup();
    adaConnected(named2.host, named2.dataDir);
    expect(named2.host.toolWhose("ada-chat", "g", "mcp__own_apps__GMAIL_FETCH_EMAILS")).toEqual({ whose: { person: "ada@acme.test", app: "Gmail" } });
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

describe("the connected apps a turn's app tools come from", () => {
  afterEach(() => { vi.useRealTimers(); });
  const bot = { id: "scout", name: "Scout" };
  const GMAIL = { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] } };
  const appTools = (bridges: { composio?: { env: Record<string, string> } }): string[] => JSON.parse(bridges.composio?.env[APP_TOOLS_ENV] ?? "[]");

  it("uses what is known at once, and reads it again in the background once it is a minute old, never waiting on that", async () => {
    vi.useFakeTimers();
    const { host, composio } = setup({ team: false });
    composio.connectedServices.mockResolvedValue(GMAIL as never);
    host.primeApps();
    expect(composio.connectedServices, "read at start").toHaveBeenCalledTimes(1);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g1"))).toContain("gmail.search_emails");
    expect(composio.connectedServices, "the read at start served the first turn").toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    let answer: (services: never) => void = () => {};
    composio.connectedServices.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g2")), "the known answer while the new read hangs").toContain("gmail.search_emails");
    expect(composio.connectedServices).toHaveBeenCalledTimes(2);
    answer({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g3")), "Gmail was disconnected meanwhile").toEqual([]);
  });

  it("waits a few seconds at most for an installation's first answer, and reads again soon after a failed one", async () => {
    vi.useFakeTimers();
    const hanging = setup({ team: false });
    hanging.composio.connectedServices.mockImplementation(() => new Promise<never>(() => {}));
    const first = hanging.host.appsIntegrations(bot, "main-chat", "g1");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(appTools(await first), "no answer yet: this turn goes without").toEqual([]);

    const { host, composio } = setup({ team: false });
    composio.connectedServices.mockRejectedValueOnce(new Error("broker down")).mockResolvedValue(GMAIL as never);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g1"))).toEqual([]);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g2"))).toEqual([]);
    expect(composio.connectedServices, "not read again at once").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g3"))).toContain("gmail.search_emails");
  });
});

describe("who is told to connect a team app", () => {
  it("never tells the owner or an admin to ask an admin: their bot asks for the card through the team's tools", () => {
    const { host } = setup({ roster: ROSTER, requester: { "main-chat": OLIVE, "room-chat": BEN } });
    const owner = host.connectRefusal({ threadId: "main-chat", generation: "g", connectorsFor: OLIVE }, ["figma"])!;
    expect(owner).toContain("Figma is Acme's, connected once for everyone, and olive@acme.test can connect it: they're the owner of Acme.");
    expect(owner).toContain("Ask for its connection through the composio tools, not own_apps: its card here lets them connect it for the whole team.");
    expect(owner).not.toMatch(/ask an admin|ask one of them/i);
    const admin = host.connectRefusal({ threadId: "room-chat", generation: "g", connectorsFor: BEN }, ["figma"])!;
    expect(admin).toContain("ben@acme.test can connect it: they're an admin of Acme.");
    expect(admin).not.toMatch(/ask an admin|ask one of them/i);
  });

  it("tells a User who can connect it, by name, never someone who can't", () => {
    const { host } = setup({ roster: ROSTER });
    const user = host.connectRefusal({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }, ["figma"])!;
    expect(user).toContain("\"Figma is connected for the whole team by olive@acme.test and ben@acme.test: ask one of them to connect it.\"");
    expect(user).not.toContain("cleo@acme.test");
    const one = setup({ roster: ROSTER.filter((entry) => entry.person !== BEN) }).host;
    expect(one.connectRefusal({ threadId: "ada-chat", generation: "g", connectorsFor: ADA }, ["figma"])).toContain("\"Figma is connected for the whole team by olive@acme.test: ask them to connect it.\"");
  });

  it("sends an owner or an admin to the team's Apps page for their own connections, and a User to their team home", async () => {
    const { host } = setup({ roster: ROSTER, requester: { "main-chat": OLIVE, "olive-chat": OLIVE } });
    host.scopes.set("app", "gmail", "person");
    const apps = "https://cloud.example.test/cloud/team/team-acme-1/apps", home = "https://cloud.example.test/cloud/team/team-acme-1";
    for (const thread of ["olive-chat", "main-chat"]) {
      expect(host.connectRefusal({ threadId: thread, generation: "g" }, ["gmail"]), thread).toContain(`"Connect your Gmail here: ${apps}"`);
      expect(await host.callRefusal({ threadId: thread, generation: "g" }, [{ slug: "GMAIL_FETCH_EMAILS" }]), thread).toContain(`"Connect your Gmail here: ${apps}"`);
      expect(host.prompt(thread, "g", {}), thread).toContain(`"Connect your <name> here: ${apps}"`);
    }
    expect(host.connectRefusal({ threadId: "ada-chat", generation: "g" }, ["gmail"])).toContain(`"Connect your Gmail here: ${home}"`);
    expect(host.relayActor({ threadId: "olive-chat", generation: "g", connectorsFor: OLIVE }).refusal).toContain(`"Connect your apps again here: ${apps}"`);
  });
});

// A bot's page calling the connector tools it declared, through its rpc route and the connector gate, against a fake
// connected-apps installation: nothing leaves this process.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChatApps, type ChatApps } from "../chat-apps.ts";
import { DATA_DIR } from "../config.ts";
import { createConnectorGate, type AppInstallation } from "../connector-gate.ts";
import type { ModelSelection } from "../contracts.ts";
import type { DecisionRow } from "../decision-log.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createChatAppRoutes, type ChatAppRouteDeps } from "./chat-apps.ts";
import { dispatchRoutes } from "./table.ts";

type Json = Record<string, unknown>;
const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const apps: ChatApps[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** One installation per person ("home" for the computer's own), each recording what it was sent. */
function installations() {
  const sent: Array<{ who: string; frame: Json }> = [];
  const make = (who: string): AppInstallation => ({
    id: who,
    connected: async () => ({ gmail: { connected: who !== "nobody", accounts: [{ id: `ca_${who}`, status: "ACTIVE" }] } }),
    serviceSlugs: async () => ["gmail"],
    readOnlyTools: async () => new Set(["GMAIL_FETCH_EMAILS"]),
    async relay(frame) {
      sent.push({ who, frame });
      if (frame.method !== "tools/call") return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })) };
      const slug = (frame.params as { arguments: { tools: Array<{ tool_slug: string }> } }).arguments.tools[0]!.tool_slug;
      const body = { successful: true, data: { results: [{ tool_slug: slug, response: { successful: true, data: { messages: [{ id: `${who}-1` }] } } }] } };
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } })) };
    },
  });
  return { sent, make, calls: () => sent.filter((one) => one.frame.method === "tools/call") };
}

async function fixture(options: { threadVisible?: ChatAppRouteDeps["threadVisible"]; threadRefusal?: ChatAppRouteDeps["threadRefusal"]; mayAct?: (auth: RequestAuth) => boolean; full?: boolean; confined?: (threadId: string) => boolean } = {}) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const other = store.createBot({ name: "Other" });
  const chatApps = createChatApps({ store, dataDir: DATA_DIR, sweeps: false });
  apps.push(chatApps);
  const fake = installations();
  const rows: Array<Omit<DecisionRow, "at">> = [];
  const gate = createConnectorGate({
    bot: (id) => store.bot(id) ?? undefined,
    // Each person connects Gmail for themselves here, so a call goes to the caller's own installation.
    apps: { configured: () => true, installation: (person) => fake.make(person ?? "home"), policyRefusal: () => undefined },
    decide: (row) => rows.push(row), log: () => {},
  });
  const routes = [createChatAppRoutes({
    store, apps: chatApps,
    ...(options.threadVisible ? { threadVisible: options.threadVisible } : {}),
    ...(options.threadRefusal ? { threadRefusal: options.threadRefusal } : {}),
    connectors: {
      gate,
      person: (auth) => (auth.kind === "session" ? auth.session.id : null),
      mayAct: (auth) => options.mayAct?.(auth) ?? true,
      fullAccess: () => options.full === true,
      ...(options.confined ? { confined: options.confined } : {}),
    },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const person = req.headers["x-session"];
    const auth = (typeof person === "string"
      ? { kind: "session", session: { id: person, email: `${person}@example.com` }, via: "bearer", scopes: ["client"] }
      : { kind: "loopback", scopes: ["admin", "client"] }) as RequestAuth;
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const show = (input: Json, who = bot, threadId = who.threadId) => {
    const result = chatApps.createAppCard({ bot: who, threadId, input: { tool: "show_html", html: "<p>Mail</p>", title: "Mail", ...input } });
    if (result instanceof Promise || !result.ok) throw new Error(`not shown: ${JSON.stringify(result)}`);
    return result.messageId;
  };
  const rpc = async (id: string, method: string, params?: unknown, who = bot, threadId = bot.threadId, session?: string) => {
    const response = await fetch(`${base}/api/bots/${who.id}/apps/${id}/rpc`, {
      method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-session": session } : {}) }, body: JSON.stringify({ threadId, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { store, bot, other, chatApps, show, rpc, fake, rows };
}

const READ = { connector: "gmail", tool: "GMAIL_FETCH_EMAILS", arguments: { max_results: 2 }, engaged: false };

describe("mausbot.connectors on the rpc route", () => {
  it("answers a declared read with the viewer's own connection, and lists the declared tools", async () => {
    const { show, rpc, fake, rows } = await fixture();
    const id = show({ uses: ["gmail:GMAIL_FETCH_EMAILS", "gmail:GMAIL_TRASH_MESSAGE"] });
    expect(await rpc(id, "mausbot/connectors/call", READ, undefined, undefined, "ada")).toEqual({ status: 200, body: { result: { messages: [{ id: "ada-1" }] } } });
    expect(await rpc(id, "mausbot/connectors/call", READ)).toEqual({ status: 200, body: { result: { messages: [{ id: "home-1" }] } } });
    // The person and the account come from the request and the server, never from what the page sent.
    expect(await rpc(id, "mausbot/connectors/call", { ...READ, person: "bob", account: "ca_bob", arguments: { max_results: 2 } }, undefined, undefined, "ada")).toMatchObject({ status: 200 });
    expect(fake.calls().map((one) => [one.who, (one.frame.params as any).arguments.tools])).toEqual([
      ["ada", [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 2 } }]],
      ["home", [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 2 } }]],
      ["ada", [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 2 } }]],
    ]);
    expect(rows.map((row) => [row.summary, row.decision])).toEqual([[`page ${id}: ran (gmail)`, "auto-approved"], [`page ${id}: ran (gmail)`, "auto-approved"], [`page ${id}: ran (gmail)`, "auto-approved"]]);
    expect(await rpc(id, "mausbot/connectors/list", {}, undefined, undefined, "nobody")).toEqual({ status: 200, body: {
      connectors: [{ connector: "gmail", label: "Gmail", connected: false, tools: ["GMAIL_FETCH_EMAILS", "GMAIL_TRASH_MESSAGE"] }],
    } });
  });

  it("refuses a tool the page did not declare, a page that declared none, and a change without Full access or a click", async () => {
    const { show, rpc, fake } = await fixture();
    const plain = show({ uses: ["data"] });
    expect(await rpc(plain, "mausbot/connectors/call", READ)).toEqual({ status: 409, body: { error: { code: -32000, message: 'This page declared no connector tools: show it with uses naming each tool, e.g. ["gmail:GMAIL_FETCH_EMAILS"].' } } });
    const id = show({ uses: ["gmail:GMAIL_TRASH_MESSAGE"] });
    expect((await rpc(id, "mausbot/connectors/call", READ)).body.error.message).toBe('This page did not declare GMAIL_FETCH_EMAILS: list "gmail:GMAIL_FETCH_EMAILS" in show_html uses to call it.');
    const trash = { connector: "gmail", tool: "GMAIL_TRASH_MESSAGE", arguments: { id: "m1" }, engaged: true };
    expect(await rpc(id, "mausbot/connectors/call", trash)).toMatchObject({ status: 403, body: { error: { message: expect.stringContaining("Scout asks before it changes anything") } } });
    const full = await fixture({ full: true });
    const page = full.show({ uses: ["gmail:GMAIL_TRASH_MESSAGE"] });
    expect(await full.rpc(page, "mausbot/connectors/call", { ...trash, engaged: false })).toMatchObject({ status: 403, body: { error: { message: "This changes something in Gmail, so it runs only right after the person clicks in this page." } } });
    expect((await full.rpc(page, "mausbot/connectors/call", trash)).status).toBe(200);
    expect(fake.calls()).toEqual([]);
  });

  it("keeps a page's declared tools across a version that says nothing of uses, and drops them with one that does", async () => {
    const { bot, show, rpc, chatApps } = await fixture();
    const id = show({ uses: ["gmail:GMAIL_FETCH_EMAILS"] });
    show({ tool: "update_html", app_id: id, html: "<p>Mail 2</p>" });
    expect(chatApps.declaredConnectors(bot.threadId, id)).toEqual([{ connector: "gmail", tools: ["GMAIL_FETCH_EMAILS"] }]);
    expect((await rpc(id, "mausbot/connectors/call", READ)).status).toBe(200);
    show({ tool: "update_html", app_id: id, html: "<p>Mail 3</p>", uses: ["state"] });
    expect(chatApps.declaredConnectors(bot.threadId, id)).toEqual([]);
    expect((await rpc(id, "mausbot/connectors/call", READ)).status).toBe(409);
    const doc = chatApps.appDocument(bot.threadId, id);
    expect(doc?.can.connectors).toBeUndefined();
    show({ tool: "update_html", app_id: id, html: "<p>Mail 4</p>", uses: ["gmail:GMAIL_FETCH_EMAILS"] });
    expect(chatApps.appDocument(bot.threadId, id)?.can.connectors).toEqual([{ connector: "gmail", tools: ["GMAIL_FETCH_EMAILS"] }]);
  });

  it("is refused to another bot's page, another conversation, a room, a viewer who cannot see the conversation or may not chat with the bot, and a guest", async () => {
    const outsider = (auth: RequestAuth) => auth.kind !== "session" || auth.session.id !== "outsider";
    const { store, bot, other, show, rpc, fake } = await fixture({
      threadVisible: outsider, mayAct: (auth) => auth.kind !== "session" || auth.session.id !== "reader",
      threadRefusal: (auth) => (auth.kind === "session" && auth.session.id === "guest" ? "A guest changes only conversations it started." : null),
    });
    const id = show({ uses: ["gmail:GMAIL_FETCH_EMAILS"] });
    const home = bot.threadId;
    expect((await rpc(id, "mausbot/connectors/call", READ, other, other.threadId)).status).toBe(404);
    expect((await rpc(id, "mausbot/connectors/call", READ, other, home)).status).toBe(404);
    const second = store.createTask(bot.id)!;
    expect((await rpc(id, "mausbot/connectors/call", READ, bot, second.threadId)).status).toBe(404);
    const room = store.createGroup("Launch", [bot.id, other.id]);
    const inRoom = show({ uses: ["gmail:GMAIL_FETCH_EMAILS"] }, bot, room.threadId);
    expect(await rpc(inRoom, "mausbot/connectors/call", READ, bot, room.threadId)).toEqual({ status: 409, body: { error: { code: -32000, message: "In a room, a page cannot call connected apps." } } });
    expect(await rpc(id, "mausbot/connectors/call", READ, bot, home, "outsider")).toEqual({ status: 404, body: { error: "no such conversation" } });
    expect(await rpc(id, "mausbot/connectors/list", {}, bot, home, "outsider")).toEqual({ status: 404, body: { error: "no such conversation" } });
    expect(await rpc(id, "mausbot/connectors/list", {}, bot, home, "reader")).toEqual({ status: 403, body: { error: { code: -32000, message: "Only someone who can chat with Scout can use this page's connected apps." } } });
    expect((await rpc(id, "mausbot/connectors/call", READ, bot, home, "guest")).status).toBe(403);
    expect(fake.sent).toEqual([]);
    const confined = await fixture({ confined: () => true });
    expect(await confined.rpc(confined.show({ uses: ["gmail:GMAIL_FETCH_EMAILS"] }), "mausbot/connectors/call", READ))
      .toEqual({ status: 403, body: { error: { code: -32000, message: "In this conversation, pages cannot use connected apps." } } });
    expect(confined.fake.sent).toEqual([]);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_DOCS_SWEEP_GRACE_MS } from "../app-docs.ts";
import { createChatApps, type ChatApps } from "../chat-apps.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { createLocalApps, type LocalApps } from "../local-apps/service.ts";
import { readRemovedStarters, type StarterSource } from "../local-apps/starters.ts";
import { localAppDocRefs, localAppsFile } from "../local-apps/store.ts";
import { appDocRefs } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createLocalAppsRoutes } from "./local-apps.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const closers: Array<{ close(): void }> = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  for (const one of closers.splice(0)) one.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** `seen`: which conversations a paired person (x-session) can read; the owner on this computer sees everything. */
async function fixture(seen: (person: string, threadId: string) => boolean = () => true, options: { everything?: boolean; live?: (person: string) => boolean; starters?: StarterSource } = {}) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const other = store.createBot({ name: "Other" });
  const chatApps: ChatApps = createChatApps({ store, dataDir: DATA_DIR, sweeps: false, references: () => [...appDocRefs(), ...localAppDocRefs(DATA_DIR)] });
  const localApps: LocalApps = createLocalApps({ chat: store, docs: chatApps.docs, dataDir: DATA_DIR, ...(options.starters ? { starters: options.starters } : {}) });
  closers.push(chatApps, localApps);
  const routes = [createLocalAppsRoutes({
    apps: localApps, store,
    visibleFor: (auth) => auth.kind === "session"
      ? { everything: options.everything === true, thread: (threadId) => seen(auth.session.id, threadId) }
      : { everything: true, thread: () => true },
    live: (auth) => auth.kind !== "session" || (options.live?.(auth.session.id) ?? true),
    threadRefusal: (auth, threadId) => (auth.kind === "session" && auth.session.id === "guest" && threadId === bot.threadId ? "Guests change only their own conversations." : null),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (localApps.serveFile(req, res, url.pathname, req.method ?? "GET")) return;
      const person = req.headers["x-session"];
      const auth = (typeof person === "string"
        ? { kind: "session", session: { id: person, email: `${person}@example.com` }, via: "bearer", scopes: ["client"] }
        : { kind: "loopback", scopes: ["admin", "client"] }) as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, session?: string) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json", ...(session ? { "x-session": session } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const page = (html = "<p>Hello</p>", title = "Sales board", threadId = bot.threadId, by = bot) => {
    const result = chatApps.createAppCard({ bot: by, threadId, input: { tool: "show_html", html, title } });
    if (result instanceof Promise || !result.ok) throw new Error("not shown");
    return result.messageId;
  };
  const update = (appId: string, html: string, threadId = bot.threadId) => {
    const result = chatApps.createAppCard({ bot, threadId, input: { tool: "update_html", app_id: appId, html } });
    if (result instanceof Promise || !result.ok) throw new Error("not updated");
  };
  const folderPage = async (threadId = bot.threadId) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omb-local-app-")));
    mkdirSync(join(root, "dash"));
    writeFileSync(join(root, "dash", "index.html"), "<h1>Dash</h1><script src='app.js'></script>");
    writeFileSync(join(root, "dash", "data.csv"), "region,total\nNorth,12");
    const result = await chatApps.createAppCard({ bot, threadId, input: { tool: "show_html", path: "dash", title: "Dash" }, folders: async () => ({ roots: [root], vmWorkspace: null }) });
    if (!result.ok) throw new Error(result.error);
    return result.messageId;
  };
  const save = (messageId: string, session?: string, threadId = bot.threadId, botId = bot.id) => call("POST", "/api/local-apps", { botId, threadId, messageId }, session);
  return { store, bot, other, chatApps, localApps, call, page, update, folderPage, save, base };
}

describe("local apps", () => {
  it("saves a page as an app with its title, and saving it again answers with the same app", async () => {
    const { page, save, call } = await fixture();
    const messageId = page();
    const first = await save(messageId);
    expect(first.status).toBe(201);
    expect(first.body.app).toMatchObject({ name: "Sales board", rev: 0, versions: [{ rev: 0 }], manifest: { name: "Sales board" }, chat: true });
    expect(first.body.app.id).toMatch(/^la_[\w-]{16}$/);
    const again = await save(messageId);
    expect(again.status).toBe(200);
    expect(again.body.app.id).toBe(first.body.app.id);
    expect((await call("GET", "/api/local-apps")).body.apps).toHaveLength(1);
  });

  it("follows the newest version the bot shows in that conversation and keeps the earlier ones", async () => {
    const { page, update, save, call } = await fixture();
    const messageId = page("<p>one</p>");
    const { body } = await save(messageId);
    update(messageId, "<p>two</p>");
    update(messageId, "<p>three</p>");
    const after = await call("GET", `/api/local-apps/${body.app.id}`);
    expect(after.body.app).toMatchObject({ rev: 2, versions: [{ rev: 0 }, { rev: 1 }, { rev: 2 }] });
    expect((await call("GET", `/api/local-apps/${body.app.id}/app`)).body.srcdoc).toContain("three");
    expect((await call("GET", `/api/local-apps/${body.app.id}/app?rev=0`)).body.srcdoc).toContain("one");
  });

  it("can stay on one version, and follow the newest again", async () => {
    const { page, update, save, call } = await fixture();
    const messageId = page("<p>one</p>");
    const id = (await save(messageId)).body.app.id;
    update(messageId, "<p>two</p>");
    expect((await call("PATCH", `/api/local-apps/${id}`, { pinnedRev: 0 })).body.app).toMatchObject({ rev: 0, pinnedRev: 0 });
    update(messageId, "<p>three</p>");
    expect((await call("GET", `/api/local-apps/${id}/app`)).body.srcdoc).toContain("one");
    expect((await call("PATCH", `/api/local-apps/${id}`, { pinnedRev: 9 })).status).toBe(404);
    const latest = await call("PATCH", `/api/local-apps/${id}`, { pinnedRev: null });
    expect(latest.body.app.rev).toBe(2);
    expect(latest.body.app.pinnedRev).toBeUndefined();
  });

  it("renames, and refuses an empty name", async () => {
    const { page, save, call } = await fixture();
    const id = (await save(page())).body.app.id;
    expect((await call("PATCH", `/api/local-apps/${id}`, { name: "  Team\nboard " })).body.app).toMatchObject({ name: "Team board", manifest: { name: "Team board" } });
    expect((await call("PATCH", `/api/local-apps/${id}`, { name: "   " })).status).toBe(400);
  });

  it("builds the document as the chat does: the same policy and abilities", async () => {
    const { page, save, call, chatApps, bot } = await fixture();
    const messageId = page();
    const id = (await save(messageId)).body.app.id;
    const doc = (await call("GET", `/api/local-apps/${id}/app`)).body;
    const chat = chatApps.appDocument(bot.threadId, messageId)!;
    expect(doc).toMatchObject({ messageId, rev: 0, csp: chat.csp, can: chat.can, network: chat.network });
    expect(doc.srcdoc).toBe(chat.srcdoc);
  });

  it("lives on after its conversation is deleted, folder files and all", async () => {
    const { store, bot, folderPage, save, call, chatApps, base } = await fixture();
    const thread = store.createTask(bot.id, "Dashboards")!.threadId!;
    const messageId = await folderPage(thread);
    const id = (await save(messageId, undefined, thread)).body.app.id;
    store.deleteTask(bot.id, thread);
    expect(chatApps.sweep()).toBe(0);
    const swept = chatApps.docs.sweep([...appDocRefs(), ...localAppDocRefs(DATA_DIR)], Date.now() + APP_DOCS_SWEEP_GRACE_MS + 1_000);
    expect(swept).toBe(0);
    const listed = (await call("GET", "/api/local-apps")).body.apps;
    expect(listed[0]).toMatchObject({ id, chat: false });
    const doc = (await call("GET", `/api/local-apps/${id}/app?origin=${encodeURIComponent(base)}`)).body;
    const files = /<base href="([^"]+)"/.exec(doc.srcdoc)?.[1];
    expect(files).toMatch(new RegExp(`^${base}/api/local-app-files/[\\w-]{43}/$`));
    const response = await fetch(`${files}data.csv`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("North,12");
  });

  it("removing the app lets its documents be swept", async () => {
    const { store, bot, page, save, call, chatApps } = await fixture();
    const thread = store.createTask(bot.id, "Scratch")!.threadId!;
    const id = (await save(page("<p>only here</p>", "Scratch", thread), undefined, thread)).body.app.id;
    store.deleteTask(bot.id, thread);
    const later = Date.now() + APP_DOCS_SWEEP_GRACE_MS + 1_000;
    expect(chatApps.docs.sweep([...appDocRefs(), ...localAppDocRefs(DATA_DIR)], later)).toBe(0);
    expect((await call("DELETE", `/api/local-apps/${id}`)).body).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(localAppsFile(DATA_DIR), "utf8")).apps).toEqual([]);
    expect(chatApps.docs.sweep([...appDocRefs(), ...localAppDocRefs(DATA_DIR)], later)).toBeGreaterThan(0);
    expect((await call("GET", `/api/local-apps/${id}`)).status).toBe(404);
  });

  it("refuses another bot's page, another conversation's page, an MCP app and a room's page", async () => {
    const { store, bot, other, chatApps, page, save } = await fixture();
    const mine = page();
    expect((await save(mine, undefined, bot.threadId, other.id)).status).toBe(404);
    expect((await save(mine, undefined, other.threadId, other.id)).status).toBe(404);
    const theirs = page("<p>theirs</p>", "Theirs", other.threadId, other);
    expect((await save(theirs, undefined, other.threadId, bot.id)).status).toBe(404);
    const stored = chatApps.docs.put({ source: "mcp", html: "<p>view</p>", data: { tool: { name: "get-time" }, network: { connect: [], resources: [] } } });
    if (!stored.ok) throw new Error("not stored");
    const mcp = store.appendMessage(bot.threadId, { role: "bot", kind: "app", text: "Get time", from: { botId: bot.id },
      app: { v: 1, source: "mcp", title: "Get time", doc: stored.doc, rev: 0, bytes: 11, border: true, network: { connect: [], resources: [] }, mcp: { server: "basic", tool: "get-time", resourceUri: "ui://basic/view" } } } as never).id;
    expect((await save(mcp)).status).toBe(409);
    const room = store.createGroup("Launch", [bot.id, other.id]);
    expect((await save(mine, undefined, room.threadId)).status).toBe(409);
  });

  it("shows a paired person only the apps they saved, from conversations they can still read", async () => {
    let annSees = true;
    const { page, save, call, bot } = await fixture((person, threadId) => person === "ann" && threadId === bot.threadId && annSees);
    const messageId = page();
    expect((await save(messageId, "bob")).status).toBe(404);
    const ann = await save(messageId, "ann");
    expect(ann.status).toBe(201);
    const id = ann.body.app.id;
    expect((await call("GET", "/api/local-apps", undefined, "bob")).body.apps).toEqual([]);
    expect((await call("GET", `/api/local-apps/${id}`, undefined, "bob")).status).toBe(404);
    expect((await call("DELETE", `/api/local-apps/${id}`, undefined, "bob")).status).toBe(404);
    expect((await call("GET", "/api/local-apps", undefined, "ann")).body.apps).toHaveLength(1);
    annSees = false;
    expect((await call("GET", `/api/local-apps/${id}/app`, undefined, "ann")).status).toBe(404);
    expect((await call("GET", "/api/local-apps")).body.apps).toHaveLength(1);
  });

  it("a guest can't save from a conversation they may not change", async () => {
    const { page, save } = await fixture();
    expect((await save(page(), "guest")).status).toBe(403);
  });

  it("carries the abilities the page declared into the app's manifest, and its newest version's after", async () => {
    const { save, chatApps, bot, call } = await fixture();
    const shown = chatApps.createAppCard({ bot, threadId: bot.threadId, input: { tool: "show_html", html: "<p>x</p>", title: "Sales board", uses: ["data", "state"] } });
    if (shown instanceof Promise || !shown.ok) throw new Error("not shown");
    const app = (await save(shown.messageId)).body.app;
    expect(app.manifest).toEqual({ name: "Sales board", uses: ["data", "state"] });
    chatApps.createAppCard({ bot, threadId: bot.threadId, input: { tool: "update_html", app_id: shown.messageId, html: "<p>y</p>", uses: ["state"] } });
    expect((await call("GET", `/api/local-apps/${app.id}`)).body.app.manifest).toEqual({ name: "Sales board", uses: ["state"] });
    chatApps.createAppCard({ bot, threadId: bot.threadId, input: { tool: "update_html", app_id: shown.messageId, html: "<p>z</p>", uses: [] } });
    expect((await call("GET", `/api/local-apps/${app.id}`)).body.app.manifest).toEqual({ name: "Sales board" });
  });


  it("lets only whoever saved an app, or an admin, rename or remove it, and never from a conversation they may not change", async () => {
    const { page, save, call } = await fixture(() => true, { everything: true });
    const mine = (await save(page())).body.app.id;
    expect((await call("GET", `/api/local-apps/${mine}`, undefined, "bob")).status).toBe(200);
    expect((await call("PATCH", `/api/local-apps/${mine}`, { name: "Bob's now" }, "bob")).status).toBe(403);
    expect((await call("DELETE", `/api/local-apps/${mine}`, undefined, "bob")).status).toBe(403);
    const bobs = (await save(page("<p>bob</p>", "Bob's"), "bob")).body.app.id;
    expect((await call("PATCH", `/api/local-apps/${bobs}`, { name: "Bob's board" }, "bob")).body.app.name).toBe("Bob's board");
    expect((await call("PATCH", `/api/local-apps/${bobs}`, { name: "Owner's" })).status).toBe(200);
    const guests = (await save(page("<p>g</p>", "Guest's"), "ann")).body.app.id;
    expect((await call("DELETE", `/api/local-apps/${guests}`, undefined, "guest")).status).toBe(403);
    expect((await call("DELETE", `/api/local-apps/${bobs}`, undefined, "bob")).body).toEqual({ ok: true });
  });

  it("shows a starter app to whoever sees everything; only this computer or an admin removes it, and for good", async () => {
    const starters: StarterSource = { apps: [{ id: "la_starter_sample__", name: "Sample", file: "sample.html" }], html: () => "<p>Sample data</p>" };
    const narrow = await fixture(() => true, { starters });
    expect((await narrow.call("GET", "/api/local-apps")).body.apps.map((app: any) => [app.id, app.sample])).toEqual([["la_starter_sample__", true]]);
    expect((await narrow.call("GET", "/api/local-apps", undefined, "ann")).body.apps).toEqual([]);
    expect((await narrow.call("GET", "/api/local-apps/la_starter_sample__/app", undefined, "ann")).status).toBe(404);

    const wide = await fixture(() => true, { everything: true, starters });
    expect((await wide.call("GET", "/api/local-apps", undefined, "bob")).body.apps.map((app: any) => app.id)).toEqual(["la_starter_sample__"]);
    expect((await wide.call("DELETE", "/api/local-apps/la_starter_sample__", undefined, "bob")).status).toBe(403);
    expect((await wide.call("GET", "/api/local-apps/la_starter_sample__/app")).body.srcdoc).toContain("Sample data");
    expect((await wide.call("DELETE", "/api/local-apps/la_starter_sample__")).body).toEqual({ ok: true });
    expect(readRemovedStarters(DATA_DIR)).toEqual(new Set(["la_starter_sample__"]));
    expect((await (await fixture(() => true, { starters })).call("GET", "/api/local-apps")).body.apps).toEqual([]);
  });

  it("stops serving a folder app's files once the session that opened it has ended", async () => {
    let live = true;
    const { folderPage, save, call, base } = await fixture(() => true, { live: () => live });
    const id = (await save(await folderPage(), "ann")).body.app.id;
    const doc = (await call("GET", `/api/local-apps/${id}/app?origin=${encodeURIComponent(base)}`, undefined, "ann")).body;
    const files = /<base href="([^"]+)"/.exec(doc.srcdoc)![1]!;
    expect((await fetch(`${files}data.csv`)).status).toBe(200);
    live = false;
    expect((await fetch(`${files}data.csv`)).status).toBe(404);
  });
});

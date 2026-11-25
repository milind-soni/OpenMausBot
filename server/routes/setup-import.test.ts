import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import type { GrokConnector, GrokMove } from "../grok-move-tunnel.ts";
import { json, readBody } from "../harness/http.ts";
import { IMPORTED_SKILLS_DIR, importedSkillsFor } from "../imported-skills.ts";
import type { RequestAuth } from "../request-auth.ts";
import { thisMachine } from "../setup-import.ts";
import { Store } from "../store.ts";
import { grokSlice } from "../testing/grok-cache.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createSetupImportRoutes } from "./setup-import.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(homes.splice(0).map((home) => removeTempDir(home)));
  rmSync(IMPORTED_SKILLS_DIR, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "skill-state", "imported-skills.json"), { force: true });
});

const AUTH: Record<string, RequestAuth> = {
  owner: { kind: "loopback", scopes: ["admin", "client"] },
  service: { kind: "loopback", scopes: ["client"], trust: "service" },
  paired: { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1" } } as unknown as RequestAuth,
};

/** A fixture home with one skill and one MCP server; never the real one. */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "omb-setup-route-home-"));
  homes.push(home);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  };
  put(".claude/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Works with PDF files.\n---\n\nRead the PDF.\n");
  put(".cursor/mcp.json", JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer notion_secret" } } } }));
  return home;
}

/** A link that needs no cloudflared: the routes only pass along what it answers. */
function fakeGrokMove(available = true) {
  const calls: string[] = [];
  let open = false;
  const state = (arrived: GrokConnector["arrived"] = []): GrokConnector => ({ available, ...(open ? { connectorUrl: "https://words.trycloudflare.com/mcp/move/key", expiresAt: 9 } : {}), arrived });
  const move: GrokMove = {
    connect: async () => { calls.push("connect"); open = available; return state(); },
    look: (after) => { calls.push(`look ${after}`); return state(open && after < 1 ? [{ seq: 1, at: 5, text: "{}" }] : []); },
    end: () => { calls.push("end"); open = false; return state(); },
  };
  return { move, calls };
}

async function serve({ local = true, home = fixtureHome(), dataDir, grokMove = fakeGrokMove(false).move }: { local?: boolean; home?: string; dataDir?: string; grokMove?: GrokMove } = {}) {
  const cfg = { mcpServers: {} } as Pick<AppConfig, "mcpServers" | "features">;
  const bot = { id: `bot-${randomUUID().slice(0, 8)}` };
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
  let busy = false;
  const routes = [createSetupImportRoutes({
    local,
    cfg,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpPolicyRefusal: () => undefined,
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    store,
    machine: () => ({ ...thisMachine(), home, platform: "darwin", env: {} }),
    ...(dataDir ? { dataDir } : {}),
    grokMove,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = AUTH[String(req.headers["x-test-auth"] ?? "owner")]!;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { from: "next handler" });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, options: { auth?: string; body?: unknown; type?: string } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth": options.auth ?? "owner", ...(options.body === undefined ? {} : { "content-type": options.type ?? "application/json" }) },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
  return { call, cfg, bot, store };
}

describe("the setup import routes", () => {
  it("hands out what Grok Bot left on this computer only to the owner's own loopback there", async () => {
    const home = fixtureHome();
    mkdirSync(join(home, "Downloads"));
    writeFileSync(join(home, "Downloads", "grok-bot-export-drew.json"), "reply");
    const local = await serve({ home });
    for (const auth of ["paired", "service"]) expect((await local.call("GET", "/api/setup-import/grok", { auth })).status, auth).toBe(403);
    expect((await (await serve({ local: false, home })).call("GET", "/api/setup-import/grok")).status).toBe(403);
    expect((await local.call("POST", "/api/setup-import/grok", { body: {} })).status).toBe(405);
    const found = await local.call("GET", "/api/setup-import/grok");
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toMatchObject({ files: [{ name: "grok-bot-export-drew.json", text: "reply" }], bots: [] });
  });

  it("opens one link for Grok Bot, hands over what arrived through it, and ends it", async () => {
    const { move, calls } = fakeGrokMove();
    const local = await serve({ grokMove: move });
    const connector = "/api/setup-import/grok/connector";
    const looked = await local.call("GET", connector);
    expect(looked.headers.get("cache-control")).toBe("no-store");
    expect(await looked.json()).toEqual({ available: true, arrived: [] });
    expect((await local.call("POST", connector, { body: "", type: "text/plain" })).status).toBe(415);
    expect(calls).toEqual(["look 0"]);
    const made = await (await local.call("POST", connector, { body: {} })).json() as GrokConnector;
    expect(made).toEqual({ available: true, connectorUrl: "https://words.trycloudflare.com/mcp/move/key", expiresAt: 9, arrived: [] });
    expect(await (await local.call("GET", connector)).json()).toMatchObject({ connectorUrl: made.connectorUrl, arrived: [{ seq: 1, at: 5, text: "{}" }] });
    expect(await (await local.call("GET", `${connector}?after=1`)).json()).toMatchObject({ arrived: [] });
    for (const after of ["x", "-1", "1.5"]) expect((await local.call("GET", `${connector}?after=${after}`)).status, after).toBe(400);
    expect(await (await local.call("DELETE", connector)).json()).toEqual({ available: true, arrived: [] });
    expect(calls).toEqual(["look 0", "connect", "look 0", "look 1", "end"]);
  });

  it("keeps the Grok Bot link to the owner's own loopback, and says plainly when no link can be made", async () => {
    const { move, calls } = fakeGrokMove();
    const local = await serve({ grokMove: move });
    const connector = "/api/setup-import/grok/connector";
    for (const auth of ["paired", "service"]) {
      for (const method of ["GET", "POST", "DELETE"]) expect((await local.call(method, connector, { auth, ...(method === "POST" ? { body: {} } : {}) })).status, `${auth} ${method}`).toBe(403);
    }
    for (const method of ["GET", "POST", "DELETE"]) expect((await (await serve({ local: false, grokMove: move })).call(method, connector, method === "POST" ? { body: {} } : {})).status, method).toBe(403);
    expect((await local.call("PUT", connector, { body: {} })).status).toBe(405);
    expect(calls).toEqual([]);

    expect(await (await (await serve()).call("POST", connector, { body: {} })).json()).toEqual({ available: false, arrived: [] });
    const failing = await serve({ grokMove: { ...move, connect: async () => { throw new Error("The link could not be made: cloudflared did not open a tunnel in time."); } } });
    const failed = await failing.call("POST", connector, { body: {} });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "The link could not be made: cloudflared did not open a tunnel in time." });
  });

  it("deletes an old Cursor sign-in as the routes start, on any server", async () => {
    const home = fixtureHome();
    writeFileSync(join(home, "cursor-session.json"), "{\"accessToken\":\"x\"}");
    await serve({ home, local: false, dataDir: home });
    expect(existsSync(join(home, "cursor-session.json"))).toBe(false);
  });

  it("answers only the owner's own loopback on a computer of their own", async () => {
    const local = await serve();
    for (const auth of ["paired", "service"]) {
      for (const method of ["GET", "POST"]) {
        const response = await local.call(method, "/api/setup-import", { auth, ...(method === "POST" ? { body: { skills: true, tools: true } } : {}) });
        expect(response.status, `${auth} ${method}`).toBe(403);
      }
    }
    const hosted = await serve({ local: false });
    expect((await hosted.call("GET", "/api/setup-import")).status).toBe(403);
    expect((await hosted.call("POST", "/api/setup-import", { body: { skills: true, tools: true } })).status).toBe(403);
    expect(importedSkillsFor(local.bot.id, new Set())).toEqual([]);
    expect(local.cfg.mcpServers).toEqual({});
  });

  it("finds by name, brings in on POST, and leaves other paths to the next handler", async () => {
    const { call, cfg, bot } = await serve();
    const found = await call("GET", "/api/setup-import");
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toEqual({ skills: [{ name: "pdf", source: "claudeCode" }], tools: [{ name: "notion", source: "cursor" }] });

    const brought = await call("POST", "/api/setup-import", { body: { skills: true, tools: true } });
    expect(brought.status).toBe(200);
    const text = await brought.text();
    expect(JSON.parse(text)).toEqual({
      skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] },
      tools: { added: ["notion"], present: [], skipped: [] },
    });
    expect(text).not.toContain("notion_secret");
    expect(importedSkillsFor(bot.id, new Set()).map((skill) => skill.name)).toEqual(["pdf"]);
    expect(cfg.mcpServers).toEqual({ notion: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer notion_secret" }, enabled: false } });
    expect(await (await call("GET", "/api/setup-import")).json()).toEqual({ skills: [], tools: [] });

    expect(await (await call("GET", "/api/setup-import/other")).json()).toEqual({ from: "next handler" });
    expect((await call("DELETE", "/api/setup-import")).status).toBe(405);
  });

  it("brings in only the kinds asked for, and refuses a body it does not understand", async () => {
    const { call, cfg, bot } = await serve();
    const tools = await call("POST", "/api/setup-import", { body: { tools: true } });
    expect(await tools.json()).toEqual({ tools: { added: ["notion"], present: [], skipped: [] } });
    expect(importedSkillsFor(bot.id, new Set())).toEqual([]);
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["notion"]);

    expect((await call("POST", "/api/setup-import", { body: {} })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: { skills: false, tools: false } })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: { skills: true, instructions: true } })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: { skills: "yes" } })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: "skills=true", type: "text/plain" })).status).toBe(415);
  });
});

describe("a moved Bot's chat from the Grok Bot app", () => {
  const HISTORY = "/api/setup-import/grok/history";
  const TITLE = "Chat from Grok Bot";
  const at = (minute: number) => Date.UTC(2026, 7, 11, 9, minute);
  function grokHome(rows = [{ id: "d0bdfa13-0000-4000-8000-000000000003", name: "Drew" }]) {
    const home = fixtureHome();
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(home, path)), { recursive: true });
      writeFileSync(join(home, path), text);
    };
    put(grokSlice("roster.last-roster"), JSON.stringify({ schemaVersion: 1, value: { rows } }));
    put(grokSlice(`transcript.replicas.${rows[0]!.id}`), JSON.stringify({ schemaVersion: 1, value: { entries: [
      { kind: "message", seq: 1, id: "t1u", role: "user", content: "Draft the launch email", timestampMs: at(0) },
      { kind: "send-message", seq: 3, id: "t1s1", message: { type: "text", content: "Here's a draft." }, timestampMs: at(1) },
      { kind: "send-message", seq: 4, id: "t1s2", message: { type: "widget", widget: { prompt: "Send it?", options: [{ label: "Yes", value: "y" }] } }, respondedValue: "y", timestampMs: at(2) },
    ] } }));
    return home;
  }
  const threads = (store: Store, botId: string) => (store.bot(botId)?.tasks ?? []).filter((task) => task.title === TITLE);

  it("brings it into one new thread on the bot, as a record that starts nothing, and a retry adds nothing", async () => {
    const { call, store } = await serve({ home: grokHome() });
    const bot = store.createBot({ name: "Drew" }, { seedMessages: false });
    const first = await call("POST", HISTORY, { body: { botId: bot.id, grokName: "Drew" } });
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ messages: 3 });
    const [thread] = threads(store, bot.id);
    expect(thread).toMatchObject({ busy: false, activity: "idle", unread: false });
    expect(store.messagesFor(thread!.threadId).map(({ role, text, at: when }) => [role, text, when])).toEqual([
      ["user", "Draft the launch email", at(0)], ["bot", "Here's a draft.", at(1)], ["bot", "Send it?\nChoices: Yes\nAnswer: Yes", at(2)],
    ]);

    expect(await (await call("POST", HISTORY, { body: { botId: bot.id, grokName: "Drew" } })).json()).toEqual({ messages: 3 });
    expect(threads(store, bot.id)).toHaveLength(1);
    expect(store.messagesFor(thread!.threadId)).toHaveLength(3);
  });

  it("says why no chat came over, and makes no thread then", async () => {
    const noApp = await serve();
    const quiet = noApp.store.createBot({ name: "Drew" }, { seedMessages: false });
    expect(await (await noApp.call("POST", HISTORY, { body: { botId: quiet.id, grokName: "Drew" } })).json()).toEqual({ reason: "noApp" });
    expect(threads(noApp.store, quiet.id)).toEqual([]);

    const twins = await serve({ home: grokHome([{ id: "1731b8e0-0000-4000-8000-000000000001", name: "New Bot" }, { id: "28ae2014-0000-4000-8000-000000000002", name: "New Bot" }]) });
    const twin = twins.store.createBot({ name: "New Bot" }, { seedMessages: false });
    expect(await (await twins.call("POST", HISTORY, { body: { botId: twin.id, grokName: "New Bot" } })).json()).toEqual({ reason: "ambiguous" });
    expect(threads(twins.store, twin.id)).toEqual([]);
    expect(await (await twins.call("POST", HISTORY, { body: { botId: twin.id, grokName: "New Bot 1731b8e0" } })).json()).toEqual({ messages: 3 });
  });

  it("answers only the owner's own loopback on the desktop app, and only a POST naming a bot that is here", async () => {
    const local = await serve({ home: grokHome() });
    const bot = local.store.createBot({ name: "Drew" }, { seedMessages: false });
    const body = { botId: bot.id, grokName: "Drew" };
    for (const auth of ["paired", "service"]) expect((await local.call("POST", HISTORY, { auth, body })).status, auth).toBe(403);
    const hosted = await serve({ local: false, home: grokHome() });
    const hostedBot = hosted.store.createBot({ name: "Drew" }, { seedMessages: false });
    expect((await hosted.call("POST", HISTORY, { body: { ...body, botId: hostedBot.id } })).status).toBe(403);
    expect((await local.call("GET", HISTORY)).status).toBe(405);
    expect((await local.call("POST", HISTORY, { body: JSON.stringify(body), type: "text/plain" })).status).toBe(415);
    for (const wrong of [{ botId: bot.id }, { ...body, grokName: "  " }, { ...body, extra: true }]) expect((await local.call("POST", HISTORY, { body: wrong })).status).toBe(400);
    expect((await local.call("POST", HISTORY, { body: { ...body, botId: "no-such-bot" } })).status).toBe(404);
    expect(threads(local.store, bot.id)).toEqual([]);
    expect(threads(hosted.store, hostedBot.id)).toEqual([]);
  });
});

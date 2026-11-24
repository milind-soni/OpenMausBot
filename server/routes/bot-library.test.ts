import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BotLibrary } from "../../shared/bot-library.ts";
import type { BotLibraryRows } from "../bot-library.ts";
import { createLibraryRemovals } from "../bot-library-removed.ts";
import { json, readBody } from "../harness/http.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createBotLibraryRoutes } from "./bot-library.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ADA = { kind: "session", scopes: ["client"], session: { id: "s1", email: "ada@acme.test" } } as unknown as RequestAuth;
const BOT = { id: "scout", threadId: "open", tasks: [{ threadId: "open" }, { threadId: "archived", archivedAt: 5 }, { threadId: "rui-private" }] };
const PAGE: PublishedPageRecord = { pageId: "aaaaaaaaaaaaaaaaaaaa", url: "https://aaaaaaaaaaaaaaaaaaaa.mausbot.page/", title: "Menu", botId: "scout", source: "/w/menu",
  cards: [{ threadId: "rui-private", messageId: "p1" }], createdAt: 1, updatedAt: 1 };

async function fixture(seen: { bot: boolean; hidden: readonly string[] }, shownIn: Record<string, string[]> = {}) {
  const asked: string[][] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "omb-library-"));
  dirs.push(dataDir);
  const attachments = join(dataDir, "attachments");
  const removals = createLibraryRemovals(dataDir);
  const rows: BotLibraryRows = {
    apps: (threadIds) => {
      asked.push([...threadIds]);
      return threadIds.map((threadId, index) => ({ threadId, messageId: `app-${threadId}`, at: 10 - index, title: `App in ${threadId}` }));
    },
    fileReplies: () => [],
  };
  const routes = [createBotLibraryRoutes({
    bot: (id) => (id === BOT.id ? BOT : null),
    visibleFor: (auth) => {
      expect(auth).toBe(ADA);
      return { bot: () => seen.bot, thread: (threadId: string) => !seen.hidden.includes(threadId) };
    },
    pages: () => [PAGE],
    rows,
    removals,
    copies: { attachmentsDir: attachments, kept: () => new Set(["avatar.png"]), threadsReferencing: (name) => shownIn[name] ?? [], remove: (name) => rmSync(join(attachments, name)) },
  })];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: ADA, json, readBody })
      .then((answered) => { if (!answered) json(res, 404, { error: "not routed" }); });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as BotLibrary & { error?: string } };
  };
  return { call, asked, dataDir, attachments };
}

describe("GET /api/bots/:id/library", () => {
  it("is open to a client session, as the conversations' messages are", () => {
    expect(requiredScope("GET", "/api/bots/scout/library")).toBe("client");
    expect(requiredScope("POST", "/api/bots/scout/library")).toBe("admin");
    expect(requiredScope("POST", "/api/bots/scout/library/remove")).toBe("admin");
  });

  it("lists what the bot made in all of its conversations, the archived one included", async () => {
    const { call, asked } = await fixture({ bot: true, hidden: [] });
    const answer = await call("GET", "/api/bots/scout/library");
    expect(answer.status).toBe(200);
    expect(asked).toEqual([["open", "archived", "rui-private"]]);
    expect(answer.body.apps.map((app) => app.threadId)).toEqual(["open", "archived", "rui-private"]);
    expect(answer.body.pages.map((page) => page.title)).toEqual(["Menu"]);
  });

  it("never names anything from a conversation this viewer cannot read", async () => {
    const { call, asked } = await fixture({ bot: true, hidden: ["rui-private"] });
    const answer = await call("GET", "/api/bots/scout/library");
    expect(asked).toEqual([["open", "archived"]]);
    expect(answer.body).toEqual({ pages: [], apps: [
      { threadId: "open", messageId: "app-open", at: 10, title: "App in open" },
      { threadId: "archived", messageId: "app-archived", at: 9, title: "App in archived" },
    ], files: [], removed: [] });
  });

  it("answers a bot the viewer cannot see, or one that does not exist, as not found, and leaves other paths alone", async () => {
    const hidden = await fixture({ bot: false, hidden: [] });
    expect(await hidden.call("GET", "/api/bots/scout/library")).toEqual({ status: 404, body: { error: "no such bot" } });
    expect(hidden.asked).toEqual([]);
    const shown = await fixture({ bot: true, hidden: [] });
    expect((await shown.call("GET", "/api/bots/nobody/library")).status).toBe(404);
    expect(await shown.call("POST", "/api/bots/scout/library")).toEqual({ status: 404, body: { error: "not routed" } });
    expect(await shown.call("GET", "/api/bots/scout/library/extra")).toEqual({ status: 404, body: { error: "not routed" } });
  });
});

describe("POST /api/bots/:id/library/remove", () => {
  it("keeps the removed files out of the Library from then on, even after a restart", async () => {
    const first = await fixture({ bot: true, hidden: [] });
    expect(await first.call("POST", "/api/bots/scout/library/remove", { paths: ["/work/notes.md"] })).toEqual({ status: 200, body: { removed: ["/work/notes.md"] } });
    await first.call("POST", "/api/bots/scout/library/remove", { paths: ["/work/notes.md", "/work/plan.md"] });
    expect((await first.call("GET", "/api/bots/scout/library")).body.removed).toEqual(["/work/notes.md", "/work/plan.md"]);
    expect(createLibraryRemovals(first.dataDir).list("scout")).toEqual(["/work/notes.md", "/work/plan.md"]);
    expect(createLibraryRemovals(first.dataDir).list("other")).toEqual([]);
  });

  it("deletes a stored copy only this bot's readable conversations show, and never a file outside the store", async () => {
    const shownIn = { "only-here.md": ["open", "archived"], "elsewhere.md": ["open", "other-bot"], "private.md": ["rui-private"], "avatar.png": ["open"] };
    const { call, attachments, dataDir } = await fixture({ bot: true, hidden: ["rui-private"] }, shownIn);
    mkdirSync(attachments);
    for (const name of [...Object.keys(shownIn), "unshown.md"]) writeFileSync(join(attachments, name), "x");
    writeFileSync(join(dataDir, "config.json"), "{}");
    const paths = [...Object.keys(shownIn), "unshown.md", "../config.json"].map((name) => join(attachments, name));
    expect((await call("POST", "/api/bots/scout/library/remove", { paths })).status).toBe(200);
    expect(["only-here.md", "elsewhere.md", "private.md", "avatar.png", "unshown.md"].filter((name) => existsSync(join(attachments, name))))
      .toEqual(["elsewhere.md", "private.md", "avatar.png", "unshown.md"]);
    expect(existsSync(join(dataDir, "config.json"))).toBe(true);
  });

  it("refuses a body that names no files, and a bot the viewer cannot see", async () => {
    const shown = await fixture({ bot: true, hidden: [] });
    expect((await shown.call("POST", "/api/bots/scout/library/remove", { paths: [] })).status).toBe(400);
    expect((await shown.call("POST", "/api/bots/scout/library/remove", { paths: [7] })).status).toBe(400);
    expect((await shown.call("GET", "/api/bots/scout/library/remove")).status).toBe(404);
    const hidden = await fixture({ bot: false, hidden: [] });
    expect((await hidden.call("POST", "/api/bots/scout/library/remove", { paths: ["/a"] })).status).toBe(404);
    expect(createLibraryRemovals(hidden.dataDir).list("scout")).toEqual([]);
  });
});

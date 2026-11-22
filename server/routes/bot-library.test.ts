import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { BotLibrary } from "../../shared/bot-library.ts";
import type { BotLibraryRows } from "../bot-library.ts";
import { json, readBody } from "../harness/http.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createBotLibraryRoutes } from "./bot-library.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))); });

const ADA = { kind: "session", scopes: ["client"], session: { id: "s1", email: "ada@acme.test" } } as unknown as RequestAuth;
const BOT = { id: "scout", threadId: "open", tasks: [{ threadId: "open" }, { threadId: "archived", archivedAt: 5 }, { threadId: "rui-private" }] };
const PAGE: PublishedPageRecord = { pageId: "aaaaaaaaaaaaaaaaaaaa", url: "https://aaaaaaaaaaaaaaaaaaaa.mausbot.page/", title: "Menu", botId: "scout", source: "/w/menu",
  cards: [{ threadId: "rui-private", messageId: "p1" }], createdAt: 1, updatedAt: 1 };

async function fixture(seen: { bot: boolean; hidden: readonly string[] }) {
  const asked: string[][] = [];
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
  })];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: ADA, json, readBody })
      .then((answered) => { if (!answered) json(res, 404, { error: "not routed" }); });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string) => {
    const response = await fetch(`${base}${path}`, { method });
    return { status: response.status, body: await response.json() as BotLibrary & { error?: string } };
  };
  return { call, asked };
}

describe("GET /api/bots/:id/library", () => {
  it("is open to a client session, as the conversations' messages are", () => {
    expect(requiredScope("GET", "/api/bots/scout/library")).toBe("client");
    expect(requiredScope("POST", "/api/bots/scout/library")).toBe("admin");
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
    ], files: [] });
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

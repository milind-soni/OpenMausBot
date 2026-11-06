import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { messagePages, pageSize, SNAPSHOT_MESSAGE_BYTES } from "../host/message-pages.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store): Promise<string> {
  const deps = {
    store, viewerFor: () => ({}), visibleTo: () => ({ everything: true, bot: () => true, group: () => true, sections: () => [], thread: () => true }), workspaceAccess: () => null,
    desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
    ...messagePages(store), pageSize, wireBot: (bot: object) => bot, groupUsageReader: { refresh: () => {} }, publicBotQueuedMessages: () => ({}), publicGroupState: (group: unknown) => group,
    botComputerControlSnapshot: () => ({ held: false, helpReason: null }),
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Page = { id: string; threadId: string; messages: Array<{ id: string }>; hasMore?: boolean };

describe("GET /api/bots?messages=N", () => {
  it("stays under the budget on a host with many long conversations, and scrolling up still reads what it cut", { timeout: 60_000 }, async () => {
    const store = new Store(() => sonnet);
    const bots = Array.from({ length: 25 }, (_, index) => store.createBot({ name: `Bot ${index}` }, { seedMessages: false }));
    const written = new Map(bots.map((bot) => [bot.threadId, Array.from({ length: 200 }, () =>
      store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "x".repeat(11_000) }).id)]));
    const base = await serve(store);

    const res = await fetch(`${base}/api/bots?messages=200`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(body)).toBeGreaterThan(SNAPSHOT_MESSAGE_BYTES * 0.9);
    expect(Buffer.byteLength(body)).toBeLessThan(32 * 1024 * 1024);

    const snapshot = (JSON.parse(body) as { bots: Page[] }).bots;
    expect(snapshot).toHaveLength(25);
    for (const bot of snapshot) {
      const ids = written.get(bot.threadId)!;
      expect(bot.hasMore).toBe(true);
      expect(bot.messages.map((message) => message.id)).toEqual(ids.slice(-bot.messages.length));
      const older = await (await fetch(`${base}/api/threads/${bot.threadId}/messages?limit=200&before=${bot.messages[0]!.id}`)).json() as Page;
      expect([...older.messages, ...bot.messages].map((message) => message.id)).toEqual(ids);
      expect(older.hasMore).toBe(false);
    }
  });

  it("leaves a snapshot that fits, and a request for whole transcripts, as they were", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    for (let index = 0; index < 3; index++) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `line ${index}` });
    const base = await serve(store);
    const snapshot = async (query: string) => ((await (await fetch(`${base}/api/bots${query}`)).json()) as { bots: Page[] }).bots[0]!;

    expect(await snapshot("?messages=2")).toMatchObject({ hasMore: true, messages: [{}, {}] });
    expect(await snapshot("?messages=200")).toMatchObject({ hasMore: false, messages: [{}, {}, {}] });
    expect((await snapshot("")).messages).toHaveLength(3);
  });
});

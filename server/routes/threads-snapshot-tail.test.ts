import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { messagePages, pageSize } from "../host/message-pages.ts";
import { closeMessageDb } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

type WireRow = { id: string; text?: string };
type Listed = { id: string; threadId: string; messages: WireRow[]; hasMore: boolean; activeLeafId: string | null };
type Body = { bots: Listed[]; groups: unknown[]; error?: string };
const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store): Promise<string> {
  const deps = {
    store, viewerFor: () => ({}),
    visibleTo: () => ({ everything: true, bot: () => true, group: () => true, thread: () => true, sections: () => [] }),
    workspaceAccess: () => null, desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
    groupUsageReader: { refresh: () => {} },
    pageSize, defaultPage: 50, ...messagePages(store),
    wireBot: (bot: BotRecord) => ({ id: bot.id, threadId: bot.threadId, name: bot.name }),
    publicBotQueuedMessages: () => ({}),
    publicGroupState: () => ({}),
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

function fleet(bots: number, rows: number) {
  const store = new Store(() => sonnet);
  const made = Array.from({ length: bots }, (_, index) => store.createBot({ name: `Bot ${index}` }, { seedMessages: false }));
  for (const bot of made) {
    for (let index = 0; index < rows; index++) {
      store.appendMessage(bot.threadId, index % 10 === 0 ? { role: "user", kind: "text", text: `ask ${index}` } : { role: "bot", kind: "text", text: `reply ${index}` });
    }
  }
  return { store, made };
}

describe("GET /api/bots with a tail for the conversations not open", () => {
  it("sends one page of the open bots and a tail of the rest, with nothing else changed", async () => {
    const { store, made } = fleet(4, 260);
    const base = await serve(store);
    const get = async (query: string) => (await (await fetch(`${base}/api/bots?${query}`)).json()) as Body;
    const whole = await get("messages=200");
    const tailed = await get(`messages=200&tail=20&open=${made[1]!.id},${made[3]!.id}`);

    const byId = (body: Body) => new Map(body.bots.map((bot) => [bot.id, bot]));
    const [wholeBots, tailedBots] = [byId(whole), byId(tailed)];
    for (const bot of made) {
      const full = wholeBots.get(bot.id)!, sent = tailedBots.get(bot.id)!;
      const { messages: _a, ...fullRest } = full, { messages: _b, ...sentRest } = sent;
      expect(sentRest).toEqual(fullRest);
      expect(full.messages).toHaveLength(200);
      if (bot === made[1] || bot === made[3]) expect(sent.messages).toEqual(full.messages);
      else {
        expect(sent.messages).toEqual(full.messages.slice(-sent.messages.length));
        expect(sent.messages.map((row) => row.text)).toContain("ask 250");
        expect(sent.messages).toHaveLength(20);
        expect(sent.hasMore).toBe(true);
      }
    }
    expect(Object.keys(tailed).sort()).toEqual(Object.keys(whole).sort());
    expect(JSON.stringify(tailed).length).toBeLessThan(JSON.stringify(whole).length * 0.6);
  });

  it("answers a client that sends no tail exactly as before", async () => {
    const { store } = fleet(3, 120);
    const base = await serve(store);
    const get = async (query: string) => (await (await fetch(`${base}/api/bots?${query}`)).json()) as Body;
    for (const query of ["messages=200", "messages=50", ""]) {
      const answer = await get(query);
      for (const bot of answer.bots) expect(bot.messages).toHaveLength(query === "messages=50" ? 50 : 120);
    }
    expect(await get("messages=200&tail=500")).toEqual(await get("messages=200"));
    expect(await get("tail=20")).toEqual(await get(""));
  });

  it("refuses a tail that is not a whole number", async () => {
    const base = await serve(fleet(1, 3).store);
    const answer = await fetch(`${base}/api/bots?messages=200&tail=-1`);
    expect(answer.status).toBe(400);
  });
});

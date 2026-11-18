import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { messagePages, pageSize } from "../host/message-pages.ts";
import * as mdb from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type Message } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store) {
  const deps = { store, defaultPage: 50, pageSize, ...messagePages(store), viewerFor: () => ({}), visibleTo: () => ({ bot: () => true, group: () => true }), workspaceAccess: () => null,
    desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() as { messages: Message[]; hasMore: boolean; activeLeafId: string | null } };
  };
}

const say = (store: Store, threadId: string, text: string) => store.appendMessage(threadId, { role: "user", kind: "text", text });
const row = (id: string, extra: Partial<Message> = {}): Message => ({ id, at: 1_700_000_000_000 + Number(id.slice(1)), role: "user", kind: "text", text: id, ...extra } as Message);

/** Each builds one conversation and names it; `warm` keeps the building Store, whose cache then holds the conversation. */
const conversations: Record<string, (store: Store) => string> = {
  "a straight conversation": (store) => {
    const bot = store.createBot({}, { seedMessages: false });
    for (let i = 0; i < 12; i++) say(store, bot.threadId, `message ${i}`);
    return bot.threadId;
  },
  "an edited message whose older branch is the one shown": (store) => {
    const bot = store.createBot({}, { seedMessages: false });
    const first = say(store, bot.threadId, "first");
    const kept = say(store, bot.threadId, "kept branch");
    for (let i = 0; i < 6; i++) say(store, bot.threadId, `kept ${i}`);
    store.branchMessage(bot.threadId, kept.id, "edited branch");
    for (let i = 0; i < 6; i++) say(store, bot.threadId, `edited ${i}`);
    store.setActiveLeaf(bot.threadId, kept.id);
    expect(store.activeLeaf(bot.threadId)).not.toBe(store.messagesFor(bot.threadId).at(-1)!.id);
    expect(first.parentId).toBeNull();
    return bot.threadId;
  },
  "a message inserted behind the newest one": (store) => {
    const bot = store.createBot({}, { seedMessages: false });
    const anchor = say(store, bot.threadId, "anchor");
    for (let i = 0; i < 6; i++) say(store, bot.threadId, `after ${i}`);
    store.insertMessageAfter(bot.threadId, anchor.id, { role: "bot", kind: "text", text: "inserted" });
    return bot.threadId;
  },
  "rows stored without parents and no stored leaf": (store) => {
    const bot = store.createBot({}, { seedMessages: false });
    mdb.importThread(bot.threadId, Array.from({ length: 12 }, (_, i) => row(`m${i}`)), null);
    return bot.threadId;
  },
  "old rows without parents under newer rows that have them": (store) => {
    const bot = store.createBot({}, { seedMessages: false });
    mdb.importThread(bot.threadId, [
      ...Array.from({ length: 6 }, (_, i) => row(`m${i}`)),
      ...Array.from({ length: 6 }, (_, i) => row(`m${i + 6}`, { parentId: `m${i + 5}` })),
    ], "m9");
    return bot.threadId;
  },
  "a stored leaf that is an empty string": (store) => {
    const bot = store.createBot({}, { seedMessages: false });
    mdb.importThread(bot.threadId, Array.from({ length: 12 }, (_, i) => row(`m${i}`, { parentId: i ? `m${i - 1}` : null })), "");
    return bot.threadId;
  },
  "a conversation with nothing in it": (store) => store.createBot({}, { seedMessages: false }).threadId,
};

describe("GET /api/threads/:threadId/messages", () => {
  for (const [name, build] of Object.entries(conversations)) {
    for (const warm of [false, true]) {
      it(`names the same leaf as the whole conversation does: ${name}${warm ? ", already in memory" : ""}`, async () => {
        const builder = new Store(() => sonnet);
        const threadId = build(builder);
        if (warm) builder.messagesFor(threadId);
        const whole = new Store(() => sonnet);
        const all = whole.messagesFor(threadId);
        const leaf = whole.activeLeaf(threadId);
        for (const limit of [0, 1, 3, 50]) {
          const get = await serve(warm ? builder : new Store(() => sonnet));
          const page = await get(`/api/threads/${threadId}/messages?limit=${limit}`);
          expect(page.status).toBe(200);
          expect(page.body.activeLeafId, `limit ${limit}`).toBe(leaf);
          expect(page.body.messages.map((message) => message.id), `limit ${limit}`).toEqual(all.slice(Math.max(0, all.length - limit)).map((message) => message.id));
          expect(page.body.hasMore, `limit ${limit}`).toBe(all.length > limit);
        }
      });
    }
  }

  for (const [name, build] of Object.entries(conversations)) {
    for (const warm of [false, true]) {
      it(`gives the page around a message as the whole conversation would: ${name}${warm ? ", already in memory" : ""}`, async () => {
        const builder = new Store(() => sonnet);
        const threadId = build(builder);
        if (warm) builder.messagesFor(threadId);
        const whole = new Store(() => sonnet);
        const all = whole.messagesFor(threadId);
        const leaf = whole.activeLeaf(threadId);
        const get = await serve(warm ? builder : new Store(() => sonnet));
        expect((await get(`/api/threads/${threadId}/messages?around=no-such-message&limit=3`)).status).toBe(404);
        for (const limit of [0, 1, 2, 3, 4, 5, 11, 12, 13, 50]) {
          for (const [index, target] of all.entries()) {
            const before = Math.floor((limit - 1) / 2);
            const start = Math.max(0, Math.min(index - before, all.length - limit));
            const page = await get(`/api/threads/${threadId}/messages?around=${target.id}&limit=${limit}`);
            expect(page.status).toBe(200);
            expect(page.body, `limit ${limit}, message ${index}`).toEqual({ messages: all.slice(start, Math.min(all.length, start + limit)), hasMore: start > 0, activeLeafId: leaf });
          }
        }
      });
    }
  }

  it("answers the page around a message without reading the rest of the conversation", async () => {
    const builder = new Store(() => sonnet);
    const threadId = conversations["an edited message whose older branch is the one shown"]!(builder);
    const target = builder.messagesFor(threadId)[7]!;
    const read = vi.spyOn(mdb, "readThread");
    try {
      const get = await serve(new Store(() => sonnet));
      const page = await get(`/api/threads/${threadId}/messages?around=${target.id}&limit=3`);
      expect(page.body.messages.map((message) => message.id)).toEqual(builder.messagesFor(threadId).slice(6, 9).map((message) => message.id));
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("answers the newest page of a long conversation without reading the rest of it", async () => {
    const builder = new Store(() => sonnet);
    const threadId = conversations["an edited message whose older branch is the one shown"]!(builder);
    const read = vi.spyOn(mdb, "readThread");
    try {
      const get = await serve(new Store(() => sonnet));
      const page = await get(`/api/threads/${threadId}/messages?limit=3`);
      expect(page.body.messages).toHaveLength(3);
      expect(page.body.activeLeafId).toBe(builder.activeLeaf(threadId));
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

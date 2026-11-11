import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_SUCH_BOT } from "../../shared/bot-read.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { CLIENT_ALLOW } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

type Body = { bot: { messages: Array<{ text: string }>; tasks: unknown[] }; bots: Array<{ id: string }>; error?: string };
const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store, hidden: string): Promise<string> {
  const deps = {
    store, viewerFor: () => ({}),
    visibleTo: () => ({ everything: true, bot: (id: string) => id !== hidden, group: () => true, thread: () => true, sections: () => [] }),
    workspaceAccess: () => null, desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
    groupUsageReader: { refresh: () => {} },
    pageSize: (raw: string | null) => raw === null ? undefined : /^\d+$/.test(raw) ? Number(raw) : null,
    messagePage: (threadId: string, limit = 200) => ({ messages: store.messagesFor(threadId).slice(-limit), hasMore: false, activeLeafId: null }),
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

describe("GET /api/bots/:id", () => {
  it("answers one bot as the list does, with only its own newest messages", async () => {
    const store = new Store(() => sonnet);
    const scout = store.createBot({ name: "Scout" }, { seedMessages: false });
    const other = store.createBot({ name: "Other" }, { seedMessages: false });
    const hidden = store.createBot({ name: "Hidden" }, { seedMessages: false });
    for (const text of ["one", "two", "three"]) store.appendMessage(scout.threadId, { role: "user", kind: "text", text });
    store.appendMessage(other.threadId, { role: "user", kind: "text", text: "elsewhere" });
    const base = await serve(store, hidden.id);
    const get = async (path: string) => { const res = await fetch(`${base}${path}`); return { status: res.status, body: await res.json() as Body }; };

    const one = await get(`/api/bots/${scout.id}?messages=2`);
    const list = await get(`/api/bots?messages=2`);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ bot: list.body.bots.find((bot) => bot.id === scout.id) });
    expect(one.body.bot.messages.map((message) => message.text)).toEqual(["two", "three"]);
    expect(one.body.bot.tasks).toEqual([]);

    expect(await get(`/api/bots/${hidden.id}`)).toEqual({ status: 404, body: { error: NO_SUCH_BOT } });
    expect(await get("/api/bots/no-such-bot")).toEqual({ status: 404, body: { error: NO_SUCH_BOT } });
    expect((await get(`/api/bots/${scout.id}?messages=-1`)).status).toBe(400);
  });

  it("is a read a client session may make, like the list", () => {
    const allowed = (path: string) => CLIENT_ALLOW.some((rule) => rule.methods.includes("GET") && rule.path.test(path));
    expect(allowed("/api/bots")).toBe(true);
    expect(allowed("/api/bots/bot-1")).toBe(true);
  });
});

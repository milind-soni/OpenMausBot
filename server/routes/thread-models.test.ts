// "Switch them too" through the route table, over a real store: it clears
// exactly the threads that run on a model of their own different from the
// bot's, leaves a running thread alone, and refuses another bot's threads.
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createThreadModelRoutes } from "./thread-models.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const opus: ModelSelection = { instanceId: "claude", model: "claude-opus-5" };
const codex: ModelSelection = { instanceId: "codex", model: "gpt-5-codex" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store, options: { busy?: Set<string>; owner?: boolean } = {}): Promise<string> {
  const routes = [createThreadModelRoutes({
    bot: (id) => store.bot(id),
    busy: (_botId, threadId) => options.busy?.has(threadId) ?? false,
    follow: (botId, threadIds) => store.followBotModel(botId, threadIds),
    mayChangeModel: () => options.owner !== false,
    reply: (botId) => ({ id: botId, tasks: store.tasks(botId).map((task) => ({ threadId: task.threadId, modelSelection: task.modelSelection })) }),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth: RequestAuth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, botId: string, body: unknown = {}) => fetch(`${base}/api/bots/${botId}/threads/follow-model`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Ada" });
  const follower = bot.threadId;
  const onCodex = store.createTask(bot.id, "On Codex")!.threadId;
  const onOpus = store.createTask(bot.id, "On Opus")!.threadId;
  const running = store.createTask(bot.id, "Running")!.threadId;
  store.switchTaskModel(bot.id, onCodex, codex, false, false);
  store.switchTaskModel(bot.id, onOpus, opus, false, false);
  store.switchTaskModel(bot.id, running, codex, false, false);
  const other = store.createBot({ name: "Grace" });
  const othersThread = store.createTask(other.id, "Grace's own")!.threadId;
  store.switchTaskModel(other.id, othersThread, codex, false, false);
  return { store, bot, follower, onCodex, onOpus, running, other, othersThread };
}

describe("Switch them too", () => {
  it("is admin-scoped, like the bot's model", () => {
    expect(requiredScope("POST", "/api/bots/bot-1/threads/follow-model")).toBe("admin");
  });

  it("clears exactly the threads on a model of their own, and leaves a running one until it settles", async () => {
    const { store, bot, follower, onCodex, onOpus, running } = fixture();
    // Its own pick that later became the bot's model: not "different".
    store.patchBot(bot.id, { modelSelection: opus });
    const base = await serve(store, { busy: new Set([running]) });
    const response = await post(base, bot.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ switched: 1, busy: 1 });
    expect(store.taskByThread(bot.id, onCodex)?.modelSelection).toBeUndefined();
    expect(store.taskByThread(bot.id, running)?.modelSelection).toEqual(codex);
    expect(store.taskByThread(bot.id, onOpus)?.modelSelection).toEqual(opus);
    expect(store.taskByThread(bot.id, follower)?.modelSelection).toBeUndefined();
    expect(store.projectBotForTask(bot.id, onCodex)?.modelSelection).toEqual(opus);
  });

  it("clears only the listed threads when it is given some", async () => {
    const { store, bot, onCodex, onOpus } = fixture();
    const base = await serve(store);
    expect(await (await post(base, bot.id, { threadIds: [onOpus] })).json()).toMatchObject({ switched: 1 });
    expect(store.taskByThread(bot.id, onOpus)?.modelSelection).toBeUndefined();
    expect(store.taskByThread(bot.id, onCodex)?.modelSelection).toEqual(codex);
  });

  it("refuses another bot's threads and changes nothing", async () => {
    const { store, bot, onCodex, other, othersThread } = fixture();
    const base = await serve(store);
    const response = await post(base, bot.id, { threadIds: [onCodex, othersThread] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not one of this bot's threads") });
    expect(store.taskByThread(bot.id, onCodex)?.modelSelection).toEqual(codex);
    expect(store.taskByThread(other.id, othersThread)?.modelSelection).toEqual(codex);
  });

  it("answers 404 for an unknown bot, 400 for a malformed body, and 403 for someone who may not change the model", async () => {
    const { store, bot } = fixture();
    const base = await serve(store);
    expect((await post(base, "nobody")).status).toBe(404);
    expect((await post(base, bot.id, { threadIds: "all" })).status).toBe(400);
    expect((await post(base, bot.id, { everything: true })).status).toBe(400);
    const guest = await serve(store, { owner: false });
    expect((await post(guest, bot.id)).status).toBe(403);
    expect((await fetch(`${base}/api/bots/${bot.id}/threads/follow-model`)).status).toBe(404);
  });
});

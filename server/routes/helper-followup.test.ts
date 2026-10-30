// POST /api/bots/:id/helper-followup: MausBot's follow-up after its first look around, written once under its intro as
// a real bot message, by MausBot's own person only.
import { readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { englishFollowup, FOLLOWUP_ENGLISH } from "../../shared/helper-followup.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { createDefaultBot } from "../default-bot.ts";
import { isContextMessage } from "../delta-context.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createBotMessageRoutes, type BotMessageRouteDeps } from "./bot-messages.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const BOT_SHELL: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const session = (email: string, admin = false) =>
  ({ kind: "session", via: "cookie", scopes: admin ? ["admin", "client"] : ["client"], session: { email } }) as unknown as RequestAuth;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function fixture(person?: string) {
  const store = new Store(() => sonnet);
  const maus = createDefaultBot(store, person ? { person } : {});
  const routines = [{ botId: maus.id, enabled: true }, { botId: maus.id, enabled: false }, { botId: "elsewhere", enabled: true }];
  const deps = { store, routines: () => ({ listRoutines: () => routines }) } as unknown as BotMessageRouteDeps;
  const routes = [createBotMessageRoutes(deps)];
  let auth = OWNER;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, as: RequestAuth = OWNER, botId = maus.id) => {
    auth = as;
    const res = await fetch(`${base}/api/bots/${botId}/helper-followup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as { message?: { id: string; text: string; helperFollowup?: unknown } } };
  };
  return { store, maus, post };
}

describe("MausBot's follow-up", () => {
  it("is written once under the intro, as a bot message the model reads, with the server's own counts", async () => {
    const { store, maus, post } = await fixture();
    store.createBot({ name: "Scout" });
    store.createBot({ name: "Gone" });
    store.patchBot(store.bots.find((bot) => bot.name === "Gone")!.id, { hidden: true });
    const first = await post({ ai: "own", apps: ["Gmail", " GitHub\n"] });
    expect(first.status).toBe(201);
    expect(first.body.message?.helperFollowup).toEqual({ ai: "own", apps: ["Gmail", "GitHub"], bots: 1, routines: 1 });
    expect(first.body.message?.text).toBe(englishFollowup({ ai: "own", apps: ["Gmail", "GitHub"], bots: 1, routines: 1 }));
    const thread = store.messagesFor(maus.threadId);
    expect(thread.map((message) => [message.role, message.kind, Boolean(message.helperIntro), Boolean(message.helperFollowup)]))
      .toEqual([["bot", "options", true, false], ["bot", "text", false, true]]);
    expect(isContextMessage(thread[1]!), "the model sees it").toBe(true);

    const again = await post({ ai: "none", apps: [] });
    expect(again.status, "idempotent: the one already there").toBe(200);
    expect(again.body.message?.id).toBe(first.body.message?.id);
    expect(store.messagesFor(maus.threadId)).toHaveLength(2);
  });

  it("is MausBot's own person's only: never a bot's shell, nor another member on a Team Cloud", async () => {
    const place = await fixture();
    expect((await place.post({ ai: "own" }, BOT_SHELL)).status).toBe(403);
    expect((await place.post({ ai: "own" }, session("someone@example.com"))).status).toBe(403);
    expect(place.store.messagesFor(place.maus.threadId)).toHaveLength(1);

    const team = await fixture("ada@example.com");
    expect((await team.post({ ai: "own" }, session("bob@example.com", true))).status, "not even an admin").toBe(403);
    expect((await team.post({ ai: "own" }, session("Ada@Example.com"))).status).toBe(201);
  });

  it("refuses another bot, a conversation without the intro, and a body it cannot read", async () => {
    const { store, maus, post } = await fixture();
    const scout = store.createBot({ name: "Scout" });
    expect((await post({ ai: "own" }, OWNER, scout.id)).status).toBe(404);
    expect((await post({ ai: "own", threadId: scout.threadId })).status, "another bot's conversation").toBe(404);
    const task = store.createTask(maus.id, "Later");
    expect((await post({ ai: "own", threadId: task!.threadId })).status).toBe(409);
    expect((await post({ ai: "maybe" })).status).toBe(400);
    expect((await post({ ai: "own", apps: ["x".repeat(61)] })).status).toBe(400);
  });
});

describe("its words", () => {
  it("are the English the app shows, so the model and the person read the same", () => {
    const en = JSON.parse(readFileSync(new URL("../../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(FOLLOWUP_ENGLISH)) expect(en[key], key).toBe(value);
  });
});

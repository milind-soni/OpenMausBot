import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createSignInCardRoutes, type SignInOutcome } from "./sign-in-cards.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const settled: Array<{ botId: string; threadId: string; messageId: string; outcome: SignInOutcome }> = [];
  const saved: Array<{ botId: string; threadId: string; messageId: string; body: Record<string, unknown> }> = [];
  const targets: Array<{ botId: string; threadId: string; messageId: string }> = [];
  const used: unknown[] = [];
  const routes = [createSignInCardRoutes({
    vault: {
      list: () => ({ status: 200, body: { choices: [{ id: "l1", name: "alice" }] } }),
      use: (...args) => { used.push(args); return { status: 200, body: { done: true, resumed: true, saved: true, site: "example.com" } }; },
    },
    settle: (botId, threadId, messageId, outcome) => {
      settled.push({ botId, threadId, messageId, outcome });
      return messageId === "gone" ? { status: 404, body: { error: "no such sign-in request" } } : { status: 200, body: { resumed: true } };
    },
    saveLogin: async (botId, threadId, messageId, body) => {
      saved.push({ botId, threadId, messageId, body });
      return { status: 200, body: { done: true, resumed: true, saved: true, site: "example.com" } };
    },
    saveTarget: async (botId, threadId, messageId) => {
      targets.push({ botId, threadId, messageId });
      return { status: 200, body: { site: "example.com", signInHost: "login.microsoftonline.com" } };
    },
    threadVisible: (_auth, threadId) => threadId !== "hidden",
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, type = "application/json") => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  return { base, settled, saved, targets, used, post };
}

describe("sign-in card routes", () => {
  it("settles Done and Cancel for the named bot, thread and card", async () => {
    const { settled, post } = await serve();
    const done = await post("/api/bots/scout/sign-in-cards/m1/done", { threadId: "t1" });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ resumed: true });
    expect((await post("/api/bots/scout/sign-in-cards/m2/cancel", { threadId: "t2" })).status).toBe(200);
    expect(settled).toEqual([
      { botId: "scout", threadId: "t1", messageId: "m1", outcome: "done" },
      { botId: "scout", threadId: "t2", messageId: "m2", outcome: "cancelled" },
    ]);
  });

  it("passes the server's refusal through", async () => {
    const { post } = await serve();
    const gone = await post("/api/bots/scout/sign-in-cards/gone/done", { threadId: "t1" });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "no such sign-in request" });
  });

  it("leaves other methods and paths to the next route", async () => {
    const { base, settled, targets, post } = await serve();
    expect(await (await fetch(`${base}/api/bots/scout/sign-in-cards/m1/done`)).json()).toEqual({ from: "inline routes" });
    expect(await (await fetch(`${base}/api/bots/scout/sign-in-cards/m1/save-login`, { method: "PUT" })).json()).toEqual({ from: "inline routes" });
    expect(targets).toEqual([]);
    expect(await (await post("/api/bots/scout/sign-in-cards/m1/open", { threadId: "t1" })).json()).toEqual({ from: "inline routes" });
    expect(settled).toEqual([]);
  });

  it("says where a login saved from the card would fill, before anything is saved", async () => {
    const { base, saved, targets } = await serve();
    const response = await fetch(`${base}/api/bots/scout/sign-in-cards/m1/save-login?threadId=t1`);
    expect(await response.json()).toEqual({ site: "example.com", signInHost: "login.microsoftonline.com" });
    expect(targets).toEqual([{ botId: "scout", threadId: "t1", messageId: "m1" }]);
    expect(saved).toEqual([]);
  });

  it("saves a login for the card and answers with the site only, never the password", async () => {
    const { saved, settled, post } = await serve();
    const response = await post("/api/bots/scout/sign-in-cards/m1/save-login", { threadId: "t1", username: "alice", password: "fake-card-pass" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ done: true, resumed: true, saved: true, site: "example.com" });
    expect(text).not.toContain("fake-card-pass");
    expect(saved).toEqual([{ botId: "scout", threadId: "t1", messageId: "m1", body: { threadId: "t1", username: "alice", password: "fake-card-pass" } }]);
    expect(settled).toEqual([]);
  });

  it("answers a card in a thread the caller cannot see as one that does not exist, and touches nothing", async () => {
    const { base, settled, saved, targets, post } = await serve();
    for (const action of ["done", "cancel"]) {
      const response = await post(`/api/bots/scout/sign-in-cards/m1/${action}`, { threadId: "hidden" });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: "no such sign-in request" } });
    }
    expect((await post("/api/bots/scout/sign-in-cards/m1/save-login", { threadId: "hidden", password: "fake-card-pass" })).status).toBe(404);
    expect((await fetch(`${base}/api/bots/scout/sign-in-cards/m1/save-login?threadId=hidden`)).status).toBe(404);
    expect([settled, saved, targets]).toEqual([[], [], []]);
  });

  it("names the saved logins a card could use, and uses one only as JSON and only in a thread the caller can see", async () => {
    const { base, used, post } = await serve();
    expect(await (await fetch(`${base}/api/bots/scout/sign-in-cards/m1/saved-logins?threadId=t1`)).json()).toEqual({ choices: [{ id: "l1", name: "alice" }] });
    expect(await (await fetch(`${base}/api/bots/scout/sign-in-cards/m1/saved-logins?threadId=hidden`)).json()).toEqual({ choices: [] });
    expect((await post("/api/bots/scout/sign-in-cards/m1/use-login", { threadId: "t1", loginId: "l1" }, "text/plain")).status).toBe(415);
    expect((await post("/api/bots/scout/sign-in-cards/m1/use-login", { threadId: "hidden", loginId: "l1" })).status).toBe(404);
    expect(used).toEqual([]);
    expect(await (await post("/api/bots/scout/sign-in-cards/m1/use-login", { threadId: "t1", loginId: "l1" })).json()).toMatchObject({ done: true, saved: true });
    expect(used).toEqual([["scout", "t1", "m1", "l1"]]);
  });

  it("takes a login as JSON only, so another page's form cannot post one", async () => {
    const { saved, post } = await serve();
    expect((await post("/api/bots/scout/sign-in-cards/m1/save-login", { threadId: "t1", password: "fake-card-pass" }, "text/plain")).status).toBe(415);
    expect(saved).toEqual([]);
  });
});

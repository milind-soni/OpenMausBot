import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createComputerSharing } from "./computer-sharing.mjs";

const until = async (check, what) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail(`never: ${what}`); };

async function fixture(t, { screen = () => false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "omb-lending-accounts-"));
  const env = { id: "cloud-a", origin: "https://a.fixture.test", name: "A's Cloud", cloud: { id: "c" } };
  const f = { env, account: "acct-a", status: "connected", origin: env.origin, places: [env], polls: [], asks: [], routes: [], live: () => [...f.polls, ...f.asks].filter((signal) => !signal.aborted).length };
  const identity = { sessionId: randomUUID(), environmentId: randomUUID() };
  const hold = (signal, list) => new Promise((resolve, reject) => { list.push(signal); signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  f.sharing = createComputerSharing({
    file: path.join(dir, "sharing.json"), environments: () => f.places, enabled: async () => false, home: path.join(dir, "home"),
    cloud: () => ({ status: f.status, accountId: f.account, origin: f.origin }), myCloud: () => f.places[0] ?? null, ownClouds: () => f.places,
    hostControl: async () => ({ renew: async () => {}, release: async () => {} }), screen,
    async fetch(url, { signal }) {
      const route = new URL(url).pathname;
      f.routes.push(route);
      if (route === "/api/auth/session") return Response.json({ kind: "session", id: identity.sessionId, cloudHome: true, scopes: ["admin"] });
      if (route === "/.well-known/openmausbot/environment") return Response.json({ environmentId: identity.environmentId, capabilities: { sharedComputers: true, computerAsks: true, asks: true } });
      if (route.endsWith("/poll")) await hold(signal, f.polls);
      if (route === "/api/shared-computers/asks") await hold(signal, f.asks);
      return Response.json({ ok: true });
    },
  });
  t.after(async () => { f.sharing.close(); await rm(dir, { recursive: true, force: true }); });
  return f;
}

/** The automatic pass has finished, and the connection it left is the one polling. */
async function settled(f) {
  await f.sharing.lendProjects([]);
  await until(() => f.polls.some((signal) => !signal.aborted), "the lent connection");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("switching: this computer stops working for the account left, its Cloud is told nothing and can go to sleep, and it comes back with that account", async (t) => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  f.sharing.cloudChanged();
  await settled(f);
  assert.equal(f.sharing.lendingToCloud(), true);
  f.routes.length = 0;

  f.sharing.leaveAccount("acct-a");
  assert.equal(f.live(), 0, "the lent connection and the asks' long poll both ended");
  assert.equal(f.sharing.lendingToCloud(), false, "nothing wants that Cloud awake");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.routes.filter((route) => route.endsWith("/disconnect")), [], "no request that could wake a sleeping Cloud");
  assert.equal(f.sharing.cloudState(f.env).enabled, true, "what was lent is kept");

  f.account = "acct-b"; f.origin = null; f.places = [];
  f.sharing.cloudChanged();
  const dialled = f.polls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.polls.length, dialled, "nothing dials the account left");

  f.account = "acct-a"; f.origin = f.env.origin; f.places = [f.env];
  f.sharing.cloudChanged();
  await until(() => f.sharing.lendingToCloud(), "lending again");
  await until(() => f.live() > 0, "its connection again");
});

test("leaving another account, or none, stops nothing", async (t) => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  f.sharing.cloudChanged();
  await until(() => f.polls.length > 0, "the lent connection");
  f.sharing.leaveAccount("acct-z");
  f.sharing.leaveAccount(null);
  assert.equal(f.sharing.lendingToCloud(), true);
});

test("a lending pass already under way when the account is left lends nothing more, and tells that Cloud nothing", async (t) => {
  const screen = Promise.withResolvers();
  let held = false;
  const f = await fixture(t, { screen: () => (held ? screen.promise : false) });
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  await settled(f);
  held = true;
  f.sharing.cloudChanged();
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.sharing.leaveAccount("acct-a");
  f.routes.length = 0;
  const polling = f.polls.length;
  screen.resolve(true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(f.routes.filter((route) => route.endsWith("/disconnect")), [], "no request that could wake a sleeping Cloud");
  assert.equal(f.polls.length, polling, "nothing dials the account left");
  assert.equal(f.sharing.lendingToCloud(), false);
});

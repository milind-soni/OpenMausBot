import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createComputerSharing } from "./computer-sharing.mjs";

const until = async (check, what) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail(`never: ${what}`); };
const settledYet = async (promise) => { let done = false; void promise.then(() => { done = true; }); await new Promise((resolve) => setTimeout(resolve, 25)); return done; };

/** One Cloud of the person's own, lent to, whose answer to a disconnect is held (`hold`) until the test lets it go, or fails (`fail`). */
async function fixture(t, { screen = () => false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "omb-lending-goodbyes-"));
  const env = { id: "cloud-a", origin: "https://a.fixture.test", name: "A's Cloud", cloud: { id: "c" } };
  const identity = { sessionId: randomUUID(), environmentId: randomUUID() };
  const f = { env, status: "connected", polls: 0, disconnects: 0, hold: false, fail: false, answer: Promise.withResolvers() };
  f.sharing = createComputerSharing({
    file: path.join(dir, "sharing.json"), environments: () => [env], enabled: async () => false, home: path.join(dir, "home"), screen,
    cloud: () => ({ status: f.status, accountId: "acct-a", origin: env.origin }), myCloud: () => env, ownClouds: () => [env],
    hostControl: async () => ({ renew: async () => {}, release: async () => {} }),
    async fetch(url, { signal }) {
      const route = new URL(url).pathname;
      if (route === "/api/auth/session") return Response.json({ kind: "session", id: identity.sessionId, cloudHome: true, scopes: ["admin"] });
      if (route === "/.well-known/openmausbot/environment") return Response.json({ environmentId: identity.environmentId, capabilities: { sharedComputers: true } });
      if (route.endsWith("/disconnect")) { f.disconnects++; if (f.fail) throw new Error("no answer"); if (f.hold) await f.answer.promise; return Response.json({ ok: true }); }
      if (route.endsWith("/poll")) { f.polls++; await new Promise((_resolve, reject) => { signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); }
      return Response.json({ ok: true });
    },
  });
  t.after(async () => { f.answer.resolve(); f.sharing.close(); await rm(dir, { recursive: true, force: true }); });
  return f;
}

test("signing out: lending's goodbye to each Cloud is waited for, so its answer can't put a session cookie back after the clear", async (t) => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  f.sharing.cloudChanged();
  await until(() => f.polls > 0, "the lent connection");
  await f.sharing.goodbyesDone();
  f.disconnects = 0; f.hold = true;
  f.status = "signed-out";
  f.sharing.cloudChanged();
  await until(() => f.disconnects > 0, "the disconnect");
  const done = f.sharing.goodbyesDone();
  assert.equal(await settledYet(done), false, "still waiting for the Cloud's answer");
  f.answer.resolve();
  assert.equal(await settledYet(done), true, "answered: the window's session can go now");
});

test("a goodbye that fails doesn't hold the sign-out up", async (t) => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  f.sharing.cloudChanged();
  await until(() => f.polls > 0, "the lent connection");
  await f.sharing.goodbyesDone();
  f.fail = true;
  f.status = "signed-out";
  f.sharing.cloudChanged();
  await until(() => f.disconnects > 0, "the disconnect");
  assert.equal(await settledYet(f.sharing.goodbyesDone()), true);
});

test("a lending pass under way is waited for too, since its end is what stops the asks' long poll", async (t) => {
  const screen = Promise.withResolvers();
  let held = false;
  const f = await fixture(t, { screen: () => (held ? screen.promise : false) });
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  f.sharing.cloudChanged();
  await until(() => f.polls > 0, "the lent connection");
  await f.sharing.goodbyesDone();
  held = true;
  f.sharing.cloudChanged();
  const done = f.sharing.goodbyesDone();
  assert.equal(await settledYet(done), false, "the pass is still reading this computer");
  screen.resolve(false);
  assert.equal(await settledYet(done), true);
});

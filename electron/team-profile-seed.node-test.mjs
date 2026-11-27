import assert from "node:assert/strict";
import test from "node:test";

import { SEED_PICTURE_MAX_BYTES, seedTeamProfile } from "./team-profile-seed.mjs";

const TEAM = "https://omb-t-1.fly.dev";

/** A team whose `/api/me` answers `me` (or each status in `statuses` first), and a computer whose profile is `local`. */
function world({ me = { name: "", email: "ada@acme.test", seeded: [] }, statuses = [], local = {}, picture = { type: "image/png", bytes: 68 } } = {}) {
  const sent = [];
  const run = (more = {}) => seedTeamProfile({
    origin: TEAM,
    async teamFetch(url, init = {}) {
      const path = new URL(url).pathname;
      sent.push({ method: init.method ?? "GET", path, origin: init.headers?.origin, body: typeof init.body === "string" ? init.body : undefined });
      if (path === "/api/me" && (init.method ?? "GET") === "GET") {
        const status = statuses.shift();
        return status ? new Response("", { status }) : Response.json(me);
      }
      if (path === "/api/attachments") return Response.json({ path: "/data/attachments/3f2a-picture.png" }, { status: 201 });
      if (path === "/api/me") return Response.json({ ...me, ...JSON.parse(init.body), filled: ["name"] });
      return new Response("", { status: 404 });
    },
    async localRequest(route) {
      if (route === "/api/config") return Response.json({ profile: { email: "ada@home.example", aboutMe: "Private.", ...local } });
      if (route === local.avatarUrl) return new Response(new Uint8Array(picture.bytes), { headers: { "content-type": picture.type, "content-length": String(picture.bytes) } });
      return new Response("", { status: 404 });
    },
    wait: async () => {},
    ...more,
  });
  return { sent, run };
}

test("waits for the window's session, then gives up without writing", async () => {
  const late = world({ statuses: [401, 401], local: { name: "Ada" } });
  assert.equal(await late.run(), "seeded");
  assert.deepEqual(late.sent.map((r) => `${r.method} ${r.path}`), ["GET /api/me", "GET /api/me", "GET /api/me", "PUT /api/me"]);
  const never = world({ statuses: [401, 401, 401], local: { name: "Ada" } });
  assert.equal(await never.run({ tries: 3 }), "signed-out");
  assert.ok(never.sent.every((r) => r.method === "GET"));
});

test("sends the name and the picture as the person's own upload, never the address or About me", async () => {
  const ada = world({ local: { name: "  Ada   Lovelace ", avatarUrl: "/api/attachments/ada.png" } });
  assert.equal(await ada.run(), "seeded");
  assert.deepEqual(ada.sent.map((r) => `${r.method} ${r.path}`), ["GET /api/me", "POST /api/attachments", "PUT /api/me"]);
  assert.deepEqual(JSON.parse(ada.sent.at(-1).body), { name: "Ada Lovelace", avatarUrl: "/api/attachments/3f2a-picture.png", fillEmpty: true });
  assert.ok(ada.sent.every((r) => r.origin === TEAM), "same-origin for the window's cookie");
  assert.doesNotMatch(JSON.stringify(ada.sent), /home\.example|Private/);
});

test("asks nothing of the computer when the team profile is already set or was filled before", async () => {
  for (const me of [{ name: "Ada", avatarUrl: "/api/attachments/a.png" }, { name: "", seeded: ["name", "avatarUrl"] }, { name: "Ada", seeded: ["avatarUrl"] }]) {
    let asked = 0;
    const done = world({ me, local: { name: "Desk", avatarUrl: "/api/attachments/d.png" } });
    assert.equal(await done.run({ localRequest: async () => { asked++; return new Response("", { status: 500 }); } }), "nothing");
    assert.equal(asked, 0);
    assert.deepEqual(done.sent.map((r) => r.method), ["GET"]);
  }
});

test("skips a picture that is not a stored image, the wrong type or too large", async () => {
  for (const [local, picture] of [
    [{ name: "", avatarUrl: "https://tracker.example/pixel.png" }, undefined],
    [{ name: "", avatarUrl: "/api/attachments/ada.svg" }, undefined],
    [{ name: "", avatarUrl: "/api/attachments/ada.png" }, { type: "image/svg+xml", bytes: 40 }],
    [{ name: "", avatarUrl: "/api/attachments/ada.png" }, { type: "image/png", bytes: SEED_PICTURE_MAX_BYTES + 1 }],
  ]) {
    const odd = world({ local, ...(picture ? { picture } : {}) });
    assert.equal(await odd.run(), "nothing");
    assert.deepEqual(odd.sent.map((r) => `${r.method} ${r.path}`), ["GET /api/me"]);
  }
});

test("a team that is not a Team Cloud, or a computer whose server is not running, sends nothing", async () => {
  const notTeam = world({ statuses: [404], local: { name: "Ada" } });
  assert.equal(await notTeam.run(), "nothing");
  const stopped = world({ local: { name: "Ada" } });
  assert.equal(await stopped.run({ localRequest: () => Promise.reject(new Error("not running")) }), "failed");
  assert.deepEqual(stopped.sent.map((r) => r.method), ["GET"]);
});

test("seeds each team once per run, and again after a seed that could not finish", async () => {
  const { createTeamProfileSeeds } = await import("./team-profile-seed.mjs");
  let calls = 0, answer = 401;
  const seeds = createTeamProfileSeeds({
    teamFetch: async () => { calls++; return new Response("", { status: answer }); },
    localRequest: async () => new Response("", { status: 404 }),
    tries: 1, wait: async () => {},
  });
  seeds.opened(TEAM);
  await new Promise((resolve) => setImmediate(resolve));
  seeds.opened(TEAM);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "a signed-out seed is tried again");
  answer = 404;
  seeds.opened(TEAM);
  await new Promise((resolve) => setImmediate(resolve));
  seeds.opened(TEAM);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3, "a finished seed is not repeated");
});

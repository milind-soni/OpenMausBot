import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY, itemKey } from "./cloud-send-parts.mjs";
import { createCloudSend, sendNotice } from "./cloud-send.mjs";
import { manifestGaps, noGaps } from "./cloud-send-check.mjs";
import { installCloudSend, openOwnerSession } from "./cloud-send-main.mjs";

const CLOUD = "https://omb-u-1.fly.dev";
const LOCAL = "http://127.0.0.1:4100";
const summary = (items, extra = {}) => ({ v: 1, appVersion: "0.1.120", items, chats: 1, ...extra });
const bot = (id, parts) => ({ key: itemKey.bot(id), kind: "bot", label: id, id, parts });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const reply = (status, body) => ({ status, ok: status < 400, body });
const stored = (value = null) => ({ read: () => value, write(next) { value = structuredClone(next); }, get value() { return value; } });

/**
 * This computer (`here`: its items, bots, connections and conversations) and a My Cloud that keeps what it is sent
 * (`there`: items by key, so a bot it makes takes its defaults until its fields arrive). `takesMove`: My Cloud says it
 * takes a move. `rowIds`: how many rows each of this computer's conversations has (one by default). Every call to My Cloud
 * is in `calls`.
 */
function sides({ here = [], bots = {}, there = [], connections = [], secrets = {}, takesMove = true, conversations = [], rowIds = {}, onCall = () => {} } = {}) {
  const calls = [];
  const cloud = new Map(there.map((item) => [item.key, structuredClone(item)]));
  const session = {
    call: async (method, route, body) => {
      calls.push(`${method} ${route}`);
      const intercepted = await onCall(method, route, body, cloud);
      if (intercepted) return intercepted;
      if (route === "/.well-known/openmausbot/environment") return reply(200, { capabilities: takesMove ? { cloudHome: true, move: 1 } : { cloudHome: true } });
      if (route.startsWith("/api/cloud-send?item=")) {
        const key = decodeURIComponent(route.slice("/api/cloud-send?item=".length).replace(/&move=1$/u, ""));
        return reply(200, summary([...cloud.values()].filter((item) => item.key === key || (item.kind === "skill" && key === itemKey.bot(item.bot)))));
      }
      if (route === "/api/cloud-send" || route === "/api/cloud-send?move=1") return reply(200, summary([...cloud.values()]));
      if (method === "GET" && route === "/api/cloud-send/files") return reply(200, { v: 1, files: [], space: { freeBytes: 1e12, volumeBytes: 1e12 } });
      if (method === "GET" && route === "/api/cloud-send/chats") return reply(200, { v: 1, conversations: [] });
      if (route === "/api/cloud-connections") return reply(200, { computer: { environmentId: "env-cloud", label: "My Cloud" }, connections: [], engines: ["claude"], commands: ["node"] });
      if (method === "POST" && route === "/api/bots") {
        cloud.set(itemKey.bot(body.id), bot(body.id, { soul: "starter", title: EMPTY, name: "n" }));
        return reply(201, { bot: { id: body.id } });
      }
      const patched = /^\/api\/bots\/([\w-]+)$/u.exec(route);
      if (method === "PATCH" && patched) {
        const item = cloud.get(itemKey.bot(patched[1]));
        if (body.soul) item.parts.soul = `h:${body.soul}`;
        return reply(200, {});
      }
      if (route === "/api/cloud-send/chats") return reply(200, { conversations: 0, messages: 0, accepted: body.conversations.map((entry) => entry.threadId), waiting: [], removed: [] });
      return reply(200, {});
    },
    upload: async (route) => { calls.push(`UPLOAD ${route}`); return reply(201, { path: "/data/attachments/x.png" }); },
    close: async () => { calls.push("logout"); },
  };
  const opened = [];
  const asked = [];
  const deps = {
    local: async (route, init) => {
      if (init?.method && init.method !== "GET") { calls.push(`HERE ${init.method} ${route}`); return json({ v: 1, removed: true }); }
      if (route === "/api/cloud-send" || route === "/api/cloud-send?move=1") return json(summary(here));
      if (route.startsWith("/api/cloud-send/memory?bot=")) return json({ v: 1, files: [], journal: [] });
      if (route === "/api/cloud-send/memory") return json({ v: 1, about: { learned: [], removed: [] }, teams: [] });
      if (route === "/api/cloud-send/files") return json({ v: 1, files: [] });
      if (route.startsWith("/api/cloud-send/kind?key=")) return json({ v: 1, dataDir: "/desk/.openmausbot", record: route.includes("routine") ? { enabled: true } : route.includes("app-event") ? { enabled: false } : {} });
      if (route === "/api/cloud-send/chats?attachments=1") return json({ v: 1, dataDir: "/desk/.openmausbot", conversations, attachments: [] });
      if (route === "/api/bots?messages=0") return json({ bots: Object.entries(bots).map(([id, fields]) => ({ id, threadId: `t-${id}`, name: id, ...fields })) });
      if (/^\/api\/bots\/[\w-]+\/skills$/u.test(route)) return json({ skills: [] });
      if (/^\/api\/bots\/[\w-]+\/memory$/u.test(route)) return json({ topics: [] });
      if (route.includes("/memory/file")) return json({ exists: false, text: "" });
      if (route === "/api/cloud-connections") return json({ computer: { environmentId: "env-desk", label: "Amit's Mac" }, connections, engines: [], commands: [] });
      if (route === "/api/cloud-send/chats") return json({ v: 1, dataDir: "/desk/.openmausbot", conversations });
      const listed = /^\/api\/cloud-send\/chats\/ids\?thread=([\w-]+)&from=(\d+)$/u.exec(route);
      if (listed) {
        const all = Array.from({ length: rowIds[listed[1]] ?? 1 }, (_, i) => `${listed[1]}-${i + 1}`), from = Number(listed[2]);
        return json({ v: 1, ids: all.slice(from, from + 5_000), path: all.slice(from, from + 5_000), leaf: all.at(-1), more: from + 5_000 < all.length });
      }
      const rows = /^\/api\/cloud-send\/chats\/rows\?thread=([\w-]+)&after=(\d+)/u.exec(route);
      if (rows) return json({ rows: [{ id: `${rows[1]}-1`, at: 1 }], leaf: `${rows[1]}-1`, task: null, last: 1, lastId: `${rows[1]}-1`, more: false, restarted: false, attachments: [] });
      return json({}, 404);
    },
    cloud: { origin: () => CLOUD, asleep: () => false, read: async () => json(summary([...cloud.values()])), open: async (options) => { opened.push(options ?? null); return session; } },
    handoff: async (what) => {
      asked.push(what);
      if (what.kind === "connection") return secrets[what.id];
      if (what.kind === "connection-release") return { release: { released: true } };
      return {};
    },
    store: stored(),
    engineWaitMs: 0,
  };
  return { calls, cloud, deps, opened, asked };
}

test("a move carries everything: what was once kept here goes, what was removed on My Cloud stays removed, and apps and keys go before the bots", async () => {
  const off = { [itemKey.bot("ember")]: "you", [itemKey.bot("juno")]: "removed" };
  const make = () => sides({
    here: [bot("ember", { soul: "s1" }), bot("juno", { soul: "s2" })], bots: { ember: { soul: "s1" }, juno: { soul: "s2" } },
    connections: [{ id: "key:openrouter", kind: "key", label: "OpenRouter", for: ["openrouter"] }],
    secrets: { "key:openrouter": { connection: { config: { openrouter: { key: "sk-or-v1-fake" } } } } },
  });
  const moving = make();
  moving.deps.store = stored({ v: 1, clouds: { [CLOUD]: { off } } });
  const outcome = await createCloudSend(moving.deps).send({ reason: "move" });
  assert.deepEqual(outcome.result.failed, []);
  assert.deepEqual(outcome.result.bots, ["ember"], "kept here once, it goes now; removed on My Cloud, it never comes back");
  assert.equal(outcome.result.connections, 1);
  const key = moving.calls.indexOf("PATCH /api/config"), first = moving.calls.indexOf("POST /api/bots");
  assert.ok(key >= 0 && key < first, `the key went before the first bot: ${moving.calls.join(", ")}`);
  assert.deepEqual(moving.opened, [{ move: true }]);

  const sending = make();
  sending.deps.store = stored({ v: 1, clouds: { [CLOUD]: { off } } });
  const button = await createCloudSend(sending.deps).send();
  assert.deepEqual(button.result.bots, [], "Send everything still keeps here what the person kept here");
  assert.ok(!sending.calls.includes("PATCH /api/config"), "only a move carries apps and keys");
  assert.deepEqual(sending.opened, [null]);
});

test("a move goes only to a Cloud that says it takes one, and touches nothing on one that doesn't", async () => {
  const old = sides({ here: [bot("ember", { soul: "s1" })], bots: { ember: { soul: "s1" } }, takesMove: false });
  await assert.rejects(createCloudSend(old.deps).send({ reason: "move" }), /^CloudSendError: My Cloud is updating\. Your bots move there by themselves when it's done\.$/u);
  assert.deepEqual(old.calls.filter((call) => !call.startsWith("GET ")), ["logout"]);
});

test("the first pass leaves a sign-in that refreshes itself here; the final pass carries it, and this computer lets go of its copy", async () => {
  const linear = { name: "linear", server: { type: "http", url: "https://mcp.linear.example.test/mcp", headers: {}, enabled: true }, signIn: { url: "https://mcp.linear.example.test/mcp", state: "signed-in", tokens: { access: "a", refresh: "r" } } };
  const move = sides({ connections: [{ id: "mcp:linear", kind: "mcp", label: "linear", signIn: true }],
    secrets: { "mcp:linear": { connection: { mcp: linear }, digest: "d".repeat(64) } } });
  const send = createCloudSend(move.deps);
  await send.send({ reason: "move" });
  assert.ok(move.calls.includes("POST /api/mcp/servers"), "the server itself goes in the first pass");
  assert.ok(!move.calls.some((call) => call.endsWith("/sign-in")), "its sign-in stays here until this computer stops");
  assert.ok(!move.asked.some((what) => what.kind === "connection-release"));
  await send.send({ reason: "move", final: true });
  assert.ok(move.calls.includes("PUT /api/cloud-connections/mcp/linear/sign-in"));
  assert.deepEqual(move.asked.filter((what) => what.kind === "connection-release").map((what) => what.id), ["mcp:linear"]);
});

test("a bot a move made on My Cloud has all its fields sent again when the move was cut short before they were recorded", async () => {
  let cut = true;
  const move = sides({ here: [bot("ember", { soul: "h:mine", title: "h:boss" })], bots: { ember: { soul: "mine", title: "boss" } },
    onCall: (method, route) => { if (cut && method === "PATCH" && route === "/api/bots/ember") throw new TypeError("fetch failed"); } });
  const send = createCloudSend(move.deps);
  const first = await send.send({ reason: "move" });
  assert.equal(first.result.failed[0]?.key, itemKey.bot("ember"));
  assert.equal(move.cloud.get(itemKey.bot("ember")).parts.soul, "starter", "My Cloud made the bot with its own defaults");
  cut = false;
  move.calls.length = 0;
  await send.send({ reason: "move" });
  assert.ok(move.calls.includes("PATCH /api/bots/ember"), `its fields went this time: ${move.calls.join(", ")}`);
  assert.equal(move.cloud.get(itemKey.bot("ember")).parts.soul, "h:mine");
  assert.ok(!move.calls.includes("POST /api/bots"), "the bot is not made twice");
});

test("each item is recorded from My Cloud's own answer as soon as it went, so a send cut short later never takes it for My Cloud's own change", async () => {
  const store = stored({ v: 1, clouds: { [CLOUD]: { sent: { [itemKey.bot("juno")]: { team: ["p1", "p1"] } } } } });
  let cutAtEnd = true;
  const move = sides({ here: [bot("juno", { team: "p2" })], bots: { juno: { peers: ["ember"] } }, there: [bot("juno", { team: "p1" })],
    onCall: (method, route, _body, cloud) => {
      // My Cloud keeps the team without the bot it lacks: its own hash for what it took.
      if (method === "PATCH" && route === "/api/bots/juno") { cloud.get(itemKey.bot("juno")).parts.team = "p3"; return reply(200, {}); }
      if (cutAtEnd && method === "GET" && route === "/api/cloud-send?move=1" && cloud.get(itemKey.bot("juno")).parts.team === "p3") throw new TypeError("fetch failed");
    } });
  move.deps.store = store;
  const send = createCloudSend(move.deps);
  await assert.rejects(send.send({ reason: "move" }), /fetch failed/u);
  assert.ok(move.calls.includes(`GET /api/cloud-send?item=${encodeURIComponent(itemKey.bot("juno"))}&move=1`));
  cutAtEnd = false;
  const row = (await send.compare()).rows.find((entry) => entry.key === itemKey.bot("juno"));
  assert.equal(row.state, "on-both", "what My Cloud took is in step, not My Cloud's own change");
});

test("a bot My Cloud made as this computer stopped, before the answer came, is the move's own: all its fields go when it goes on", async () => {
  // Seen in the real app on Oct 22: killed mid-move, My Cloud made "Otto" 70 ms later, and the move went on taking it for
  // My Cloud's own bot: its colour never went, and the check called it missing on every pass.
  let dying = true;
  const move = sides({ here: [bot("ember", { soul: "h:mine" })], bots: { ember: { soul: "mine" } },
    onCall: (method, route, body, cloud) => {
      if (dying && method === "POST" && route === "/api/bots") { cloud.set(itemKey.bot(body.id), bot(body.id, { soul: "starter" })); throw new TypeError("fetch failed"); }
    } });
  await createCloudSend(move.deps).send({ reason: "move" });
  assert.equal(move.cloud.get(itemKey.bot("ember")).parts.soul, "starter", "My Cloud made it, this computer never heard");
  dying = false;
  move.calls.length = 0;
  await createCloudSend(move.deps).send({ reason: "move" });
  assert.equal(move.cloud.get(itemKey.bot("ember")).parts.soul, "h:mine", `this computer's fields went: ${move.calls.join(", ")}`);
  assert.ok(!move.calls.includes("POST /api/bots"), "the bot is not made twice");

  let lost = true;
  const never = sides({ here: [bot("juno", { soul: "h:j" })], bots: { juno: { soul: "j" } },
    onCall: (method, route) => { if (lost && method === "POST" && route === "/api/bots") throw new TypeError("fetch failed"); } });
  await createCloudSend(never.deps).send({ reason: "move" });
  lost = false;
  const again = await createCloudSend(never.deps).send({ reason: "move" });
  assert.deepEqual(again.result.bots, ["juno"], "one My Cloud never made goes now, and never counts as removed there");
  assert.equal(never.cloud.get(itemKey.bot("juno")).parts.soul, "h:j");
});

test("a move keeps My Cloud's version of a part both sides hold otherwise with nothing recorded, and records it, so its check never calls it missing", async () => {
  // The same bot on both sides with no send ever recorded (an earlier whole-workspace Copy, or a lost cloud-send.json),
  // and its approval changed on My Cloud since: §2.2 keeps My Cloud's. Seen in the real app on Oct 22: the check called
  // `access` missing on every pass, so the move froze, thawed and tried again every hour without end.
  const here = [bot("ember", { soul: "s1", access: EMPTY })], there = [bot("ember", { soul: "s1", access: "a-full" })];
  const move = sides({ here, bots: { ember: { soul: "s1" } }, there });
  const send = createCloudSend(move.deps);
  await send.send({ reason: "move" });
  assert.ok(!move.calls.includes("PATCH /api/bots/ember"), `My Cloud's is kept, nothing goes: ${move.calls.join(", ")}`);
  const sent = move.deps.store.value.clouds[CLOUD].sent;
  assert.deepEqual(sent[itemKey.bot("ember")].access, [EMPTY, "a-full"], "the move's decision is recorded");
  assert.equal(noGaps(manifestGaps({ items: here }, { items: there }, { sent })), true, "the check agrees with the plan");

  const button = sides({ here, bots: { ember: { soul: "s1" } }, there });
  await createCloudSend(button.deps).send();
  assert.equal(button.deps.store.value.clouds[CLOUD].sent[itemKey.bot("ember")].access, undefined, "Send everything still leaves it to the person");
});

test("Settings learns how many conversations are still to go, and a pass says how many did not all go", async () => {
  const conversations = ["a", "b", "c"].map((threadId) => ({ bot: "ember", threadId, last: 1, lastId: `${threadId}-1`, busy: threadId === "c" }));
  const move = sides({ here: [bot("ember", { soul: "s" })], there: [bot("ember", { soul: "s" })], bots: { ember: { soul: "s" } }, conversations,
    onCall: (method, route, body) => route === "/api/cloud-send/chats"
      ? reply(200, { conversations: 0, messages: 1, accepted: body.conversations.map((entry) => entry.threadId).filter((id) => id !== "b"), waiting: ["b"], removed: [] }) : null });
  const send = createCloudSend(move.deps);
  assert.deepEqual((await send.compare()).chats, { waiting: 3 });
  const outcome = await send.send({ reason: "move" });
  assert.equal(outcome.result.chats.left, 2, "one a bot is answering in, and one My Cloud did not take yet");
  assert.deepEqual(send.snapshot().chats, { waiting: 2 });
});

test("a move's session counts as someone using My Cloud, so it stays awake; any other session main opens never does", async () => {
  const headers = [];
  const fetchImpl = async (url, init) => { headers.push([String(url).replace(CLOUD, ""), init.headers["x-omb-background"] ?? null, init.body]); return json({ token: "omb_sess_fake" }); };
  const target = { origin: CLOUD, grant: async () => ({ origin: CLOUD, code: "C" }) };
  const moving = await openOwnerSession(target, fetchImpl, { label: "Move to My Cloud", background: false });
  await moving.call("GET", "/api/cloud-send");
  await moving.close();
  const sending = await openOwnerSession(target, fetchImpl);
  await sending.call("GET", "/api/cloud-send");
  assert.deepEqual(headers.map(([route, background]) => [route, background]), [
    ["/api/auth/pair", null], ["/api/cloud-send", null], ["/api/auth/logout", null], ["/api/auth/pair", "1"], ["/api/cloud-send", "1"],
  ]);
  assert.equal(JSON.parse(headers[0][2]).label, "Move to My Cloud");

  const paired = [];
  const handlers = new Map();
  const listing = { computer: { environmentId: "env", label: "Mac" }, connections: [], engines: [], commands: [] };
  const main = installCloudSend({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, cloudPage: () => "local", server: () => null,
    local: async (route) => json(route === "/api/cloud-send" || route === "/api/cloud-send?move=1" ? summary([]) : route === "/api/cloud-connections" ? listing : { v: 1, dataDir: "/d", conversations: [] }),
    home: () => target, cookieFetch: async () => json({}, 401), reconnect: async () => false, power: { asleep: () => false },
    file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => LOCAL,
    fetch: async (url, init) => {
      const route = String(url).replace(CLOUD, "");
      if (route === "/api/auth/pair") { paired.push([JSON.parse(init.body).label, init.headers["x-omb-background"] ?? null]); return json({ token: "omb_sess_fake" }); }
      return json(route === "/api/cloud-send" || route === "/api/cloud-send?move=1" ? summary([]) : route === "/.well-known/openmausbot/environment" ? { capabilities: { move: 1 } } : route === "/api/cloud-connections" ? listing : {});
    },
  });
  assert.equal((await main.move()).reason, "move");
  assert.deepEqual(paired, [["Move to My Cloud", null]]);
});

test("an app or key that could not move is said with My Cloud's reason, counted, and never stops the bots", async () => {
  const move = sides({ here: [bot("ember", { soul: "s1" })], bots: { ember: { soul: "s1" } },
    connections: [{ id: "key:openrouter", kind: "key", label: "OpenRouter", for: ["openrouter"] }],
    secrets: { "key:openrouter": { connection: { config: { openrouter: { key: "sk-or-v1-fake" } } } } },
    onCall: (method, route) => method === "PATCH" && route === "/api/config" ? reply(400, { error: "this key is not for this Cloud" }) : null });
  const send = createCloudSend(move.deps);
  const outcome = await send.send({ reason: "move" });
  assert.deepEqual(outcome.result.bots, ["ember"]);
  assert.deepEqual(outcome.result.failed, [{ key: "key:openrouter", kind: "connection", label: "OpenRouter", error: "My Cloud said: this key is not for this Cloud", final: true }]);
  assert.deepEqual(sendNotice(send.snapshot()).last.reasons, [{ what: { bots: [], skills: 0, logins: 0, onePassword: false, settings: 0, connections: 1, chats: false },
    error: "My Cloud said: this key is not for this Cloud" }]);
});

test("a move has My Cloud keep as its owner's the lines it already held of this computer's bots and rooms, by row id only, and Send everything never asks", async () => {
  const conversations = [
    { bot: "ember", threadId: "t-ember", last: 1, lastId: "t-ember-1", busy: false },
    { bot: "juno", threadId: "t-juno", last: 1, lastId: "t-juno-1", busy: false },
    { room: "r1", threadId: "t-room", last: 1, lastId: "t-room-1", busy: false },
  ];
  const asked = [];
  const make = () => sides({ here: [bot("ember", { soul: "s" })], there: [bot("ember", { soul: "s" })], bots: { ember: { soul: "s" } }, conversations, rowIds: { "t-ember": 12_001 },
    onCall: (method, route, body) => {
      if (route !== "/api/cloud-send/chats/owner") return null;
      asked.push(body.conversations.map((entry) => [entry.threadId, entry.ids.length, entry.ids[0]]));
      return reply(200, { v: 1, stamped: 1 });
    } });
  const outcome = await createCloudSend(make().deps).send({ reason: "move" });
  assert.deepEqual(outcome.result.failed, []);
  assert.deepEqual(asked, [[["t-ember", 5_000, "t-ember-1"], ["t-ember", 5_000, "t-ember-5001"]], [["t-ember", 2_001, "t-ember-10001"], ["t-room", 1, "t-room-1"]]],
    "Ember's and the room's row ids, at most 10,000 a request; Juno is not on My Cloud");
  asked.length = 0;
  await createCloudSend(make().deps).send();
  assert.deepEqual(asked, [], "only the move asks");
});

test("a move names at most 200 of the conversations My Cloud held a request, never one removed there, and says it when My Cloud refuses", async () => {
  const conversations = [
    ...Array.from({ length: 201 }, (_, i) => ({ bot: "ember", threadId: `t-ember-${i}`, last: 1, lastId: `t-ember-${i}-1`, busy: false })),
    { bot: "ember", threadId: "t-gone", last: 1, lastId: "t-gone-1", busy: false },
  ];
  let refuse = false;
  const asked = [];
  const make = () => {
    const both = sides({ here: [bot("ember", { soul: "s" })], there: [bot("ember", { soul: "s" })], bots: { ember: { soul: "s" } }, conversations,
      onCall: (method, route, body) => {
        if (route !== "/api/cloud-send/chats/owner") return null;
        asked.push(body.conversations.map((entry) => entry.threadId));
        return refuse ? reply(500, { error: "the store is busy" }) : reply(200, { v: 1, stamped: 0 });
      } });
    both.deps.store = stored({ v: 1, clouds: { [CLOUD]: { chats: { "t-gone": "removed" } } } });
    return both;
  };
  assert.deepEqual((await createCloudSend(make().deps).send({ reason: "move" })).result.failed, []);
  assert.deepEqual(asked.map((threads) => threads.length), [200, 1]);
  assert.ok(!asked.flat().includes("t-gone"), "removed on My Cloud, its lines are never named");
  refuse = true;
  const refused = await createCloudSend(make().deps).send({ reason: "move" });
  assert.deepEqual(refused.result.failed.map((failure) => [failure.key, failure.error]), [["chats", "My Cloud said: the store is busy"]]);
});

test("a move sends what only it carries last, after the chats and their settings, switched off there; an app event only in the final pass, which this computer then lets go of", async () => {
  const kind = (key, kindName, parts) => ({ key, kind: kindName, label: key, id: key.split(":")[1], bot: "ember", parts });
  const conversations = [{ bot: "ember", threadId: "a", last: 1, lastId: "a-1", busy: false, settings: { snoozedUntil: 5 } }];
  const put = [];
  const move = sides({ here: [bot("ember", { soul: "s" }), kind("routine:r1", "routine", { def: "d1", runs: "x" }), kind("app-event:e1", "app-event", { def: "d2" }),
    { key: "imported-skill:tidy", kind: "imported-skill", label: "tidy", id: "tidy", parts: { files: "f" } }], there: [bot("ember", { soul: "s" })], bots: { ember: { soul: "s" } }, conversations,
  onCall: (method, route, body, cloud) => {
    if (method === "PUT" && route === "/api/cloud-send/kind") { put.push(body.key); cloud.set(body.key, { key: body.key, kind: body.key.split(":")[0], label: body.key, id: body.key.split(":")[1], parts: body.key === "routine:r1" ? { def: "d1", runs: "x" } : body.key === "app-event:e1" ? { def: "d2" } : { files: "f" } }); return reply(200, { v: 1, ok: true }); }
    if (method === "GET" && route === "/api/cloud-send/chats") return reply(200, { v: 1, conversations: [{ threadId: "a", settings: {} }] });
    if (method === "POST" && route === "/api/cloud-send/chats/settings") return reply(200, { v: 1, changed: body.conversations.length });
    return null;
  } });
  const send = createCloudSend(move.deps);
  const first = await send.send({ reason: "move" });
  assert.deepEqual(first.result.failed, []);
  assert.deepEqual(put, ["imported-skill:tidy", "routine:r1"], "an app event waits for the final pass");
  assert.deepEqual(send.switches(), { "routine:r1": true });
  const at = (call) => move.calls.indexOf(call);
  assert.ok(at("PUT /api/cloud-send/kind") > -1 && move.calls.lastIndexOf("PUT /api/cloud-send/kind") > at("POST /api/cloud-send/chats"), "the routine went after the chats");
  assert.ok(move.calls.lastIndexOf("PUT /api/cloud-send/kind") > at("POST /api/cloud-send/chats/settings"), "and after their settings");
  assert.ok(at("PUT /api/cloud-send/kind") < at("POST /api/cloud-send/chats"), "a skill goes before the chats");
  assert.equal(first.result.conversationSettings, 1);
  assert.equal(first.result.moved, 2);
  assert.ok(!move.calls.some((call) => call.startsWith("HERE ")), "this computer lets go of nothing yet");

  const final = await send.send({ reason: "move", final: true });
  assert.deepEqual(final.result.failed, []);
  assert.deepEqual(put.slice(2), ["app-event:e1"]);
  assert.ok(move.calls.includes(`HERE DELETE /api/cloud-send/kind?key=${encodeURIComponent("app-event:e1")}`));
  assert.equal(final.result.moved, 1);
  assert.deepEqual(move.deps.store.value.clouds[CLOUD].on, { "routine:r1": true, "app-event:e1": false }, "what was on here is kept for the switch, after this computer let go");
});

test("what a move carries last is never taken for removed on My Cloud, so a routine changed here before the final pass still goes", async () => {
  // Seen in the real app on Oct 22: after a plain move, cloud-send.json had every routine and webhook it had just carried
  // as "removed", because the pass's closing plan read My Cloud before the automations went.
  const routine = (def) => ({ key: "routine:r1", kind: "routine", label: "Digest", id: "r1", bot: "ember", parts: { def } });
  const here = [bot("ember", { soul: "s" }), routine("d1")];
  const put = [];
  const move = sides({ here, there: [bot("ember", { soul: "s" })], bots: { ember: { soul: "s" } },
    onCall: (method, route, body, cloud) => {
      if (method === "PUT" && route === "/api/cloud-send/kind") { put.push(body.key); cloud.set(body.key, here.find((item) => item.key === body.key)); return reply(200, { v: 1, ok: true }); }
      return null;
    } });
  const send = createCloudSend(move.deps);
  await send.send({ reason: "move" });
  assert.deepEqual(put, ["routine:r1"]);
  assert.equal(move.deps.store.value.clouds[CLOUD].off["routine:r1"], undefined, "it went, it is not removed there");
  here[1] = routine("d2");
  await send.send({ reason: "move", final: true });
  assert.deepEqual(put, ["routine:r1", "routine:r1"], "changed here since, it goes again in the final pass");
});

test("a routine on both sides whose only difference is its runs goes in a move, so the runs made here reach My Cloud; one changed on both keeps My Cloud's", async () => {
  // Seen in the real app on Oct 22: a computer whose workspace My Cloud already held (an earlier Copy) kept running a
  // routine; the move kept My Cloud's run list, and its check found "1 runs missing" on every pass, so it never finished.
  const routine = (def, runs) => ({ key: "routine:r1", kind: "routine", label: "Digest", id: "r1", bot: "ember", parts: { def, runs } });
  const make = (here, there) => {
    const put = [];
    const move = sides({ here: [bot("ember", { soul: "s" }), here], there: [bot("ember", { soul: "s" }), there], bots: { ember: { soul: "s" } },
      onCall: (method, route, body) => { if (method === "PUT" && route === "/api/cloud-send/kind") { put.push(body.key); return reply(200, { v: 1, ok: true }); } return null; } });
    return { move, put };
  };
  const runsOnly = make(routine("d1", "runs-here"), routine("d1", "runs-there"));
  await createCloudSend(runsOnly.move.deps).send({ reason: "move" });
  assert.deepEqual(runsOnly.put, ["routine:r1"], "its runs go: My Cloud adds them by id");

  const both = make(routine("d-here", "runs-here"), routine("d-there", "runs-there"));
  await createCloudSend(both.move.deps).send({ reason: "move" });
  assert.deepEqual(both.put, [], "changed on both: My Cloud's routine is kept");
});

test("a bot's fields only a move carries go over My Cloud's move route, absent ones as cleared; any other send never carries them", async () => {
  const fields = [];
  const make = () => sides({ here: [bot("ember", { soul: "s", pinned: "p1", projects: "j1" })], there: [bot("ember", { soul: "s", pinned: "-", projects: "-" })], bots: { ember: { soul: "s" } },
    onCall: (method, route, body) => { if (method === "PUT" && route === "/api/cloud-send/kind") { fields.push(body); return reply(200, { v: 1, ok: true }); } return null; } });
  const moving = make();
  moving.deps.local = ((local) => async (route, init) => route.startsWith("/api/cloud-send/kind?key=")
    ? json({ v: 1, dataDir: "/desk", record: { pinned: true, projects: [{ id: "p1", name: "Launch" }], hidden: true } }) : local(route, init))(moving.deps.local);
  await createCloudSend(moving.deps).send({ reason: "move" });
  assert.deepEqual(fields.map((body) => [body.key, body.record]), [["bot:ember", { pinned: true, projects: [{ id: "p1", name: "Launch" }] }]]);
  fields.length = 0;
  const sending = make();
  await createCloudSend(sending.deps).send({ reason: "button" });
  assert.deepEqual(fields, []);
});

test("while the chats go, the move's progress counts chats only: the automations after them never add to it", async () => {
  // Seen in the real app on Oct 22: the line read "5 of 5 chats" for a moment, and what went after the chats counted on.
  const routine = (id) => ({ key: `routine:${id}`, kind: "routine", label: id, id, bot: "ember", parts: { def: id } });
  const conversations = ["a", "b"].map((threadId) => ({ bot: "ember", threadId, last: 1, lastId: `${threadId}-1`, busy: false }));
  const here = [bot("ember", { soul: "s" }), routine("r1"), routine("r2")];
  const move = sides({ here, there: [bot("ember", { soul: "s" })], bots: { ember: { soul: "s" } }, conversations,
    onCall: (method, route, body, cloud) => {
      if (method === "PUT" && route === "/api/cloud-send/kind") { cloud.set(body.key, here.find((item) => item.key === body.key)); return reply(200, { v: 1, ok: true }); }
      return null;
    } });
  const seen = [];
  move.deps.onChange = (snapshot) => { if (snapshot.running?.phase === "chats") seen.push(snapshot.running.progress ?? null); };
  await createCloudSend(move.deps).send({ reason: "move" });
  const counted = seen.filter(Boolean);
  assert.ok(counted.length > 0, "the chats are counted as they go");
  assert.ok(counted.every((progress) => progress.total === 2 && progress.done <= 2), `every count is of the 2 chats: ${JSON.stringify(counted)}`);
  assert.deepEqual(counted.at(-1), { done: 2, total: 2 });
});

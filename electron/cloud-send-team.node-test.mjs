import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY, itemKey } from "./cloud-send-parts.mjs";
import { createCloudSend } from "./cloud-send.mjs";

const TEAM = "https://omb-u-acme.fly.dev";
const OWNER = "p_mycloudownerkeyxxxxxxx";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const reply = (status, body) => ({ status, ok: status < 400, body });
const summary = (items) => ({ v: 1, appVersion: "0.1.121", items, chats: 1 });
const scout = { key: itemKey.bot("scout"), kind: "bot", label: "Scout", id: "scout", parts: { soul: "s1", name: "n1" } };

/** My Cloud as the source of one bot's move (every read it got), and a team that keeps what it is sent (every call). */
function sides() {
  const reads = [], calls = [];
  const there = new Map();
  const local = async (route) => {
    reads.push(route);
    const bare = route.replace(/[?&]bot=scout$/u, "");
    if (bare === "/api/cloud-send?move=1") return json(summary(route.includes("bot=scout") ? [scout] : [scout, { key: "login:x|y", kind: "login", label: "x", parts: { saved: "1" } }]));
    if (bare === "/api/bots?messages=0") return json({ bots: [{ id: "scout", name: "Scout", threadId: "scout-main", soul: "Plans trips." }] });
    if (/^\/api\/bots\/scout\/skills$/u.test(bare)) return json({ skills: [] });
    if (bare === "/api/cloud-send/files") return json({ v: 1, files: [] });
    if (bare === "/api/cloud-send/chats?attachments=1") return json({ v: 1, attachments: [] });
    if (bare === "/api/cloud-send/chats") return json({ v: 1, dataDir: "/mycloud", owner: OWNER, conversations: [{ bot: "scout", threadId: "scout-main", last: 1, lastId: "r1", busy: false, settings: {} }] });
    if (bare.startsWith("/api/cloud-send/chats/rows?thread=scout-main")) return json({ rows: [{ id: "r1", at: 1, role: "user", text: "hi", sender: { id: OWNER, name: "Ada" } }], leaf: "r1", task: null, last: 1, lastId: "r1", more: false, attachments: [] });
    if (bare.startsWith("/api/cloud-send/chats/ids?thread=scout-main")) return json({ v: 1, ids: ["r1"], path: ["r1"], leaf: "r1", more: false });
    if (bare === "/api/cloud-send/manifest") return json({ v: 1, items: [scout], conversations: [{ threadId: "scout-main", bot: "scout", rows: 1, newest: "r1", settings: {} }], attachments: [], files: [], automations: [], runs: [] });
    return json({}, 404);
  };
  const session = {
    call: async (method, route, body) => {
      calls.push([method, route, body]);
      if (route === "/.well-known/openmausbot/environment") return reply(200, { capabilities: { cloudHome: true, move: 1 } });
      if (route.startsWith("/api/cloud-send?")) return reply(200, summary([...there.values()]));
      if (method === "POST" && route === "/api/bots") { there.set(itemKey.bot(body.id), { ...scout, parts: { soul: EMPTY, name: "n2" } }); return reply(201, { bot: { id: body.id } }); }
      if (method === "PATCH" && route === "/api/bots/scout") { if (body.soul) there.get(scout.key).parts.soul = "s1"; return reply(200, {}); }
      if (route.startsWith("/api/cloud-send/files")) return reply(200, { v: 1, files: [], space: { freeBytes: 1e12, volumeBytes: 1e12 } });
      if (method === "GET" && route.startsWith("/api/cloud-send/chats")) return reply(200, { v: 1, conversations: [{ threadId: "scout-main", settings: {} }] });
      if (route === "/api/cloud-send/chats") return reply(200, { conversations: 1, messages: 1, accepted: body.conversations.map((entry) => entry.threadId), waiting: [], removed: [] });
      if (route === "/api/cloud-send/chats/verify") return reply(200, { v: 1, conversations: [{ threadId: "scout-main", missing: [], unstamped: 0, path: { holds: true, at: "r1", leaf: "r1", length: 1 } }] });
      if (route.startsWith("/api/cloud-send/manifest")) return reply(200, { v: 1, items: [...there.values()], conversations: [{ threadId: "scout-main", bot: "scout", settings: {} }], attachments: [], files: [], automations: [], runs: [] });
      return reply(200, {});
    },
    upload: async () => reply(201, {}),
    close: async () => {},
  };
  let state = null;
  const send = createCloudSend({
    local,
    cloud: { origin: () => TEAM, asleep: () => false, read: async () => json({}, 404), open: async () => session },
    handoff: async (what) => { calls.push(["HANDOFF", what.kind]); throw new Error("nothing personal moves into a team"); },
    store: { read: () => state, write: (value) => { state = structuredClone(value); } },
    team: { bot: "scout", name: "Scout (Ada)", label: "Ada" },
  });
  return { send, reads, calls };
}

test("a bot moving into a team carries its own things only: no apps, keys, logins, settings or notes, every read kept to it", async () => {
  const { send, reads, calls } = sides();
  await send.send({ reason: "move" });
  const routes = calls.map(([method, route]) => `${method} ${route}`);
  for (const personal of ["/api/cloud-connections", "/api/cloud-send/memory", "/api/logins", "/api/config", "/api/cloud-send/verify-secrets"]) {
    assert.ok(!routes.some((route) => route.includes(personal)), personal);
    assert.ok(!reads.some((route) => route.includes(personal)), personal);
  }
  assert.ok(!calls.some(([kind]) => kind === "HANDOFF"), "no secret is asked for");
  for (const route of reads.filter((read) => /^\/api\/cloud-send(?:\?|\/manifest|\/files$|\/files\?|\/chats$|\/chats\?)/u.test(read))) assert.match(route, /[?&]bot=scout$/u, route);
  assert.ok(routes.includes("GET /api/cloud-send?move=1&bot=scout"), "the team's side is read kept to it too");
  const made = calls.find(([method, route]) => method === "POST" && route === "/api/bots")[2];
  assert.equal(made.threadId, undefined, "its main chat stays the team's own");
  assert.equal(made.name, "Scout (Ada)");
  const sent = calls.find(([method, route]) => method === "POST" && route === "/api/cloud-send/chats")[2];
  assert.equal(sent.owner, OWNER, "the team learns whose lines become the mover's");
  const report = await send.check();
  assert.deepEqual(report.secrets, { equal: [], differs: [], missing: [] });
  assert.ok(calls.some(([method, route]) => method === "GET" && route === "/api/cloud-send/manifest?bot=scout"));
});

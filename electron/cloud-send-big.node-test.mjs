import assert from "node:assert/strict";
import test from "node:test";

import { createCloudSend } from "./cloud-send.mjs";
import { STALL_MS } from "./cloud-send-check.mjs";
import { createOneHome } from "./one-home.mjs";

const CLOUD = "https://omb-u-1.fly.dev";
const BOTS = 100, CHATS_PER_BOT = 30, ROWS = 40, LONG = 12_000, ATTACHMENTS = 6_000, FILES_PER_BOT = 20, FILE_BYTES = 5 * 1024 ** 2;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const reply = (status, body) => ({ status, ok: status < 400, body });
const stored = (value = null) => ({ read: () => value, write(next) { value = structuredClone(next); }, get value() { return value; } });
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/**
 * A big workspace: 100 bots with 30 conversations each, 40 rows to a conversation and five of 12,000, 6,000 stored
 * attachments and 20 files of 5 MB to a bot. Both computers that move into My Cloud are this size, so My Cloud holds
 * twice its rows.
 */
function bigWorkspace() {
  const bots = Array.from({ length: BOTS }, (_, i) => `b${i}`);
  const conversations = bots.flatMap((bot, b) => Array.from({ length: CHATS_PER_BOT }, (_, c) => {
    const rows = b < 5 && c === 0 ? LONG : ROWS;
    return { threadId: `t-${bot}-${c}`, bot, rows, newest: `t-${bot}-${c}-${rows - 1}`, settings: {} };
  }));
  const manifest = {
    v: 1, appVersion: "0.1.151", memory: [], journal: [], learned: [], forgotten: [], teams: [], rooms: [], connections: [], automations: [], runs: [],
    items: bots.map((id) => ({ key: `bot:${id}`, kind: "bot", label: `Bot ${id}`, id, parts: { soul: "s" } })),
    conversations,
    attachments: Array.from({ length: ATTACHMENTS }, (_, i) => `${String(i).padStart(8, "0")}-a.png`),
    files: bots.flatMap((bot) => Array.from({ length: FILES_PER_BOT }, (_, f) => ({ path: `workspaces/${bot}/data-${f}.bin`, size: FILE_BYTES, sha256: "a".repeat(64) }))),
  };
  return { bots, conversations, manifest };
}

/**
 * My Cloud on a Fly Starter machine (2 shared CPUs, throttled) as the clock sees it: each request takes the time its work
 * takes there, and one that takes longer than its caller waits is cut off as fetch cuts it off. A stored row parsed costs
 * 0.25 ms, a byte hashed 1/20,000 ms (20 MB/s, the hash cache cold after a restart), and any request 400 ms. `down`: when
 * nothing answers at all.
 */
function slowCloud({ manifest }, { down = () => false } = {}) {
  let clock = 0;
  const asked = [], conversationsAsked = [];
  const rowsThere = manifest.conversations.reduce((sum, head) => sum + head.rows, 0) * 2;
  const rowsOf = new Map(manifest.conversations.map((head) => [head.threadId, head.rows]));
  const filesOf = (bot) => manifest.files.filter((file) => file.path.startsWith(`workspaces/${bot}/`));
  const cost = (method, route, body) => {
    if (route.startsWith("/api/cloud-send/manifest")) {
      const query = new URLSearchParams(route.split("?")[1] ?? "");
      const listsAll = query.get("attachments") !== "0", hashesAll = query.get("files") !== "0";
      return 30 * BOTS + 0.05 * manifest.conversations.length + (listsAll ? 0.25 * rowsThere : 0) + (hashesAll ? (2 * manifest.files.length * FILE_BYTES) / 20_000 : 0);
    }
    const files = /^\/api\/cloud-send\/files\?bot=([\w-]+)$/u.exec(route);
    if (files) return filesOf(files[1]).reduce((sum, file) => sum + file.size, 0) / 20_000;
    if (route === "/api/cloud-send/chats/verify") return body.conversations.reduce((sum, entry) => sum + 1 + 0.25 * (rowsOf.get(entry.threadId) ?? 0), 0);
    if (route === "/api/cloud-send/chats/attachments") return 0.05 * body.names.length;
    return 0;
  };
  const answer = (method, route, body) => {
    if (route === "/.well-known/openmausbot/environment") return reply(200, { capabilities: { cloudHome: true, move: 1 } });
    if (route.startsWith("/api/cloud-send/manifest")) {
      const query = new URLSearchParams(route.split("?")[1] ?? "");
      const { attachments: _a, files: _f, ...rest } = manifest;
      return reply(200, { ...rest, ...(query.get("attachments") === "0" ? {} : { attachments: [] }), ...(query.get("files") === "0" ? {} : { files: manifest.files }) });
    }
    const files = /^\/api\/cloud-send\/files\?bot=([\w-]+)$/u.exec(route);
    if (files) return reply(200, { v: 1, files: filesOf(files[1]), space: { freeBytes: 1e12, volumeBytes: 1e12 } });
    if (route === "/api/cloud-send/chats/verify") {
      conversationsAsked.push(...body.conversations.map((entry) => entry.threadId));
      return reply(200, { v: 1, conversations: body.conversations.map(({ threadId, path }) => ({ threadId, missing: [], unstamped: 0,
        ...(path ? { path: { holds: true, at: path.ids.at(-1) ?? path.after, ...(path.last ? { leaf: `${threadId}-${rowsOf.get(threadId) - 1}`, length: rowsOf.get(threadId) } : {}) } } : {}) })) });
    }
    if (route === "/api/cloud-send/chats/attachments") return reply(200, { missing: [] });
    if (route === "/api/cloud-send/verify-secrets") return reply(200, { v: 1, secrets: {} });
    return reply(200, {});
  };
  const session = {
    async call(method, route, body, options) {
      const limit = options?.timeoutMs ?? 120_000;
      const takes = 400 + cost(method, route, body);
      asked.push({ route, takes, limit });
      if (down(clock) || takes > limit) { clock += limit; throw timeout(); }
      clock += takes;
      return answer(method, route, body);
    },
    upload: async () => reply(201, {}),
    close: async () => {},
  };
  return { session, asked, conversationsAsked, now: () => clock, sleep: async (ms) => { clock += ms; }, advance: (ms) => { clock += ms; } };
}

/** This computer's own server: its manifest, and each conversation's row ids, 5,000 at a time. */
function thisComputer({ manifest }) {
  const rowsOf = new Map(manifest.conversations.map((head) => [head.threadId, head.rows]));
  return async (route) => {
    if (route === "/api/cloud-send/manifest") return json(manifest);
    const listed = /^\/api\/cloud-send\/chats\/ids\?thread=([\w-]+)&from=(\d+)$/u.exec(route);
    if (listed) {
      const count = rowsOf.get(listed[1]) ?? 0, from = Number(listed[2]);
      const ids = Array.from({ length: Math.max(0, Math.min(5_000, count - from)) }, (_, i) => `${listed[1]}-${from + i}`);
      return json({ v: 1, ids, path: ids, leaf: `${listed[1]}-${count - 1}`, more: from + 5_000 < count });
    }
    return json({}, 404);
  };
}

function mover(workspace, cloud, store = stored()) {
  const seen = [];
  const send = createCloudSend({
    local: thisComputer(workspace),
    cloud: { origin: () => CLOUD, asleep: () => false, read: async () => json({}), open: async () => cloud.session },
    handoff: async (what) => (what.kind === "verify-secrets" ? { secrets: {} } : {}),
    store,
    now: cloud.now,
    sleep: cloud.sleep,
    onChange: (snapshot) => { if (snapshot.checking) seen.push(snapshot.checking); },
  });
  return { send, seen, store };
}

test("on a slow Cloud, the whole manifest the check asked for in one request takes longer than any request may; the check of a big workspace now finishes", async () => {
  const workspace = bigWorkspace();
  const cloud = slowCloud(workspace);
  // What the check asked My Cloud for first: every attachment its rows name and every bot file's hash, in one answer.
  await assert.rejects(cloud.session.call("GET", "/api/cloud-send/manifest"), { name: "TimeoutError", message: "The operation was aborted due to timeout" });
  assert.ok(cloud.asked[0].takes > 5 * cloud.asked[0].limit, `the whole manifest takes ${Math.round(cloud.asked[0].takes / 60_000)} min there`);
  cloud.asked.length = 0;

  const { send, seen } = mover(workspace, cloud);
  const started = cloud.now();
  const report = await send.check();
  assert.equal(report.ok, true);
  assert.deepEqual(cloud.asked.filter((entry) => entry.takes > entry.limit), [], "no request takes longer than it may");
  const verifies = cloud.asked.filter((entry) => entry.route === "/api/cloud-send/chats/verify").length;
  assert.ok(verifies < 50, `3,000 conversations in ${verifies} requests, not one each`);
  assert.equal(cloud.asked.filter((entry) => entry.route.startsWith("/api/cloud-send/files?bot=")).length, BOTS, "My Cloud's files, a bot at a time");
  assert.ok(cloud.now() - started < 30 * 60_000, `done in ${Math.round((cloud.now() - started) / 60_000)} min`);
  const chats = seen.filter((step) => step.step === "chats");
  assert.equal(chats.at(-1).done, BOTS * CHATS_PER_BOT, "the line counts every conversation checked");
  assert.equal(chats.at(-1).bots, BOTS);
  assert.ok(chats.some((step) => step.done > 0 && step.done < step.total), "and how far it is on the way");
  assert.deepEqual([...new Set(seen.map((step) => step.step))], ["manifest", "files", "chats", "attachments", "credentials"]);
  assert.equal(send.snapshot().checking, null, "nothing is said of a check once it is over");
});

test("a Cloud that stops answering for minutes mid-check is waited for, and the line says until when", async () => {
  const workspace = bigWorkspace();
  let stalledAt = null;
  const cloud = slowCloud(workspace, { down: (clock) => stalledAt !== null && clock < stalledAt + 6 * 60_000 });
  const { send, seen } = mover(workspace, cloud);
  const call = cloud.session.call;
  let verifies = 0;
  cloud.session.call = async (method, route, body, options) => {
    if (route === "/api/cloud-send/chats/verify" && ++verifies === 5) stalledAt ??= cloud.now();
    return call(method, route, body, options);
  };
  const report = await send.check();
  assert.equal(report.ok, true);
  assert.ok(seen.some((step) => step.step === "chats" && step.until > cloud.now() - 60 * 60_000), "while it waits, the line says until when");
});

test("a check My Cloud stops answering for longer fails as unanswered, says it got somewhere, and the next check goes on from there", async () => {
  const workspace = bigWorkspace();
  let verifies = 0, stalledAt = null;
  const cloud = slowCloud(workspace, { down: (clock) => stalledAt !== null && clock < stalledAt + 2 * STALL_MS });
  const store = stored();
  const first = mover(workspace, cloud, store);
  const call = cloud.session.call;
  cloud.session.call = async (method, route, body, options) => {
    if (route === "/api/cloud-send/chats/verify" && ++verifies === 8) stalledAt ??= cloud.now();
    return call(method, route, body, options);
  };
  await assert.rejects(first.send.check(), (error) => error.progressed === true && /did not answer/u.test(error.message) && error.cause?.name === "TimeoutError");
  const checkedBefore = new Set(cloud.conversationsAsked).size;
  assert.ok(checkedBefore > 0 && checkedBefore < BOTS * CHATS_PER_BOT);

  cloud.advance(2 * STALL_MS);
  cloud.conversationsAsked.length = 0;
  const again = mover(workspace, cloud, store);
  const report = await again.send.check();
  assert.equal(report.ok, true);
  assert.ok(cloud.conversationsAsked.length <= BOTS * CHATS_PER_BOT - checkedBefore + 400,
    `the second check asked about ${cloud.conversationsAsked.length} conversations, not all ${BOTS * CHATS_PER_BOT} again`);

  // A conversation that changed here since is checked again, and only it.
  const changed = structuredClone(workspace);
  changed.manifest.conversations[0] = { ...changed.manifest.conversations[0], rows: LONG + 1, newest: `t-b0-0-${LONG}` };
  const later = slowCloud(changed);
  await mover(changed, later, store).send.check();
  assert.deepEqual([...new Set(later.conversationsAsked)], ["t-b0-0"]);
});

/** The whole workspace as this computer's server answers a move, and an empty My Cloud that keeps what it is sent, each
 * request taking the time its work takes there. Rows and files are small here: what they cost is the model's. */
function wholeMove() {
  const { bots, conversations, manifest: full } = bigWorkspace();
  const data = new TextEncoder().encode("data");
  const sha = "a".repeat(64);
  const manifest = { ...full, files: full.files.map((file) => ({ ...file, size: data.length, sha256: sha })) };
  const rowsOf = new Map(conversations.map((head) => [head.threadId, head.rows]));
  const attachmentsOf = new Map(conversations.map((head) => [head.threadId, []]));
  manifest.attachments.forEach((name, i) => attachmentsOf.get(conversations[i % conversations.length].threadId).push(name));
  const local = async (route) => {
    if (route === "/api/cloud-send?move=1" || route === "/api/cloud-send") return json({ v: 1, appVersion: "0.1.151", items: manifest.items, chats: 1 });
    if (route === "/api/cloud-send/manifest") return json(manifest);
    if (route === "/api/cloud-connections") return json({ computer: { environmentId: "env-desk", label: "Desk" }, connections: [], engines: [], commands: [] });
    if (route === "/api/bots?messages=0") return json({ bots: bots.map((id) => ({ id, threadId: `t-${id}-0`, name: `Bot ${id}`, soul: "s" })) });
    if (/^\/api\/bots\/[\w-]+\/skills$/u.test(route)) return json({ skills: [] });
    if (route.startsWith("/api/cloud-send/kind?key=")) return json({ v: 1, dataDir: "/desk", record: {} });
    if (route.startsWith("/api/cloud-send/memory?bot=")) return json({ v: 1, files: [], journal: [] });
    if (route === "/api/cloud-send/memory") return json({ v: 1, about: { learned: [], removed: [] }, teams: [] });
    if (route === "/api/cloud-send/files") return json({ v: 1, files: manifest.files });
    if (route.startsWith("/api/cloud-send/files?path=")) return new Response(data);
    if (route.startsWith("/api/cloud-send/chats/attachment/")) return new Response(data);
    if (route === "/api/cloud-send/chats?attachments=1") return json({ v: 1, attachments: manifest.attachments.map((name) => ({ name, size: data.length })) });
    if (route === "/api/cloud-send/chats") return json({ v: 1, dataDir: "/desk", rooms: [], conversations: conversations.map((head) => ({ bot: head.bot, threadId: head.threadId, last: head.rows, lastId: head.newest, busy: false, settings: {} })) });
    const rows = /^\/api\/cloud-send\/chats\/rows\?thread=([\w-]+)&after=(\d+)/u.exec(route);
    if (rows) {
      const after = Number(rows[2]), end = Math.min(rowsOf.get(rows[1]), after + 300);
      return json({ rows: Array.from({ length: end - after }, (_, i) => ({ id: `${rows[1]}-${after + i}`, at: after + i })), leaf: `${rows[1]}-${end - 1}`, task: null, last: end, lastId: `${rows[1]}-${end - 1}`,
        more: end < rowsOf.get(rows[1]), restarted: false, attachments: after === 0 ? attachmentsOf.get(rows[1]) : [] });
    }
    const ids = /^\/api\/cloud-send\/chats\/ids\?thread=([\w-]+)&from=(\d+)$/u.exec(route);
    if (ids) {
      const count = rowsOf.get(ids[1]) ?? 0, from = Number(ids[2]);
      const listed = Array.from({ length: Math.max(0, Math.min(5_000, count - from)) }, (_, i) => `${ids[1]}-${from + i}`);
      return json({ v: 1, ids: listed, path: listed, leaf: `${ids[1]}-${count - 1}`, more: from + 5_000 < count });
    }
    return json({}, 404);
  };

  let clock = 1_000_000;
  const asked = [], items = new Map(), chats = new Map(), attachments = new Set(), files = new Set();
  const summaryMs = () => 400 + 30 * BOTS;
  const cost = (method, route, body) => {
    if (route.startsWith("/api/cloud-send/manifest") || route.startsWith("/api/cloud-send?")) return summaryMs();
    if (route === "/api/cloud-send/chats" && method === "POST") return body.conversations.reduce((sum, page) => sum + 2 + 0.25 * page.rows.length, 0);
    if (route === "/api/cloud-send/chats/owner" || route === "/api/cloud-send/chats/verify") return body.conversations.reduce((sum, entry) => sum + 1 + 0.25 * (entry.ids?.length ?? 0), 0);
    if (route === "/api/cloud-send/chats/attachments") return 0.05 * body.names.length;
    return 0;
  };
  const answer = (method, route, body) => {
    if (route === "/.well-known/openmausbot/environment") return reply(200, { capabilities: { cloudHome: true, move: 1 } });
    if (route === "/api/cloud-send?move=1") return reply(200, { v: 1, appVersion: "0.1.151", items: [...items.values()], chats: 1 });
    const item = /^\/api\/cloud-send\?item=([^&]+)/u.exec(route);
    if (item) return reply(200, { v: 1, appVersion: "0.1.151", items: [...items.values()].filter((entry) => entry.key === decodeURIComponent(item[1])), chats: 1 });
    if (route === "/api/cloud-connections") return reply(200, { computer: { environmentId: "env-cloud", label: "My Cloud" }, connections: [], engines: ["claude"], commands: ["node"] });
    if (method === "POST" && route === "/api/bots") { items.set(`bot:${body.id}`, manifest.items.find((entry) => entry.id === body.id)); return reply(201, { bot: { id: body.id } }); }
    const listed = /^\/api\/cloud-send\/files\?bot=([\w-]+)$/u.exec(route);
    if (listed) return reply(200, { v: 1, files: manifest.files.filter((file) => files.has(file.path) && file.path.startsWith(`workspaces/${listed[1]}/`)), space: { freeBytes: 1e12, volumeBytes: 1e12 } });
    if (route === "/api/cloud-send/chats/attachments") return reply(200, { missing: body.names.filter((name) => !attachments.has(name)) });
    if (route === "/api/cloud-send/chats" && method === "POST") {
      for (const page of body.conversations) chats.set(page.threadId, (chats.get(page.threadId) ?? 0) + page.rows.length);
      return reply(200, { conversations: body.conversations.length, messages: 0, accepted: body.conversations.map((page) => page.threadId), waiting: [], removed: [] });
    }
    if (route === "/api/cloud-send/chats" && method === "GET") return reply(200, { v: 1, conversations: conversations.filter((head) => chats.has(head.threadId)).map((head) => ({ threadId: head.threadId, settings: {} })) });
    if (route.startsWith("/api/cloud-send/manifest")) {
      const { attachments: _a, files: _f, ...rest } = manifest;
      return reply(200, { ...rest, items: [...items.values()], conversations: conversations.filter((head) => chats.get(head.threadId) === head.rows) });
    }
    if (route === "/api/cloud-send/chats/verify") {
      return reply(200, { v: 1, conversations: body.conversations.map(({ threadId, ids = [], path }) => ({ threadId, missing: ids.filter((id) => Number(id.slice(id.lastIndexOf("-") + 1)) >= (chats.get(threadId) ?? 0)), unstamped: 0,
        ...(path ? { path: { holds: true, at: path.ids.at(-1) ?? path.after, ...(path.last ? { leaf: `${threadId}-${rowsOf.get(threadId) - 1}`, length: rowsOf.get(threadId) } : {}) } } : {}) })) });
    }
    if (route === "/api/cloud-send/verify-secrets") return reply(200, { v: 1, secrets: {} });
    return reply(200, { v: 1 });
  };
  const session = {
    async call(method, route, body, options) {
      const limit = options?.timeoutMs ?? 120_000, takes = 400 + cost(method, route, body);
      asked.push({ method, route, takes, limit });
      if (takes > limit) { clock += limit; throw timeout(); }
      clock += takes;
      return answer(method, route, body);
    },
    async upload(route) {
      clock += 400;
      asked.push({ method: "POST", route, takes: 400, limit: 120_000 });
      const file = /^\/api\/cloud-send\/files\?(.*)$/u.exec(route);
      if (file) files.add(new URLSearchParams(file[1]).get("path"));
      else attachments.add(route.slice(route.lastIndexOf("/") + 1));
      return reply(201, { stored: true });
    },
    close: async () => {},
  };
  return { local, session, asked, conversations, manifest, now: () => clock, sleep: async (ms) => { clock += ms; } };
}

test("the whole move of 100 bots and 3,000 conversations, copy to switch, finishes by itself on a slow Cloud, says how far it is, and never starts over", async () => {
  const cloud = wholeMove();
  const store = stored(), lines = [];
  let journal = null, frozen = false, freezes = 0;
  const send = createCloudSend({ local: cloud.local, cloud: { origin: () => CLOUD, asleep: () => false, read: async () => json({}), open: async () => cloud.session },
    handoff: async (what) => (what.kind === "verify-secrets" ? { secrets: {} } : {}), store, now: cloud.now, sleep: cloud.sleep, engineWaitMs: 0, onChange: () => { const seen = home?.view(); if (seen) lines.push(seen); } });
  const timers = [];
  const home = createOneHome({
    journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } },
    cloud: () => ({ origin: CLOUD, account: "acct-1", machine: CLOUD, ready: true, moves: true, ended: false, paid: false }),
    send: { move: (options) => send.send({ reason: "move", final: options?.final === true }), check: () => send.check(), switches: () => send.switches(), snapshot: () => send.snapshot() },
    local: {
      freeze: async () => { frozen = true; freezes++; return { frozen: true }; }, unfreeze: async () => { frozen = false; }, frozen: async () => frozen,
      json: async (route) => (await cloud.local(route)).json(), call: async () => reply(200),
    },
    session: async () => cloud.session,
    lastInput: () => 0, now: cloud.now,
    timers: { set: (work, ms) => { timers.push({ work, ms }); return timers.at(-1); }, clear: () => {} },
  });
  const started = cloud.now();
  await home.kick();
  assert.equal(journal.phase, "done", JSON.stringify({ phase: journal.phase, error: journal.error }));
  assert.equal(journal.failure, undefined, "no pass failed");
  assert.equal(freezes, 1, "one freeze, and nothing started over");
  assert.deepEqual(cloud.asked.filter((entry) => entry.takes > entry.limit), [], "no request took longer than it may");
  assert.ok(lines.some((line) => line.phase === "copy" && line.chats?.total === BOTS * CHATS_PER_BOT && line.chats.done > 0), "the copy counts the chats");
  assert.ok(lines.some((line) => line.phase === "finishing" && line.checking?.step === "chats" && line.checking.done > 0 && line.checking.bots === BOTS), "the check counts them too");
  const hours = (cloud.now() - started) / 3_600_000;
  assert.ok(hours < 4, `${hours.toFixed(1)} h on the slow Cloud`);
});

test("a gateway error on My Cloud's own description is waited out, never read as a Cloud too old to take a move", async () => {
  const workspace = bigWorkspace();
  const cloud = slowCloud(workspace);
  const call = cloud.session.call;
  let bad = 2;
  cloud.session.call = async (method, route, body, options) => (route === "/.well-known/openmausbot/environment" && bad-- > 0 ? reply(503, {}) : call(method, route, body, options));
  assert.equal((await mover(workspace, cloud).send.check()).ok, true);
  assert.equal(bad, -1);
});

test("a conversation whose visible path changed on either side is checked again, though its rows did not", async () => {
  const leafed = (workspace, leaf) => { const copy = structuredClone(workspace); copy.manifest.conversations = copy.manifest.conversations.map((head) => ({ ...head, leaf: head.threadId === "t-b1-1" ? leaf : head.newest })); return copy; };
  const workspace = leafed(bigWorkspace(), "first");
  const store = stored();
  await mover(workspace, slowCloud(workspace), store).send.check();
  const same = slowCloud(workspace);
  await mover(workspace, same, store).send.check();
  assert.deepEqual(same.conversationsAsked, []);
  const here = leafed(workspace, "another-branch");
  const again = slowCloud(workspace);
  await mover(here, again, store).send.check();
  assert.deepEqual([...new Set(again.conversationsAsked)], ["t-b1-1"]);
});

test("the person stopping the move ends a check that waits for My Cloud at once, not when My Cloud stands still long enough", async () => {
  const workspace = bigWorkspace();
  const cloud = slowCloud(workspace, { down: () => true });
  const started = cloud.now();
  let stop = false;
  const { send } = mover(workspace, cloud);
  await assert.rejects(send.check({ stopped: () => { if (cloud.now() - started > 150_000) stop = true; return stop; } }), { message: "The move stopped." });
  assert.ok(cloud.now() - started < 5 * 60_000, `over in ${Math.round((cloud.now() - started) / 1000)} s`);
});

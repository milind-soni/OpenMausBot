import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { BOT_PARTS, differenceSignature, itemKey, parseSendSummary, pendingRows, planSend } from "./cloud-send-parts.mjs";
import { botPatch, CloudSendError, createCloudSend, parseSendState, sendNotice, unanswered } from "./cloud-send.mjs";
import { installCloudSend, openOwnerSession } from "./cloud-send-main.mjs";

const LOCAL = "http://127.0.0.1:4100";
const CLOUD = "https://omb-u-1.fly.dev";
const summary = (items) => ({ v: 1, appVersion: "0.1.117", items });
const bot = (id, parts, extra = {}) => ({ key: itemKey.bot(id), kind: "bot", label: id, id, parts, ...extra });

test("a part goes when it changed here and not there; My Cloud's own change is kept; what was removed there stays removed", () => {
  const here = summary([
    bot("ember", { soul: "s2", title: "t2", name: "n1" }),
    bot("juno", { soul: "j1" }),
    { key: itemKey.login("example.test", "alice"), kind: "login", label: "example.test", id: "l1", parts: { saved: "a1" } },
    { key: itemKey.setting("profile"), kind: "setting", label: "profile", parts: { name: "amit", about: "-" } },
  ]);
  const there = summary([
    bot("ember", { soul: "s1", title: "t9", name: "n1" }),
    { key: itemKey.setting("profile"), kind: "setting", label: "profile", parts: { name: "-", about: "-" } },
    bot("miso", { soul: "m1" }),
  ]);
  const sent = { [itemKey.bot("ember")]: { soul: ["s1", "s1"], title: ["t1", "t1"] }, [itemKey.login("example.test", "alice")]: { saved: ["a1", "c1"] } };
  const plan = planSend({ local: here, cloud: there, sent });
  const by = Object.fromEntries(plan.rows.map((row) => [row.key, row]));
  assert.deepEqual([by["bot:ember"].state, by["bot:ember"].parts, by["bot:ember"].differs], ["to-update", ["soul"], ["title"]]);
  assert.equal(by["bot:juno"].state, "only-here");
  assert.equal(by[itemKey.login("example.test", "alice")].state, "removed");
  assert.deepEqual(plan.removed, [itemKey.login("example.test", "alice")]);
  // My Cloud has no value: this computer's fills it; an equal part is remembered as in step.
  assert.deepEqual(by["setting:profile"].parts, ["name"]);
  assert.deepEqual(plan.baseline["bot:ember"], { name: ["n1", "n1"] });
  assert.deepEqual(plan.cloudOnly.map((row) => row.key), ["bot:miso"]);
  // The person chooses this computer's: the differing part goes too.
  assert.deepEqual(planSend({ local: here, cloud: there, sent, force: ["bot:ember"] }).rows.find((row) => row.key === "bot:ember").parts, ["soul", "title"]);
  // A login both sides have, never sent from here: in step from now on (its secret can't be compared).
  const logins = planSend({ local: summary([{ key: "login:a.test|amit", kind: "login", label: "a.test", parts: { saved: "1" } }]),
    cloud: summary([{ key: "login:a.test|amit", kind: "login", label: "a.test", parts: { saved: "9" } }]) });
  assert.deepEqual([logins.rows[0].state, logins.baseline["login:a.test|amit"]], ["on-both", { saved: ["1", "9"] }]);
  // Unchanged here, changed there: nothing goes.
  const quiet = planSend({ local: summary([bot("ember", { soul: "s1" })]), cloud: summary([bot("ember", { soul: "s5" })]), sent: { "bot:ember": { soul: ["s1", "s1"] } } });
  assert.equal(quiet.rows[0].state, "on-both");
});

test("a bot's skills go with the bot, follow its switch, and a removed bot's skills read as removed", () => {
  const skill = { key: itemKey.skill("ember", "notes"), kind: "skill", label: "notes", id: "notes", bot: "ember", parts: { text: "x", on: "on" } };
  const here = summary([bot("ember", { soul: "s" }), skill]);
  const plan = planSend({ local: here, cloud: summary([]) });
  assert.deepEqual(plan.rows.map((row) => row.state), ["only-here", "only-here"]);
  assert.deepEqual(pendingRows(plan).map((row) => row.key), ["bot:ember"]);
  assert.deepEqual(planSend({ local: here, cloud: summary([]), off: { "bot:ember": "you" } }).rows.map((row) => row.state), ["off", "off"]);
  assert.deepEqual(planSend({ local: here, cloud: summary([]), off: { "bot:ember": "removed" } }).rows.map((row) => row.state), ["removed", "removed"]);
  assert.equal(differenceSignature(plan), "bot:ember#only-here#");
});

test("a server's answer is kept only in the shape main relies on", () => {
  const parsed = parseSendSummary({ v: 1, appVersion: "0.1.117", items: [
    { key: "bot:ember", kind: "bot", label: "Ember", id: "ember", parts: { soul: "abc", "../x": "y", look: 5 } },
    { key: "evil", kind: "bot", parts: {} },
    { key: "bot:x", kind: "spaceship", parts: {} },
  ] });
  assert.deepEqual(parsed.items, [{ key: "bot:ember", kind: "bot", label: "Ember", id: "ember", parts: { soul: "abc" } }]);
  assert.equal(parseSendSummary({ v: 2, items: [] }), null);
  assert.equal(parseSendSummary(null), null);
});

test("a bot's fields reach My Cloud without Custom approval and without naming bots My Cloud lacks", () => {
  const ember = { id: "ember", soul: "Be brief.", approvalMode: "custom", alwaysAllow: ["Bash(ls)"], peers: ["juno", "kit"], modelSelection: { instanceId: "claude", model: "m", extra: 1 }, cwd: "/Users/amit/work" };
  const body = botPatch(ember, ["soul", "access", "team", "model"], new Set(["juno"]));
  assert.deepEqual(body, { soul: "Be brief.", alwaysAllow: ["Bash(ls)"], peers: ["juno"], modelSelection: { instanceId: "claude", model: "m" }, requireAvailableModel: true });
  assert.ok(!Object.values(BOT_PARTS).flat().includes("cwd"), "a working folder is this computer's");
  assert.deepEqual(parseSendState({ auto: false, clouds: { "javascript:alert(1)": {}, [CLOUD]: { off: { a: "you", b: "nonsense" }, created: { "bot:x": true, "login:y": true }, creating: { "bot:z": true, "skill:q": true }, release: [{ id: "mcp:a", digest: "d" }, { id: 3 }] } } }),
    { v: 1, clouds: { [CLOUD]: { sent: {}, off: { a: "you" }, dismissed: "", last: null, whole: null, arrived: { bots: 0, updatedBots: 0, skills: 0, logins: 0, settings: 0, onePassword: false, chats: { conversations: 0, messages: 0 } },
      chats: {}, created: { "bot:x": true }, creating: { "bot:z": true }, release: [{ id: "mcp:a", digest: "d" }], files: {}, on: {} } } }, "nothing is kept of the switch that once sent by itself");
});

function fakeSides({ cloudItems = [], localItems = [], refuse = {} } = {}) {
  const calls = [];
  const reply = (status, body) => ({ status, ok: status < 400, body });
  const session = {
    call: async (method, route) => {
      calls.push(`${method} ${route}`);
      if (route === "/api/cloud-send" || route === "/api/cloud-send?move=1") return reply(200, summary(cloudItems));
      if (refuse[route]) return reply(refuse[route].status, { error: refuse[route].error });
      return reply(200, {});
    },
    upload: async (route) => { calls.push(`UPLOAD ${route}`); return reply(201, { path: "/data/attachments/abc.png" }); },
    close: async () => { calls.push("logout"); },
  };
  const localJson = (value) => new Response(JSON.stringify(value), { status: 200 });
  return {
    calls,
    deps: {
      local: async (route) => {
        if (route === "/api/cloud-send" || route === "/api/cloud-send?move=1") return localJson(summary(localItems));
        if (route === "/api/bots?messages=0") return localJson({ bots: [{ id: "ember", threadId: "t-ember", name: "Ember", soul: "Be brief." }] });
        if (route === "/api/bots/ember/skills") return localJson({ skills: [] });
        if (route === "/api/bots/ember/memory") return localJson({ topics: [] });
        if (route.startsWith("/api/bots/ember/memory/file")) return localJson({ exists: false, text: "" });
        if (route === "/api/config") return localJson({ profile: { name: "Amit" } });
        return new Response("{}", { status: 404 });
      },
      cloud: { origin: () => CLOUD, asleep: () => false, read: async () => localJson(summary(cloudItems)), open: async () => session },
      handoff: async () => ({}),
      store: { read: () => null, write() {} },
      setTimer: () => 0, clearTimer() {},
    },
  };
}

test("a send adds a bot with its own id over one session, says what My Cloud refused, and always signs out", async () => {
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" })], refuse: { "/api/bots": { status: 409, error: "this workspace is limited to 50 bots" } } });
  const send = createCloudSend(sides.deps);
  const outcome = await send.send();
  assert.deepEqual(outcome.result.failed, [{ key: "bot:ember", kind: "bot", label: "ember", error: "this workspace is limited to 50 bots" }]);
  assert.deepEqual(sides.calls, ["GET /api/cloud-send", "POST /api/bots", "GET /api/cloud-send", "logout"]);
  assert.equal(send.snapshot().last.result.failed.length, 1);

  const asleep = fakeSides({ localItems: [bot("ember", { soul: "s" })] });
  asleep.deps.cloud.asleep = () => true;
  assert.equal((await createCloudSend(asleep.deps).compare()).cloud, "asleep");
  assert.deepEqual(asleep.calls, [], "a sleeping Cloud is never asked");

  const outdated = fakeSides({ localItems: [bot("ember", { soul: "s" })] });
  outdated.deps.cloud.read = async () => new Response("", { status: 404 });
  assert.equal((await createCloudSend(outdated.deps).compare()).cloud, "outdated");
});

test("My Cloud's page is told names of bots and counts, with an opaque signature, and never a login's site", async () => {
  const sides = fakeSides({
    localItems: [bot("ember", { soul: "s" }), { key: itemKey.login("bank.example", "amit"), kind: "login", label: "bank.example", id: "l1", parts: { saved: "1" } }],
    cloudItems: [{ key: itemKey.login("crm.example", "ops"), kind: "login", label: "crm.example", detail: "ops", parts: { saved: "2" } }, { key: "1password", kind: "1password", label: "1Password", parts: { token: "x" } }],
  });
  const snapshot = await createCloudSend(sides.deps).compare();
  const notice = sendNotice(snapshot);
  assert.deepEqual({ ...notice, signature: notice.signature.length }, { ready: true, bots: ["ember"], updatedBots: [], skills: 0, logins: 1, onePassword: false, settings: 0, signature: 32, dismissed: false, running: false, last: null,
    whole: null, arrived: { bots: 0, updatedBots: 0, skills: 0, logins: 0, settings: 0, onePassword: false, chats: { conversations: 0, messages: 0 } } });
  assert.ok(!JSON.stringify(notice).includes("bank.example"));
});

test("an owner session is made only at the person's own Cloud, and nothing is sent to an origin a grant names instead", async () => {
  const fetched = [];
  const fetchImpl = async (url, init) => { fetched.push([url, init?.headers?.authorization ?? null]); return new Response(JSON.stringify({ token: "omb_sess_fake" }), { status: 200 }); };
  await assert.rejects(openOwnerSession({ origin: CLOUD, grant: async () => ({ origin: "https://attacker.example", code: "C" }) }, fetchImpl), /not ready/);
  assert.deepEqual(fetched, []);
  const session = await openOwnerSession({ origin: CLOUD, grant: async () => ({ origin: CLOUD, code: "C" }) }, fetchImpl);
  await session.call("GET", "/api/cloud-send");
  await session.close();
  assert.deepEqual(fetched.map(([url, auth]) => [url.replace(CLOUD, ""), auth]), [["/api/auth/pair", null], ["/api/cloud-send", "Bearer omb_sess_fake"], ["/api/auth/logout", "Bearer omb_sess_fake"]]);
});

test("either page asks only for the move's line, its Try again and closing it; nothing else of a send is left", async () => {
  const handlers = new Map();
  installCloudSend({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: (event) => event.page ?? null,
    server: () => null, local: async () => new Response("{}", { status: 503 }), home: () => null,
    cookieFetch: async () => new Response("", { status: 401 }), reconnect: async () => false, power: { asleep: () => false },
    file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => LOCAL,
  });
  assert.deepEqual([...handlers.keys()], ["cloud-send:notice", "cloud-send:dismiss", "cloud-send:move-retry"]);
  for (const channel of handlers.keys()) assert.throws(() => handlers.get(channel)({ page: null }), /only available/, channel);
  for (const page of ["local", "cloud"]) {
    assert.deepEqual(await handlers.get("cloud-send:notice")({ page }), { ready: false, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null,
      whole: null, arrived: { bots: 0, updatedBots: 0, skills: 0, logins: 0, settings: 0, onePassword: false, chats: { conversations: 0, messages: 0 } } }, page);
  }
});

function preload({ remote = false, activation = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? CLOUD : LOCAL }, navigator: { userActivation: { isActive: activation } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => false, invoke: (...args) => { invoked.push(args); return Promise.resolve({}); } } }),
  });
  return { bridge, invoked };
}

test("the bridge: either page gets only the move's line and the switch that keeps this computer's bots here; its Try again, moving a bot into a team, and turning that switch go only from the person's click on My Cloud's page", async () => {
  const keys = ["notice", "dismiss", "moveRetry", "teams", "moveToTeam", "teamRetry", "openTeam", "keepHere", "setKeepHere", "onNotice"];
  const local = preload();
  assert.equal(local.bridge.cloudSend, undefined);
  assert.equal(local.bridge.cloudLogins, undefined);
  assert.deepEqual(Object.keys(local.bridge.cloudSendPage), keys);
  const page = preload({ remote: true });
  assert.equal(page.bridge.cloudSend, undefined);
  assert.equal(page.bridge.cloudLogins, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(page.bridge.cloudSendPage))), keys);
  await assert.rejects(page.bridge.cloudSendPage.moveRetry(), /Try again/);
  await assert.rejects(page.bridge.cloudSendPage.moveToTeam("scout", "team-acme", "Scout"), /Choose Move/);
  await assert.rejects(page.bridge.cloudSendPage.teamRetry(), /Try again/);
  await assert.rejects(page.bridge.cloudSendPage.setKeepHere(true), /Turn the switch/);
  await page.bridge.cloudSendPage.keepHere();
  assert.deepEqual(page.invoked.filter(([channel]) => channel.startsWith("cloud-send") || channel === "one-home:keep-set"), []);
  assert.deepEqual(page.invoked, [["one-home:keep"]], "reading the switch needs no click");
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudSendPage.moveRetry();
  await clicked.bridge.cloudSendPage.dismiss({ toString: () => "one-home" });
  await clicked.bridge.cloudSendPage.moveToTeam({ toString: () => "scout" }, "team-acme", "Scout");
  await clicked.bridge.cloudSendPage.teamRetry();
  await clicked.bridge.cloudSendPage.teams();
  await clicked.bridge.cloudSendPage.openTeam("team-acme");
  await clicked.bridge.cloudSendPage.setKeepHere("yes");
  assert.deepEqual(JSON.parse(JSON.stringify(clicked.invoked.filter(([channel]) => channel.startsWith("cloud-send") || channel.startsWith("one-home")))), [["cloud-send:move-retry"], ["cloud-send:dismiss", "one-home"],
    ["cloud-send:team-move", "scout", "team-acme", "Scout"], ["cloud-send:team-retry"], ["cloud-send:teams"], ["cloud-send:team-open", "team-acme"], ["one-home:keep-set", false]]);
  await local.bridge.cloudSendPage.setKeepHere(true);
  assert.deepEqual(local.invoked, [["one-home:keep-set", true]], "this computer's own page needs no click check: main checks the sender");
});

test("replacing a skill whose text changed here puts My Cloud's copy back when the new one is refused", async () => {
  const skill = { key: itemKey.skill("ember", "notes"), kind: "skill", label: "notes", id: "notes", bot: "ember", parts: { text: "new", on: "on" } };
  const calls = [];
  const reply = (status, body) => ({ status, ok: status < 400, body });
  let installs = 0;
  const session = {
    call: async (method, route, body) => {
      calls.push(`${method} ${route}${body?.text ? ` ${body.text}` : ""}`);
      if (route === "/api/cloud-send") return reply(200, summary([bot("ember", { soul: "s" }), { ...skill, parts: { text: "old", on: "on" } }]));
      if (method === "GET" && route === "/api/bots/ember/skills") return reply(200, { skills: [{ name: "notes", description: "Notes", source: "cloud", enabled: true }] });
      if (method === "GET" && route === "/api/bots/ember/skills/notes") return reply(200, { text: "OLD" });
      if (method === "POST" && route.endsWith("/skill-template")) return ++installs === 1 ? reply(422, { error: "SKILL.md is invalid" }) : reply(201, {});
      return reply(200, {});
    },
    upload: async () => reply(201, {}), close: async () => {},
  };
  const localJson = (value) => new Response(JSON.stringify(value), { status: 200 });
  const send = createCloudSend({
    local: async (route) => route === "/api/cloud-send" ? localJson(summary([bot("ember", { soul: "s" }), skill]))
      : route === "/api/bots/ember/skills" ? localJson({ skills: [{ name: "notes", description: "Notes", source: "here", enabled: true }] })
        : localJson({ text: "NEW" }),
    cloud: { origin: () => CLOUD, asleep: () => false, read: async () => localJson(summary([])), open: async () => session },
    handoff: async () => ({}), store: { read: () => ({ clouds: { [CLOUD]: { sent: { [skill.key]: { text: ["old", "old"], on: ["on", "on"] } } } } }), write() {} },
    setTimer: () => 0, clearTimer() {},
  });
  const outcome = await send.send();
  assert.equal(outcome.result.failed[0]?.error, "My Cloud said: SKILL.md is invalid");
  assert.deepEqual(calls.filter((call) => /skill/.test(call)), [
    "GET /api/bots/ember/skills", "GET /api/bots/ember/skills/notes", "DELETE /api/bots/ember/skills/notes",
    "POST /api/bots/ember/skill-template NEW", "POST /api/bots/ember/skill-template OLD",
  ]);
});

test("a send asked while another runs waits for it, then runs as it was asked", async () => {
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" }), { key: itemKey.onePassword(), kind: "1password", label: "1Password", parts: { token: "t" } }] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const open = sides.deps.cloud.open;
  let opened = 0;
  sides.deps.cloud.open = async () => { if (opened++ === 0) await gate; return open(); };
  const send = createCloudSend(sides.deps);
  const first = send.send({ keys: ["bot:ember"] });
  const second = send.send({ keys: ["1password"], force: ["1password"] });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(opened, 2);
  assert.deepEqual([a.result.bots, b.result.bots], [["Ember"], []]);
  assert.deepEqual(b.result.failed.map((entry) => entry.key), ["1password"], "the second send carried its own keys");
});

test("a send that stops as a whole is that send's outcome, so the strip and Settings say why instead of an earlier result", async () => {
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" })] });
  const send = createCloudSend(sides.deps);
  await send.send();
  assert.equal(send.snapshot().last.result.bots.length, 1);
  sides.deps.cloud.open = async () => { throw new Error("Too many connection links. Wait a few minutes and try again."); };
  await assert.rejects(send.send({ reason: "my-cloud" }), /could not sign in|Too many connection links/);
  const last = send.snapshot().last;
  assert.equal(last.reason, "my-cloud");
  assert.equal(last.error, "Too many connection links. Wait a few minutes and try again.");
  const told = sendNotice(send.snapshot()).last;
  assert.deepEqual({ failed: told.failed, error: told.error, reason: told.reason, seen: told.seen }, { failed: 0, error: "Too many connection links. Wait a few minutes and try again.", reason: "my-cloud", seen: false });
});

test("My Cloud's notice says what did not go, by kind, with each reason: logins only counted, never a site", async () => {
  const login = (id, site) => ({ key: itemKey.login(site, "amit"), kind: "login", label: site, detail: "amit", id, parts: { saved: id } });
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" }), login("l1", "bank.example"), login("l2", "crm.example"), { key: itemKey.onePassword(), kind: "1password", label: "1Password", parts: { token: "t" } }] });
  sides.deps.handoff = async (what) => {
    if (what.kind === "login") throw new Error("OpenMausBot on this computer did not answer. Try again.");
    throw new Error("1Password did not accept this computer's token, so it was not sent to My Cloud.");
  };
  const send = createCloudSend(sides.deps);
  const outcome = await send.send();
  assert.deepEqual(outcome.result.bots, ["Ember"]);
  assert.deepEqual(outcome.result.failed.map((entry) => entry.kind), ["login", "login", "1password"]);
  const notice = sendNotice(send.snapshot());
  const none = { bots: [], skills: 0, logins: 0, onePassword: false, settings: 0, connections: 0, chats: false };
  assert.deepEqual(notice.last.reasons, [
    { what: { ...none, logins: 2 }, error: "OpenMausBot on this computer did not answer. Try again." },
    { what: { ...none, onePassword: true }, error: "1Password did not accept this computer's token, so it was not sent to My Cloud." },
  ]);
  assert.equal(notice.last.error, undefined, "the send itself did not stop");
  assert.ok(!JSON.stringify(notice).includes("bank.example") && !JSON.stringify(notice).includes("crm.example"));
});

test("1Password refused on My Cloud is told in words for this computer, not My Cloud's own paste-it-here", async () => {
  const sides = fakeSides({ localItems: [{ key: itemKey.onePassword(), kind: "1password", label: "1Password", parts: { token: "t" } }],
    refuse: { "/api/logins/1password": { status: 400, error: "1Password did not accept the token: it may have been revoked, expired, or lost access to its vault. Make a new service account token in 1Password and paste it here." } } });
  sides.deps.handoff = async () => ({ onePassword: { token: "ops_fake", grants: {} } });
  const outcome = await createCloudSend(sides.deps).send();
  assert.deepEqual(outcome.result.failed, [{ key: "1password", kind: "1password", label: "1Password",
    error: "My Cloud's 1Password did not accept this computer's token: it may have been revoked, expired, or lost access to its vault. Connect 1Password again in this computer's Settings → Logins, and it goes to My Cloud by itself.", final: true }]);
  const other = fakeSides({ localItems: [{ key: itemKey.onePassword(), kind: "1password", label: "1Password", parts: { token: "t" } }],
    refuse: { "/api/logins/1password": { status: 503, error: "busy" } } });
  other.deps.handoff = async () => ({ onePassword: { token: "ops_fake", grants: {} } });
  const busy = await createCloudSend(other.deps).send();
  assert.equal(busy.result.failed[0].final, undefined, "any other refusal can be tried again");
});

test("chats by row: the cursor moves only past what My Cloud took; one removed there is never sent again; one being answered waits", async () => {
  const rows = { "t-a": [{ id: "a1", at: 1 }, { id: "a2", at: 2 }], "t-b": [{ id: "b1", at: 1 }], "t-c": [{ id: "c1", at: 1 }] };
  const heads = () => Object.entries(rows).map(([threadId, list]) => ({ bot: "ember", threadId, last: list.length, lastId: list.at(-1).id, busy: threadId === "t-c" }));
  const posted = [];
  let removedThere = new Set();
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" })], cloudItems: [bot("ember", { soul: "s" })] });
  const call = sides.deps.cloud.open;
  sides.deps.cloud.open = async () => {
    const session = await call();
    const inner = session.call;
    session.call = async (method, route, body) => {
      if (route === "/api/cloud-send") return { status: 200, ok: true, body: { ...summary([bot("ember", { soul: "s" })]), chats: 1 } };
      if (route === "/api/cloud-send/chats") {
        posted.push(body.conversations.map((entry) => [entry.threadId, entry.rows.map((row) => row.id), entry.sent]));
        const removed = body.conversations.filter((entry) => removedThere.has(entry.threadId)).map((entry) => entry.threadId);
        return { status: 200, ok: true, body: { conversations: 0, messages: 1, accepted: body.conversations.map((entry) => entry.threadId).filter((id) => !removed.includes(id)), waiting: [], removed } };
      }
      return inner(method, route, body);
    };
    return session;
  };
  const local = sides.deps.local;
  sides.deps.local = async (route) => {
    if (route === "/api/cloud-send/chats") return new Response(JSON.stringify({ v: 1, dataDir: "/desk/.openmausbot", conversations: heads() }), { status: 200 });
    const asked = /^\/api\/cloud-send\/chats\/rows\?thread=([\w-]+)&after=(\d+)&id=/u.exec(route);
    if (asked) {
      const list = rows[asked[1]], from = Number(asked[2]);
      return new Response(JSON.stringify({ rows: list.slice(from), leaf: list.at(-1).id, task: null, last: list.length, lastId: list.at(-1).id, more: false, restarted: false, attachments: [] }), { status: 200 });
    }
    return local(route);
  };
  const send = createCloudSend(sides.deps);
  await send.send();
  assert.deepEqual(posted.at(-1), [["t-a", ["a1", "a2"], false], ["t-b", ["b1"], false]], "the conversation being answered waits");
  rows["t-a"].push({ id: "a3", at: 3 });
  rows["t-b"].push({ id: "b2", at: 2 });
  removedThere = new Set(["t-b"]);
  await send.send();
  assert.deepEqual(posted.at(-1), [["t-a", ["a3"], true], ["t-b", ["b2"], true]], "only the new rows, each marked as sent before");
  rows["t-b"].push({ id: "b3", at: 3 });
  await send.send();
  assert.deepEqual(posted.length, 2, "nothing new but in a conversation removed on My Cloud: no request at all");
});

test("1Password refusing the token on My Cloud is final: My Cloud's page is told not to offer Try again; any other failure keeps it", () => {
  const outcome = (failed, error) => ({ cloud: "ready", rows: [], last: { at: 1, reason: "auto", result: { bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: [], chats: null, notes: [], failed }, ...(error ? { error } : {}) } });
  const refused = { key: "1password", kind: "1password", label: "1Password", error: "refused", final: true };
  const other = { key: "login:a", kind: "login", label: "a.example", error: "did not answer" };
  assert.equal(sendNotice(outcome([refused])).last.final, true);
  assert.equal(sendNotice(outcome([refused, other])).last.final, false);
  assert.equal(sendNotice(outcome([])).last.final, false);
  assert.equal(sendNotice(outcome([refused], "stopped")).last.final, false, "a send that stopped as a whole can be tried again");
});


/** Bot conversations of `count` rows each, handed `page` rows at a time, and a My Cloud whose chats route answers each
 * entry with `answer(entry, post)` ("accepted", "waiting" or "removed"). */
function chatSides({ threads, page = 300, answer = () => "accepted", onPost = () => {}, onRead = () => {}, attachments = () => [], cloudSummary = null } = {}) {
  const rows = Object.fromEntries(Object.entries(threads).map(([threadId, count]) => [threadId, Array.from({ length: count }, (_, i) => ({ id: `${threadId}-${i + 1}`, at: i + 1 }))]));
  const posted = [], checked = [];
  const ember = [bot("ember", { soul: "s" })];
  const sides = fakeSides({ localItems: ember, cloudItems: ember });
  const theirs = { ...summary(ember), chats: 1, ...cloudSummary };
  sides.deps.cloud.read = async () => new Response(JSON.stringify(theirs), { status: 200 });
  const open = sides.deps.cloud.open;
  sides.deps.cloud.open = async () => {
    const session = await open();
    const inner = session.call;
    session.call = async (method, route, body) => {
      if (route === "/api/cloud-send") return { status: 200, ok: true, body: theirs };
      if (route === "/api/cloud-send/chats/attachments") { checked.push(body.names.length); return { status: body.names.length > 2000 ? 400 : 200, ok: body.names.length <= 2000, body: { missing: [] } }; }
      if (route === "/api/cloud-send/chats") {
        posted.push(body.conversations.map((entry) => ({ threadId: entry.threadId, rows: entry.rows.map((row) => row.id), sent: entry.sent })));
        const said = body.conversations.map((entry) => [entry.threadId, answer(entry, posted.length)]);
        const of = (kind) => said.filter(([, answered]) => answered === kind).map(([threadId]) => threadId);
        const reply = { status: 200, ok: true, body: { conversations: 0, messages: body.conversations.reduce((sum, entry) => sum + entry.rows.length, 0), accepted: of("accepted"), waiting: of("waiting"), removed: of("removed") } };
        onPost(posted.length);
        return reply;
      }
      return inner(method, route, body);
    };
    return session;
  };
  const local = sides.deps.local;
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  sides.deps.local = async (route) => {
    if (route === "/api/cloud-send/chats") return json({ v: 1, dataDir: "/desk/.openmausbot", conversations: Object.entries(rows).map(([threadId, list]) => ({ bot: "ember", threadId, last: list.length, lastId: list.at(-1).id, busy: false })) });
    const asked = /^\/api\/cloud-send\/chats\/rows\?thread=([\w-]+)&after=(\d+)&id=/u.exec(route);
    if (asked) {
      onRead(asked[1]);
      const list = rows[asked[1]], from = Number(asked[2]);
      const slice = list.slice(from, from + page), last = from + slice.length;
      return json({ rows: slice, leaf: slice.at(-1)?.id ?? null, task: null, last, lastId: list[last - 1]?.id ?? null, more: last < list.length, restarted: false, attachments: attachments(slice) });
    }
    return local(route);
  };
  return { sides, rows, posted, checked };
}
const stored = () => { let value = null; return { read: () => value, write: (next) => { value = structuredClone(next); }, get value() { return value; } }; };
const fortyOnePages = () => ({ ...Object.fromEntries(Array.from({ length: 39 }, (_, i) => [`t${i}`, 1])), long: 4 });

test("a conversation split over two requests: its later page says it went before, so one removed on My Cloud in between stays removed", async () => {
  const { sides, posted } = chatSides({ threads: fortyOnePages(), page: 2 });
  await createCloudSend(sides.deps).send();
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.flat().filter((entry) => entry.threadId === "long"), [
    { threadId: "long", rows: ["long-1", "long-2"], sent: false },
    { threadId: "long", rows: ["long-3", "long-4"], sent: true },
  ]);
});

test("once My Cloud does not take a page, the conversation's later pages wait too, and the next send starts it where My Cloud stopped", async () => {
  const { sides, posted } = chatSides({ threads: fortyOnePages(), page: 2, answer: (entry, post) => entry.threadId === "long" && post === 1 ? "waiting" : "accepted" });
  const send = createCloudSend({ ...sides.deps, store: stored() });
  await send.send();
  assert.deepEqual(posted.flat().filter((entry) => entry.threadId === "long").map((entry) => entry.rows), [["long-1", "long-2"]]);
  await send.send();
  assert.deepEqual(posted.slice(-1).flat().map((entry) => entry.rows), [["long-1", "long-2"], ["long-3", "long-4"]]);
});

test("a conversation this computer never sent is never kept as removed, so it goes again", async () => {
  let removed = true;
  const { sides, posted } = chatSides({ threads: { kept: 1, other: 1 }, answer: (entry) => entry.threadId === "kept" && removed ? "removed" : "accepted" });
  const store = stored();
  const send = createCloudSend({ ...sides.deps, store });
  await send.send();
  assert.equal(store.value.clouds[CLOUD].chats.kept, undefined);
  removed = false;
  await send.send();
  assert.deepEqual(posted.at(-1).map((entry) => entry.threadId), ["kept"]);
  assert.deepEqual(store.value.clouds[CLOUD].chats.kept, { after: 1, id: "kept-1" });
});

test("more attachments than My Cloud checks at once go in several checks, so the chats still go", async () => {
  const names = Array.from({ length: 2500 }, (_, i) => `${String(i).padStart(8, "0")}.png`);
  const { sides, posted, checked } = chatSides({ threads: { pics: 1 }, attachments: () => names });
  const outcome = await createCloudSend(sides.deps).send();
  assert.deepEqual(checked, [2000, 500]);
  assert.deepEqual(outcome.result.failed, []);
  assert.equal(posted.length, 1);
});

test("My Cloud's page is told the latest whole send, which a later one-login send never replaces, and all that ever arrived", async () => {
  const login = { key: itemKey.login("bank.example", "amit"), kind: "login", label: "bank.example", detail: "amit", id: "l1", parts: { saved: "1" } };
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" }), login] });
  sides.deps.handoff = async () => ({ login: { site: "bank.example", username: "amit", password: "fake-pass", bots: [] } });
  const store = stored();
  const send = createCloudSend({ ...sides.deps, store });
  await send.send({ keys: [login.key], force: [login.key], reason: "logins" });
  assert.equal(sendNotice(send.snapshot()).whole, null, "one login is not a whole send");
  await send.send({ reason: "button" });
  await send.send({ keys: [login.key], force: [login.key], reason: "logins" });
  const notice = sendNotice(send.snapshot());
  assert.deepEqual([notice.last.reason, notice.whole.reason, notice.whole.sent.bots], ["logins", "button", 1]);
  assert.deepEqual(notice.arrived, { bots: 1, updatedBots: 0, skills: 0, logins: 3, settings: 0, onePassword: false, chats: { conversations: 0, messages: 0 } });
  sides.deps.cloud.open = async () => { throw new Error("This app could not sign in to My Cloud. Try again."); };
  await assert.rejects(send.send({ reason: "my-cloud" }));
  assert.equal(sendNotice(send.snapshot()).whole.error, "This app could not sign in to My Cloud. Try again.");
  const kept = parseSendState(store.value).clouds[CLOUD];
  assert.deepEqual([kept.whole.reason, kept.arrived.logins], ["my-cloud", 3]);
  assert.deepEqual(parseSendState({ clouds: { [CLOUD]: { whole: { at: "x" }, arrived: { bots: -2, logins: 1.5, chats: "lots" } } } }).clouds[CLOUD].arrived,
    { bots: 0, updatedBots: 0, skills: 0, logins: 0, settings: 0, onePassword: false, chats: { conversations: 0, messages: 0 } });
});

test("a room's chats go with the room, whatever bots My Cloud has, and never as a bot's", async () => {
  const { sides, posted } = chatSides({ threads: { "t-a": 1 } });
  const local = sides.deps.local;
  const room = { name: "Launch", memberIds: ["ember"], bulletin: "Ship it." };
  sides.deps.local = async (route) => {
    if (route === "/api/cloud-send/chats") return new Response(JSON.stringify({ v: 1, dataDir: "/desk/.openmausbot", conversations: [
      { bot: "ember", threadId: "t-a", last: 1, lastId: "t-a-1", busy: false }, { room: "r-launch", threadId: "t-room", last: 1, lastId: "t-room-1", busy: false },
      { room: "r-busy", threadId: "t-busy", last: 1, lastId: "t-busy-1", busy: true }, { bot: "ember", room: "r-both", threadId: "t-both", last: 1, lastId: "t-both-1", busy: false },
    ] }), { status: 200 });
    if (route.startsWith("/api/cloud-send/chats/rows?thread=t-room&")) return new Response(JSON.stringify({ room: "r-launch", roomInfo: room, task: { threadId: "t-room", title: "Plan", createdAt: 1 },
      rows: [{ id: "t-room-1", at: 1 }], leaf: "t-room-1", last: 1, lastId: "t-room-1", more: false, restarted: false, attachments: [] }), { status: 200 });
    return local(route);
  };
  let bodies = [];
  const open = sides.deps.cloud.open;
  sides.deps.cloud.open = async () => {
    const session = await open();
    const call = session.call;
    session.call = async (method, route, body) => { if (route === "/api/cloud-send/chats") bodies.push(body.conversations); return call(method, route, body); };
    return session;
  };
  await createCloudSend(sides.deps).send();
  assert.deepEqual(posted.flat().map((entry) => entry.threadId), ["t-a", "t-room"]);
  const sent = bodies.flat().find((entry) => entry.threadId === "t-room");
  assert.deepEqual({ room: sent.room, roomInfo: sent.roomInfo, bot: sent.bot, task: sent.task.title }, { room: "r-launch", roomInfo: room, bot: undefined, task: "Plan" });
});

test("a room nobody wrote in yet goes once as its thread with no rows, so My Cloud makes it; one with no bot never goes", async () => {
  let answer = "waiting";
  const { sides, posted } = chatSides({ threads: { "t-a": 1 }, answer: (entry) => entry.threadId === "t-quiet" ? answer : "accepted" });
  const local = sides.deps.local;
  const room = { name: "Quiet", memberIds: ["ember"], bulletin: "" };
  const asked = [];
  sides.deps.local = async (route) => {
    if (route === "/api/cloud-send/chats") return new Response(JSON.stringify({ v: 1, dataDir: "/desk/.openmausbot", conversations: [{ bot: "ember", threadId: "t-a", last: 1, lastId: "t-a-1", busy: false }],
      rooms: [{ room: "r-quiet", threadId: "t-quiet", members: ["ember"] }, { room: "r-lonely", threadId: "t-lonely", members: [] }] }), { status: 200 });
    if (route.startsWith("/api/cloud-send/chats/rows?thread=t-quiet&")) {
      asked.push(route);
      return new Response(JSON.stringify({ room: "r-quiet", roomInfo: room, task: { threadId: "t-quiet", title: "Untitled", createdAt: 1 }, rows: [], leaf: null, last: 0, lastId: null,
        more: false, restarted: false, attachments: [] }), { status: 200 });
    }
    return local(route);
  };
  const store = stored();
  const send = createCloudSend({ ...sides.deps, store });
  await send.send();
  assert.deepEqual(posted.flat().filter((entry) => entry.threadId !== "t-a"), [{ threadId: "t-quiet", rows: [], sent: false }], "the room with a bot goes; the other never does");
  assert.equal(store.value.clouds[CLOUD].chats["t-quiet"], undefined, "My Cloud did not make it yet: it goes again");
  answer = "accepted";
  await send.send();
  assert.deepEqual(posted.at(-1), [{ threadId: "t-quiet", rows: [], sent: false }]);
  assert.deepEqual(store.value.clouds[CLOUD].chats["t-quiet"], { after: 0, id: "" });
  const before = posted.length;
  await send.send();
  assert.equal(posted.length, before, "made there once: never sent again");
  assert.equal(asked.length, 2);
});

test("nothing answering on the way to My Cloud is told from a refusal", () => {
  assert.equal(unanswered(new TypeError("fetch failed")), true);
  assert.equal(unanswered(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), true);
  assert.equal(unanswered(Object.assign(new Error("Cloud request failed."), { status: 502 })), true);
  assert.equal(unanswered(new CloudSendError("session", "Cloud request failed.", { cause: new Error("x", { cause: Object.assign(new Error("y"), { status: 503 }) }) })), true);
  assert.equal(unanswered(Object.assign(new Error("This app could not sign in to My Cloud. Try again."), { status: 401 })), false);
  assert.equal(unanswered(Object.assign(new Error("Too many connection links."), { status: 429 })), false);
  assert.equal(unanswered(new TypeError("session.call is not a function")), false);
  assert.equal(unanswered(new Error("My Cloud is not ready.")), false);
});

test("an owner session that could not open says whether nothing answered or My Cloud refused", async () => {
  const opening = (grant, status) => openOwnerSession({ origin: CLOUD, grant }, async () => new Response(JSON.stringify({ error: "no" }), { status })).catch((error) => error);
  assert.equal(unanswered(await opening(async () => { throw Object.assign(new Error("Cloud request failed."), { status: 503 }); }, 200)), true);
  assert.equal(unanswered(await opening(async () => ({ origin: CLOUD, code: "C" }), 504)), true);
  assert.equal(unanswered(await opening(async () => ({ origin: CLOUD, code: "C" }), 401)), false);
  assert.equal(unanswered(await opening(async () => { throw Object.assign(new Error("Cloud request failed."), { status: 429 }); }, 200)), false);
});


test("closing the move's done line closes the move's own send result with it, so My Cloud's page says it once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-move-line-"));
  const file = join(dir, "cloud-send.json");
  const result = { bots: ["Ember"], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: [], chats: null, failed: [], notes: [] };
  writeFileSync(file, JSON.stringify({ v: 1, clouds: { [CLOUD]: { sent: {}, off: {}, dismissed: "", last: { at: 7, reason: "move", result }, whole: null, chats: {}, created: {}, release: [], files: {}, on: {} } } }));
  const handlers = new Map();
  let seen = 0;
  let line = { phase: "done", phone: false, held: [] };
  installCloudSend({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: () => "cloud",
    server: () => null, local: async () => new Response("{}", { status: 503 }),
    home: () => ({ origin: CLOUD, grant: async () => ({ origin: CLOUD, code: "C" }) }),
    cookieFetch: async () => new Response("", { status: 503 }), reconnect: async () => false, power: { asleep: () => false },
    file: () => file, window: () => null, localOrigin: () => LOCAL,
    move: () => ({ view: () => line, seen: () => { seen++; line = null; }, retry: async () => {} }),
  });
  try {
    const before = await handlers.get("cloud-send:dismiss")({}, "elsewhere");
    assert.equal(before.move.phase, "done");
    assert.equal(before.last.seen, false);
    const after = await handlers.get("cloud-send:dismiss")({}, "one-home");
    assert.equal(seen, 1);
    assert.equal(after.move, undefined);
    assert.equal(after.last.seen, true, "the move's own result is not said again after the done line");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

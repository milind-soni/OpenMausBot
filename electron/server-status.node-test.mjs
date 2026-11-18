import assert from "node:assert/strict";
import test from "node:test";

import { checkServer, createServerStatus, installServerStatus, reconnectDelay, RECONNECT, versionBehind } from "./server-status.mjs";

test("reconnect waits grow with jitter from about 2 s to a 5 minute cap", () => {
  assert.equal(reconnectDelay(0, () => 0), 1_000);
  assert.equal(reconnectDelay(0, () => 1), 2_000);
  assert.equal(reconnectDelay(3, () => 1), 16_000);
  assert.equal(reconnectDelay(3, () => 0), 8_000);
  for (const attempt of [8, 9, 20, 200]) {
    assert.equal(reconnectDelay(attempt, () => 1), RECONNECT.capMs, String(attempt));
    assert.equal(reconnectDelay(attempt, () => 0), RECONNECT.capMs / 2, String(attempt));
  }
});

test("the version banner is only for a server behind this app", () => {
  assert.equal(versionBehind("0.1.140", "0.1.147"), true);
  assert.equal(versionBehind("0.1.147", "0.1.147"), false);
  assert.equal(versionBehind("0.1.150", "0.1.147"), false);
  assert.equal(versionBehind("0.2.0", "0.1.147"), false);
  assert.equal(versionBehind("0.1.9", "0.1.10"), true);
  assert.equal(versionBehind("unknown", "0.1.147"), false);
  assert.equal(versionBehind(null, "0.1.147"), false);
  assert.equal(versionBehind("0.1.140-beta.1", "0.1.147"), true);
});

const descriptor = (extra = {}) => new Response(JSON.stringify({ environmentId: "env", label: "hetzner-1", version: "0.1.140", capabilities: { install: "docker", ...extra } }));
const fetchFrom = (routes) => async (url) => {
  const route = routes[new URL(url).pathname];
  if (!route) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  return route();
};

test("a check sorts a server into connected, a passing problem, or one that needs the person", async () => {
  const ok = await checkServer("https://maus.example.com", fetchFrom({ "/.well-known/openmausbot/environment": () => descriptor(), "/api/auth/session": () => new Response("{}") }));
  assert.deepEqual(ok, { kind: "ok", version: "0.1.140", install: "docker" });
  assert.deepEqual(await checkServer("https://maus.example.com", fetchFrom({})), { kind: "transient" });
  assert.deepEqual(await checkServer("https://maus.example.com", fetchFrom({ "/.well-known/openmausbot/environment": () => new Response("", { status: 502 }) })), { kind: "transient" });
  assert.deepEqual(await checkServer("https://maus.example.com", fetchFrom({ "/.well-known/openmausbot/environment": () => descriptor(), "/api/auth/session": () => new Response("", { status: 401 }) })),
    { kind: "blocked", reason: "signedOut" });
  let asked = 0;
  assert.deepEqual(await checkServer("http://203.0.113.9:8799", async () => { asked++; return descriptor(); }), { kind: "blocked", reason: "insecure" });
  assert.equal(asked, 0, "nothing is sent to a public http address");
  assert.equal((await checkServer("http://192.168.1.20:8799", fetchFrom({ "/.well-known/openmausbot/environment": () => descriptor(), "/api/auth/session": () => new Response("{}") }))).kind, "ok");
});

function clock() {
  let time = 0;
  const timers = new Set();
  return {
    now: () => time,
    setTimeout: (fn, ms) => { const timer = { at: time + ms, fn }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    pending: () => [...timers].map((timer) => timer.at - time).sort((a, b) => a - b),
    async advance(ms) {
      const until = time + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        time = next.at;
        await next.fn();
        await new Promise((done) => setImmediate(done));
      }
      time = until;
    },
  };
}

function harness(results, entries = [{ id: "vps", origin: "https://maus.example.com" }]) {
  const c = clock();
  const checks = [];
  let changes = 0;
  const status = createServerStatus({ entries: () => entries, appVersion: "0.1.147", random: () => 1, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    onChange: () => { changes++; }, check: async (origin) => { checks.push(origin); return results.length > 1 ? results.shift() : results[0]; } });
  return { c, checks, status, changes: () => changes };
}
const settle = () => new Promise((done) => setImmediate(done));

test("a passing problem retries on a growing, capped schedule and says Can't reach after two minutes", async () => {
  const h = harness([{ kind: "transient" }]);
  h.status.sync();
  await settle();
  assert.equal(h.status.list()[0].state, "reconnecting");
  const waits = [];
  for (let i = 0; i < 12; i++) {
    waits.push(h.c.pending()[0]);
    await h.c.advance(h.c.pending()[0]);
  }
  assert.deepEqual(waits.slice(0, 5), [2_000, 4_000, 8_000, 16_000, 32_000]);
  assert.ok(waits.every((wait) => wait <= RECONNECT.capMs), "never more than five minutes apart");
  assert.equal(waits.at(-1), RECONNECT.capMs);
  const row = h.status.list()[0];
  assert.equal(row.state, "cantReach");
  assert.equal(row.since, 0);
});

test("a blocked problem never retries by itself; Try now or Pair again checks once", async () => {
  const h = harness([{ kind: "blocked", reason: "signedOut" }]);
  h.status.sync();
  await settle();
  assert.equal(h.status.list()[0].state, "signedOut");
  assert.deepEqual(h.c.pending(), []);
  await h.c.advance(60 * 60_000);
  assert.equal(h.checks.length, 1);
  h.status.retry();
  await settle();
  assert.equal(h.checks.length, 1, "a network change or focus leaves a blocked server alone");
  h.status.retry("vps");
  await settle();
  assert.equal(h.checks.length, 2, "the person's own Try now checks it");
});

test("a reachable server is checked again each minute, and a network change or focus retries a failing one at once", async () => {
  const h = harness([{ kind: "ok", version: "0.1.140", install: "npx" }]);
  h.status.sync();
  await settle();
  assert.deepEqual(h.status.list(), [{ id: "vps", state: "connected", since: 0, version: "0.1.140", behind: true, install: "npx" }]);
  assert.deepEqual(h.c.pending(), [RECONNECT.healthyMs]);
  const failing = harness([{ kind: "transient" }]);
  failing.status.sync();
  await settle();
  await failing.c.advance(2_000);
  assert.equal(failing.checks.length, 2);
  failing.status.retry();
  await settle();
  assert.equal(failing.checks.length, 3, "retried without waiting for the next slot");
  assert.equal(failing.c.pending().length, 1, "one timer per server, never two");
});

test("servers removed from the list stop being checked; new ones start", async () => {
  const entries = [{ id: "a", origin: "https://a.example.com" }];
  const h = harness([{ kind: "transient" }], entries);
  h.status.sync();
  await settle();
  entries.splice(0, 1, { id: "b", origin: "https://b.example.com" });
  h.status.sync();
  await settle();
  assert.deepEqual(h.status.list().map((row) => row.id), ["b"]);
  assert.equal(h.c.pending().length, 1);
  h.status.stop();
  assert.equal(h.c.pending().length, 0);
});

test("the network coming back, the app in front and a wake each retry; the page's channels sync first", async () => {
  const handlers = new Map(), events = new Map(), calls = [];
  let tick = null, online = false;
  const status = { sync: () => calls.push("sync"), retry: (id) => calls.push(["retry", id]), list: () => [] };
  const on = (name, fn) => events.set(name, fn);
  installServerStatus({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, guard: (_channel, fn) => fn, status, app: { on }, powerMonitor: { on }, online: () => online, setInterval: (fn) => { tick = fn; return {}; } });
  assert.deepEqual(await handlers.get("environments:status")(), []);
  handlers.get("environments:retry")({}, "vps");
  handlers.get("environments:retry")({}, { id: "x" });
  events.get("browser-window-focus")();
  events.get("resume")();
  tick();
  online = true;
  tick();
  tick();
  assert.deepEqual(calls, ["sync", "sync", ["retry", "vps"], "sync", ["retry", undefined], ["retry", undefined], ["retry", undefined], ["retry", undefined]]);
});

import assert from "node:assert/strict";
import test from "node:test";

import { appPlan, createUpdateAll, serverPlan, surveyServer, UPDATE_ALL } from "./update-all-run.mjs";

const COMMAND = "cd /opt/mausbot && sudo ./update.sh";

/** A saved server's update routes. Each read of GET /api/updates/server first applies the next of `steps` (the host's
 * runner moving on), so a test lays out what the server goes through, poll by poll. */
function fakeServer(clock, { current = "0.1.170", latest = "0.1.175", mode = "button", admin = true, steps = [], post = null, retryAt } = {}) {
  const server = { current, latest, mode, admin, run: undefined, down: false, steps: [...steps], calls: [], retryAt };
  server.status = () => ({
    mode: server.mode, current: server.current, latest: server.latest, available: server.current !== server.latest, activeTurns: 0,
    command: COMMAND, ...(server.run ? { run: server.run } : {}), ...(server.retryAt ? { retryAt: server.retryAt } : {}),
  });
  server.handle = async (path, init) => {
    const method = init.method ?? "GET";
    server.calls.push({ method, path, origin: init.headers?.origin, credentials: init.credentials });
    if (path === "/api/updates/server" && method === "GET") server.steps.shift()?.(server);
    if (server.down) throw new TypeError("fetch failed");
    if (path === "/.well-known/openmausbot/environment") return Response.json({ environmentId: "env-1", version: server.current });
    if (path.startsWith("/api/updates/check")) return Response.json({ current: server.current, latest: server.latest, available: server.current !== server.latest, install: "docker", command: "docker compose pull" });
    if (path === "/api/updates/server") {
      if (!server.admin) return Response.json({ error: "Only an admin of this server, signed in, can update it.", code: "admin_only" }, { status: 403 });
      if (method === "POST") {
        if (post) return post(server);
        server.run = { outcome: "requested", from: server.current, at: clock.now };
        return Response.json({ status: server.status() }, { status: 202 });
      }
      return Response.json(server.status());
    }
    return Response.json({ error: "no route" }, { status: 404 });
  };
  return server;
}

function world(servers) {
  const clock = { now: 1_000_000 };
  const made = Object.fromEntries(Object.entries(servers).map(([host, options]) => [host, fakeServer(clock, options)]));
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const server = made[parsed.host];
    if (!server) throw new TypeError("fetch failed");
    return server.handle(parsed.pathname + parsed.search, init);
  };
  return { clock, servers: made, fetch: fetchImpl };
}

/** The host's runner: takes the request, then the server goes down while its new version starts, then answers again. */
const running = (server) => { server.run = { ...server.run, outcome: "running" }; };
const down = (server) => { server.down = true; };
const backOn = (version, outcome = "updated") => (server) => {
  server.down = false;
  server.current = version;
  server.run = { ...server.run, outcome, to: version };
};

function fakeApp(initial = { status: "downloaded", version: "0.1.182", installMode: "restart" }) {
  let state = initial;
  const listeners = new Set();
  const app = {
    events: [],
    state: () => state,
    set(next) { state = { ...state, ...next }; for (const listener of listeners) listener(state); },
    check: async () => { app.events.push("check"); },
    install: () => { app.events.push("install"); app.set({ status: "installing" }); },
    onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return app;
}

function runner(w, app = null, extra = {}) {
  const views = [];
  const run = createUpdateAll({ fetch: w.fetch, app, now: () => w.clock.now, sleep: async (ms) => { w.clock.now += ms; }, onChange: (view) => views.push(view), ...extra });
  const until = (done) => new Promise((resolve) => {
    const look = () => (done(run.view()) ? resolve(run.view()) : setTimeout(look, 1));
    look();
  });
  const finished = () => until((view) => !view.running);
  /** This app's install quits the process; in a test the run stays open there, so the test waits for this app's row. */
  const restarted = () => until((view) => view.rows.app?.phase === "restarting" && Object.values(view.rows).every((row) => row === view.rows.app || row.phase === "done" || row.phase === "failed"));
  return { run, views, finished, restarted };
}

const survey = async (w, host, options) => serverPlan(await surveyServer(`https://${host}`, w.fetch, options), w.clock.now);

test("a server updates when its own answer says so, to its own stable latest, whatever this app's version", async () => {
  // This app is on 0.1.182; the server's stable channel is at 0.1.175. The target is the server's latest, never the app's.
  const w = world({ "vps.example.com": { current: "0.1.170", latest: "0.1.175" } });
  assert.deepEqual(await survey(w, "vps.example.com"), { updates: true, current: "0.1.170", latest: "0.1.175", activeTurns: 0 });
});

test("a server older than this app but current on its own channel is up to date, not updated", async () => {
  const w = world({ "vps.example.com": { current: "0.1.175", latest: "0.1.175" } });
  assert.deepEqual(await survey(w, "vps.example.com"), { updates: false, why: "up-to-date", current: "0.1.175" });
});

test("each skipped server says why, from the server's own answer", async () => {
  const w = world({
    "member.example.com": { admin: false },
    "held.example.com": { mode: "held" },
    "npm.example.com": { mode: "command" },
    "desk.example.com": { mode: "none" },
    "busy.example.com": { steps: [] },
    "soon.example.com": { retryAt: 2_000_000 },
  });
  w.servers["busy.example.com"].run = { outcome: "running", from: "0.1.170", at: 1 };
  assert.deepEqual(await survey(w, "member.example.com"), { updates: false, why: "admin-only", current: "0.1.170", latest: "0.1.175" });
  assert.deepEqual(await survey(w, "held.example.com"), { updates: false, why: "held", current: "0.1.170", latest: "0.1.175" });
  assert.deepEqual(await survey(w, "npm.example.com"), { updates: false, why: "by-hand", current: "0.1.170", latest: "0.1.175", command: COMMAND });
  assert.equal((await survey(w, "desk.example.com")).why, "by-hand");
  assert.equal((await survey(w, "busy.example.com")).why, "updating");
  assert.equal((await survey(w, "soon.example.com")).why, "too-soon");
  assert.deepEqual(await survey(w, "gone.example.com"), { updates: false, why: "unreachable" });
});

test("a server without the button answers 404 there and is updated by hand with its check's command", async () => {
  const w = world({ "old.example.com": {} });
  const handle = w.servers["old.example.com"].handle;
  w.servers["old.example.com"].handle = async (path, init) => (path === "/api/updates/server" ? Response.json({ error: "no route" }, { status: 404 }) : handle(path, init));
  assert.deepEqual(await survey(w, "old.example.com"), { updates: false, why: "by-hand", current: "0.1.170", latest: "0.1.175", command: "docker compose pull" });
});

test("a server whose sign-in is gone, or a public http address, is skipped; the http one is never contacted", async () => {
  const w = world({ "out.example.com": {} });
  const handle = w.servers["out.example.com"].handle;
  w.servers["out.example.com"].handle = async (path, init) => (path.startsWith("/api/") ? Response.json({ error: "unauthorized" }, { status: 401 }) : handle(path, init));
  assert.deepEqual(await survey(w, "out.example.com"), { updates: false, why: "signed-out" });
  let asked = 0;
  const plan = serverPlan(await surveyServer("http://203.0.113.7:8799", async () => { asked++; throw new Error("sent"); }));
  assert.deepEqual(plan, { updates: false, why: "unreachable" });
  assert.equal(asked, 0);
});

test("the look before Update all asks for a fresh check only when told, with the stored sign-in and its own origin", async () => {
  const w = world({ "vps.example.com": {} });
  await survey(w, "vps.example.com");
  await survey(w, "vps.example.com", { fresh: true });
  const calls = w.servers["vps.example.com"].calls;
  assert.deepEqual(calls.map((call) => call.path), ["/api/updates/check", "/api/updates/server", "/api/updates/check?fresh=1", "/api/updates/server"]);
  assert.ok(calls.every((call) => call.origin === "https://vps.example.com" && call.credentials === "include"));
});

test("this app takes part only with an update downloading or downloaded", () => {
  assert.deepEqual(appPlan({ status: "downloaded", version: "0.1.182", installMode: "restart" }), { version: "0.1.182", handoff: false });
  assert.deepEqual(appPlan({ status: "downloading", installMode: "handoff" }), { version: null, handoff: true });
  assert.equal(appPlan({ status: "idle" }), null);
  assert.equal(appPlan({ status: "error", version: "0.1.182" }), null);
  assert.equal(appPlan(null), null);
});

test("a server is done only once its descriptor reads back the latest it named, after restarting", async () => {
  const w = world({ "vps.example.com": { steps: [running, down, down, backOn("0.1.175")] } });
  const { run, views, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.vps.phase, "done");
  assert.equal(end.rows.vps.version, "0.1.175");
  assert.deepEqual([...new Set(views.map((view) => view.rows.vps?.phase))], ["updating", "restarting", "done"]);
  const calls = w.servers["vps.example.com"].calls;
  assert.deepEqual(calls.at(-1), { method: "GET", path: "/.well-known/openmausbot/environment", origin: "https://vps.example.com", credentials: "omit" });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("a read-back that gets no answer is asked again, never taken for another version", async () => {
  let misses = 1;
  const w = world({ "vps.example.com": { steps: [running, down, backOn("0.1.175")] } });
  const handle = w.servers["vps.example.com"].handle;
  w.servers["vps.example.com"].handle = async (path, init) => {
    if (path === "/.well-known/openmausbot/environment" && !w.servers["vps.example.com"].down && misses-- > 0) throw new TypeError("fetch failed");
    return handle(path, init);
  };
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.vps.phase, "done");
  assert.equal(misses, -1);
});

test("the new version answering while the host's run is still going is not done: a rollback after it fails the row", async () => {
  const w = world({ "vps.example.com": { steps: [running, (server) => { server.current = "0.1.175"; }, (server) => {
    server.current = "0.1.170";
    server.run = { ...server.run, outcome: "rolled-back" };
  }] } });
  const { run, views, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.vps.failure.why, "run");
  assert.ok(views.every((view) => view.rows.vps?.phase !== "done"));
});

test("a server that answers while its run is going is followed for as long as it says so, without the unreachable cut-off", async () => {
  const steps = Array.from({ length: 2000 }, () => running);
  const w = world({ "vps.example.com": { steps: [...steps, down, backOn("0.1.175")] } });
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.vps.phase, "done");
  assert.ok(w.clock.now - 1_000_000 > UPDATE_ALL.giveUpMs);
});

test("an update the host calls done is not done while the server still reports the old version", async () => {
  const w = world({ "vps.example.com": { steps: [running, (server) => { server.run = { ...server.run, outcome: "unchanged", to: server.current }; }] } });
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.vps.phase, "failed");
  assert.equal(end.rows.vps.failure.why, "mismatch");
  assert.equal(end.rows.vps.failure.version, "0.1.170");
});

test("a server that lands on another version than the latest it named ends as a mismatch, not a wait", async () => {
  const w = world({ "vps.example.com": { steps: [running, down, backOn("0.1.176")] } });
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.deepEqual({ phase: end.rows.vps.phase, why: end.rows.vps.failure.why, version: end.rows.vps.failure.version }, { phase: "failed", why: "mismatch", version: "0.1.176" });
});

test("the server's own outcomes end a run: rolled back, not started, not changed", async () => {
  const outcome = (name, reason) => (server) => { server.run = { ...server.run, outcome: name, ...(reason ? { reason } : {}) }; };
  const w = world({
    "a.example.com": { steps: [running, outcome("rolled-back")] },
    "b.example.com": { steps: [outcome("not-started")] },
    "c.example.com": { steps: [running, outcome("not-changed", "no-room")] },
  });
  const { run, finished } = runner(w);
  run.start({ servers: ["a", "b", "c"].map((id) => ({ id, origin: `https://${id}.example.com`, latest: "0.1.175" })), withApp: false });
  const end = await finished();
  for (const id of ["a", "b", "c"]) assert.equal(end.rows[id].failure.why, "run", id);
  assert.equal(end.rows.a.failure.status.run.outcome, "rolled-back");
  assert.equal(end.rows.b.failure.status.run.outcome, "not-started");
  assert.equal(end.rows.c.failure.status.run.reason, "no-room");
});

test("each refusal of the request is its own failure; an update already running is followed", async () => {
  const refuse = (status, code) => () => Response.json({ error: "no", code, status: { mode: "button", current: "0.1.170", available: true, activeTurns: 0, command: COMMAND } }, { status });
  const w = world({
    "soon.example.com": { post: refuse(429, "too-soon") },
    "member.example.com": { post: refuse(403, "admin_only") },
    "full.example.com": { post: refuse(500, "unwritable") },
    "hand.example.com": { post: refuse(409, "unavailable") },
    "going.example.com": { post: (server) => { server.run = { outcome: "running", from: "0.1.170", at: 5 }; return Response.json({ code: "running", status: server.status() }, { status: 409 }); }, steps: [down, backOn("0.1.175")] },
  });
  const { run, finished } = runner(w);
  run.start({ servers: ["soon", "member", "full", "hand", "going"].map((id) => ({ id, origin: `https://${id}.example.com`, latest: "0.1.175" })), withApp: false });
  const end = await finished();
  assert.equal(end.rows.soon.failure.why, "too-soon");
  assert.equal(end.rows.member.failure.why, "admin-only");
  assert.equal(end.rows.full.failure.why, "failed");
  assert.deepEqual(end.rows.hand.failure, { why: "by-hand", command: COMMAND });
  assert.equal(end.rows.going.phase, "done");
});

test("one server failing never stops another, and this app installs last, once the other handed off", async () => {
  const w = world({
    "bad.example.com": { post: () => Response.json({ code: "unwritable" }, { status: 500 }) },
    "good.example.com": { steps: [(server) => server, running, down, backOn("0.1.175")] },
  });
  const app = fakeApp();
  const seen = [];
  app.install = () => { seen.push(w.servers["good.example.com"].run.outcome); app.set({ status: "installing" }); };
  const { run, views, restarted } = runner(w, app);
  run.start({ servers: [{ id: "bad", origin: "https://bad.example.com", latest: "0.1.175" }, { id: "good", origin: "https://good.example.com", latest: "0.1.175" }], withApp: true });
  const end = await restarted();
  assert.equal(end.rows.bad.phase, "failed");
  assert.equal(end.rows.good.phase, "done");
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], "requested");
  assert.equal(end.rows.app.phase, "restarting");
  assert.equal(views.find((view) => view.rows.app)?.rows.app.phase, "waiting");
});

test("a server the host never takes the request from holds this app until the server says it never started", async () => {
  const w = world({ "slow.example.com": { steps: [(server) => server, (server) => server, (server) => { server.run = { ...server.run, outcome: "not-started" }; }] } });
  const app = fakeApp();
  const seen = [];
  app.install = () => { seen.push(w.servers["slow.example.com"].run.outcome); app.set({ status: "installing" }); };
  const { run, restarted } = runner(w, app);
  run.start({ servers: [{ id: "slow", origin: "https://slow.example.com", latest: "0.1.175" }], withApp: true });
  const end = await restarted();
  assert.deepEqual(seen, ["not-started"]);
  assert.equal(end.rows.slow.failure.why, "run");
  assert.equal(end.rows.app.phase, "restarting");
});

test("when this app's download fails only this app is skipped", async () => {
  const w = world({ "vps.example.com": { steps: [running, down, backOn("0.1.175")] } });
  const app = fakeApp({ status: "downloading", percent: 40 });
  const { run, finished } = runner(w, app);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  app.set({ status: "error", message: "network" });
  const end = await finished();
  assert.equal(end.rows.vps.phase, "done");
  assert.equal(end.rows.app.failure.why, "download");
  assert.deepEqual(app.events, []);
});

test("this app's update handed to a terminal ends handed off", async () => {
  const w = world({});
  const app = fakeApp({ status: "downloaded", version: "0.1.182", installMode: "handoff" });
  app.install = () => { app.events.push("install"); app.set({ status: "installing" }); app.set({ status: "handed-off" }); };
  const { run, finished } = runner(w, app);
  run.start({ servers: [], withApp: true });
  const end = await finished();
  assert.equal(end.rows.app.phase, "handed-off");
});

test("an install that did not take (the updater stayed on downloaded) fails this app's row", async () => {
  const w = world({});
  const app = fakeApp();
  app.install = () => { app.events.push("install"); };
  const { run, finished } = runner(w, app);
  run.start({ servers: [], withApp: true });
  const end = await finished();
  assert.equal(end.rows.app.failure.why, "install");
});

test("a server that never comes back fails after the server's own cut-off, not before", async () => {
  const w = world({ "vps.example.com": { steps: [running, down] } });
  const { run, views, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.vps.failure.why, "not-back");
  const wentDown = views.find((view) => view.rows.vps?.phase === "restarting").rows.vps.since;
  assert.ok(w.clock.now - wentDown >= UPDATE_ALL.giveUpMs);
  assert.ok(w.clock.now - wentDown < UPDATE_ALL.giveUpMs + UPDATE_ALL.pollMs);
});

test("a request with no answer is followed, but an old run it never replaced is not taken for this one", async () => {
  const w = world({
    "lost.example.com": { post: (server) => { server.down = false; throw new TypeError("fetch failed"); } },
  });
  w.servers["lost.example.com"].run = { outcome: "rolled-back", from: "0.1.160", at: 1 };
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "lost", origin: "https://lost.example.com", latest: "0.1.175" }], withApp: false });
  const end = await finished();
  assert.equal(end.rows.lost.failure.why, "failed");
});

test("Retry runs one failed server again from a fresh look, or records why it no longer updates", async () => {
  let refuse = true;
  const w = world({ "vps.example.com": { post: (server) => {
    if (refuse) return Response.json({ code: "too-soon" }, { status: 429 });
    server.run = { outcome: "requested", from: server.current, at: 7 };
    return Response.json({ status: server.status() }, { status: 202 });
  }, steps: [] } });
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  assert.equal((await finished()).rows.vps.failure.why, "too-soon");
  refuse = false;
  w.servers["vps.example.com"].steps.push(running, down, backOn("0.1.175"));
  run.retry("vps", { origin: "https://vps.example.com", latest: "0.1.175" });
  assert.equal((await finished()).rows.vps.phase, "done");
  run.retry("vps", { failure: { why: "held" } });
  assert.equal(run.view().rows.vps.phase, "done");
});

test("Retry on a server that now says it is up to date settles it by reading its version back", async () => {
  const w = world({ "vps.example.com": { post: () => Response.json({ code: "too-soon" }, { status: 429 }) } });
  const { run, finished } = runner(w);
  run.start({ servers: [{ id: "vps", origin: "https://vps.example.com", latest: "0.1.175" }], withApp: false });
  assert.equal((await finished()).rows.vps.failure.why, "too-soon");
  w.servers["vps.example.com"].current = "0.1.175";
  run.retry("vps", { origin: "https://vps.example.com", current: true });
  const end = await finished();
  assert.deepEqual({ phase: end.rows.vps.phase, version: end.rows.vps.version }, { phase: "done", version: "0.1.175" });
});

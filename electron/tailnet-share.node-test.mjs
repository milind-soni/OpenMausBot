import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createTailnetShare, servePortTaken } from "./tailnet-share.mjs";

const NAME = "macmini.tail1234.ts.net";
const route = (over = {}) => ({ on: true, since: 1, name: NAME, computers: true, ...over });

function world({ status = { state: "ready", name: NAME, addresses: ["100.101.102.103"], https: false, cli: "/usr/bin/tailscale" }, serveStatus = ["{}", '{"TCP":{"443":{"HTTPS":true}}}'], serveExits = false, allowed = () => true } = {}) {
  const w = { posted: [], spawned: [], children: [], checks: 0, statuses: 0 };
  w.share = createTailnetShare({
    check: async () => { w.checks++; return status; },
    allowed,
    settleMs: 5,
    answerMs: 50,
    serveStatus: async () => serveStatus[Math.min(w.statuses++, serveStatus.length - 1)],
    spawn: (cli, args) => {
      w.spawned.push([cli, ...args]);
      const child = Object.assign(new EventEmitter(), { killed: [], kill(signal) { child.killed.push(signal); setImmediate(() => child.emit("exit", null)); } });
      w.children.push(child);
      if (serveExits) setImmediate(() => child.emit("exit", 1));
      return child;
    },
  });
  w.proc = {
    postMessage(message) {
      w.posted.push(message.share);
      const origin = message.share === null ? null : message.share.served ?? `http://${message.share.name}:8799`;
      setImmediate(() => w.share.receive({ type: "openmausbot:tailnet-share-state", origin, listening: [], error: null }));
    },
  };
  return w;
}

test("off, or with no switch for other computers, nothing runs and the server shares nothing", async () => {
  for (const saved of [route({ on: false }), route({ computers: false }), null]) {
    const w = world();
    await w.share.attach(w.proc, 8799, saved);
    assert.equal(w.checks, 0, "Tailscale is not asked");
    assert.deepEqual(w.spawned, []);
    assert.deepEqual(w.posted, [], "a server never told of a share hears nothing");
    assert.deepEqual(w.share.state(), { on: false, origin: null, https: false, problem: null });
  }
});

test("without HTTPS certificates the server listens on the tailnet by itself", async () => {
  const w = world();
  const shown = await w.share.attach(w.proc, 8799, route());
  assert.deepEqual(w.spawned, []);
  assert.deepEqual(w.posted, [{ name: NAME }]);
  assert.deepEqual(shown, { on: true, origin: `http://${NAME}:8799`, https: false, problem: null });
});

test("with certificates `tailscale serve` fronts the server, and the link is the https name", async () => {
  const w = world({ status: { state: "ready", name: NAME, addresses: [], https: true, cli: "/usr/bin/tailscale" } });
  const shown = await w.share.attach(w.proc, 18799, route());
  assert.deepEqual(w.spawned, [["/usr/bin/tailscale", "serve", "--https=443", "http://127.0.0.1:18799"]]);
  assert.ok(!w.spawned[0].some((arg) => /funnel|--bg/.test(arg)), "never Funnel, never left behind");
  assert.deepEqual(w.posted, [{ name: NAME, served: `https://${NAME}` }]);
  assert.deepEqual(shown, { on: true, origin: `https://${NAME}`, https: true, problem: null });
  await w.share.stop();
  assert.deepEqual(w.children[0].killed, ["SIGTERM"]);
});

test("a port the person already serves, or a serve that fails, falls back to listening and replaces nothing", async () => {
  const https = { state: "ready", name: NAME, addresses: [], https: true, cli: "/usr/bin/tailscale" };
  const taken = world({ status: https, serveStatus: ['{"TCP":{"443":{"HTTPS":true}}}'] });
  assert.equal((await taken.share.attach(taken.proc, 8799, route())).https, false);
  assert.deepEqual(taken.spawned, []);
  const failed = world({ status: https, serveExits: true });
  assert.equal((await failed.share.attach(failed.proc, 8799, route())).https, false);
  assert.deepEqual(failed.posted, [{ name: NAME }]);
  const waiting = world({ status: https, serveStatus: ["{}"] });
  assert.equal((await waiting.share.attach(waiting.proc, 8799, route())).https, false, "serve waiting on an enablement link is no share");
  assert.deepEqual(waiting.children[0].killed, ["SIGTERM"]);
  for (const unreadable of ["", "not json", "[]"]) assert.equal(servePortTaken(unreadable), true);
  assert.equal(servePortTaken('{"Foreground":{"abc":{"TCP":{"443":{}}}}}'), true);
  assert.equal(servePortTaken('{"TCP":{"8443":{}}}'), false);
});

test("a serve that ends later hands over to the listener", async () => {
  const w = world({ status: { state: "ready", name: NAME, addresses: [], https: true, cli: "/usr/bin/tailscale" } });
  await w.share.attach(w.proc, 8799, route());
  w.children[0].emit("exit", 1);
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 100 && w.share.state().https; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(w.posted, [{ name: NAME, served: `https://${NAME}` }, { name: NAME }]);
  assert.equal(w.share.state().https, false);
  assert.equal(w.spawned.length, 1, "no retry loop");
});

test("an organization's policy keeps it off, whatever is saved", async () => {
  const w = world({ allowed: () => false });
  const shown = await w.share.attach(w.proc, 8799, route());
  assert.equal(shown.on, false);
  assert.equal(w.checks, 0);
  assert.deepEqual(w.posted, []);
});

test("Tailscale not answering keeps the saved name and says why nothing is there yet; no name at all shares nothing", async () => {
  const quiet = world({ status: { state: "not-running" } });
  quiet.proc.postMessage = (message) => { quiet.posted.push(message.share); setImmediate(() => quiet.share.receive({ type: "openmausbot:tailnet-share-state", origin: null, listening: [], error: "none" })); };
  assert.deepEqual(await quiet.share.attach(quiet.proc, 8799, route()), { on: true, origin: null, https: false, problem: "not-running" });
  assert.deepEqual(quiet.posted, [{ name: NAME }]);
  quiet.share.receive({ type: "openmausbot:tailnet-share-state", origin: `http://${NAME}:8799`, listening: ["100.101.102.103"], error: null });
  assert.deepEqual(quiet.share.state(), { on: true, origin: `http://${NAME}:8799`, https: false, problem: null }, "Tailscale came up by itself");
  const nameless = world({ status: { state: "signed-out" } });
  assert.deepEqual(await nameless.share.attach(nameless.proc, 8799, route({ name: null })), { on: true, origin: null, https: false, problem: "signed-out" });
  assert.deepEqual(nameless.posted, []);
  assert.equal(nameless.share.receive({ type: "other" }), false);
});

test("a new server port moves the serve; turning off stops it and clears the server's share", async () => {
  const w = world({ status: { state: "ready", name: NAME, addresses: [], https: true, cli: "/usr/bin/tailscale" }, serveStatus: ["{}", '{"TCP":{"443":{}}}', "{}", '{"TCP":{"443":{}}}'] });
  await w.share.attach(w.proc, 8799, route());
  await w.share.attach(w.proc, 18799, route());
  assert.deepEqual(w.spawned.map((call) => call.at(-1)), ["http://127.0.0.1:8799", "http://127.0.0.1:18799"]);
  assert.deepEqual(w.children[0].killed, ["SIGTERM"]);
  await w.share.apply(route({ computers: false }));
  assert.deepEqual(w.children[1].killed, ["SIGTERM"]);
  assert.equal(w.posted.at(-1), null);
  assert.equal(w.share.state().on, false);
});

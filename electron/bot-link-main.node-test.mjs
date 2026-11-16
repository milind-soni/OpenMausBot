import assert from "node:assert/strict";
import test from "node:test";

import { createBotLinkMain, OUTDATED_RETRY_MS, RETRY_MS } from "./bot-link-main.mjs";

const CLOUD = "https://omb-u-1.fly.dev";

function harness({ origin = CLOUD, pairStatus = 200, on = false, putFails = false } = {}) {
  const cloudCalls = [], localCalls = [];
  let server = { on: false };
  const the = { switch: on, asleep: false, origin, account: "account-1", signedOut: false, clock: 1_000_000, unreadable: false, putFails };
  const answer = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const link = createBotLinkMain({
    wanted: () => the.switch && Boolean(the.origin),
    pref: { read: () => { if (the.unreadable) throw new Error("busy"); return { v: 1, on: the.switch }; } },
    localRequest: async (route, init = {}) => {
      if (route === "/.well-known/openmausbot/environment") return answer(200, { environmentId: "11111111-1111-4111-8111-111111111111", label: "Sam's Mac" });
      const sent = init.body ? JSON.parse(init.body) : undefined;
      localCalls.push({ method: init.method ?? "GET", ...(sent ? { body: sent } : {}) });
      if (init.method === "PUT" && sent.on === true) {
        if (the.putFails) return answer(500, { error: "disk full" });
        server = { on: true, role: "dialer", online: true, origin: sent.origin, account: sent.account ?? null, peer: sent.cloud, bots: 0, waiting: 0, asleep: false, needsPairing: false };
      } else if (init.method === "PUT" && sent.on === false) server = { on: false };
      else if (init.method === "PUT" && sent.cloud && server.on && sent.origin === server.origin) server = { ...server, asleep: sent.cloud === "asleep" };
      return answer(200, server);
    },
    fetch: async (url, init) => {
      cloudCalls.push({ url, method: init.method, credentials: init.credentials, background: init.headers["x-omb-background"] === "1", ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      if (init.method === "DELETE") return answer(200, { ok: true });
      return pairStatus === 200 ? answer(200, { token: "link-sign-in-0123456789", place: { id: "cloud-1", name: "My Cloud" } }) : answer(pairStatus, { error: "no" });
    },
    cloud: () => ({ origin: the.origin, account: the.account, asleep: the.asleep, signedOut: the.signedOut }),
    cloudName: () => "My Cloud",
    watchMs: 3_600_000,
    now: () => the.clock,
  });
  const pairs = () => cloudCalls.filter((call) => call.method === "POST").length;
  return { cloudCalls, localCalls, link, the, pairs, set server(next) { server = next; }, get server() { return server; } };
}

test("switch off: My Cloud is never asked and this computer's server is only read", async (t) => {
  const h = harness();
  t.after(() => h.link.close());
  await h.link.look();
  await h.link.look();
  assert.deepEqual(h.cloudCalls, []);
  assert.equal(h.localCalls.every((call) => call.method === "GET"), true);
});

test("switch on: pairs in the background over the person's own sign-in and hands the link's sign-in, bound to this Cloud and account, to this computer's server", async (t) => {
  const h = harness({ on: true });
  t.after(() => h.link.close());
  await h.link.look();
  assert.deepEqual(h.cloudCalls, [{ url: `${CLOUD}/api/bot-link/pair`, method: "POST", credentials: "include", background: true,
    body: { computer: { id: "11111111-1111-4111-8111-111111111111", name: "Sam's Mac" }, name: "My Cloud" } }]);
  assert.deepEqual(h.localCalls.at(-1), { method: "PUT", body: { on: true, origin: CLOUD, token: "link-sign-in-0123456789", name: "Sam's Mac", cloud: { id: "cloud-1", name: "My Cloud" }, account: "account-1" } });
  await h.link.look();
  assert.equal(h.pairs(), 1);
});

test("a sleeping Cloud is not asked to pair, unless the person has just turned the switch on", async (t) => {
  const h = harness({ on: true });
  t.after(() => h.link.close());
  h.the.asleep = true;
  await h.link.look();
  await h.link.look();
  assert.equal(h.pairs(), 0);
  h.the.switch = false;
  await h.link.look();
  h.the.switch = true;
  await h.link.look();
  assert.equal(h.pairs(), 1);
});

test("a Cloud that refuses is asked again only hours later, one without the link a day later, and turning the switch on again asks at once", async (t) => {
  for (const [pairStatus, wait] of [[403, RETRY_MS], [409, RETRY_MS], [404, OUTDATED_RETRY_MS]]) {
    const h = harness({ on: true, pairStatus });
    t.after(() => h.link.close());
    await h.link.look();
    h.the.clock += wait - 60_000;
    await h.link.look();
    assert.equal(h.pairs(), 1);
    assert.equal(h.localCalls.every((call) => call.method === "GET"), true);
    h.the.clock += 120_000;
    await h.link.look();
    assert.equal(h.pairs(), 2);
    h.the.switch = false;
    await h.link.look();
    h.the.switch = true;
    await h.link.look();
    assert.equal(h.pairs(), 3);
  }
});

test("this computer's server does not take the link: the sign-in just made is ended, and My Cloud is not asked again for hours", async (t) => {
  const h = harness({ on: true, putFails: true });
  t.after(() => h.link.close());
  await h.link.look();
  assert.deepEqual(h.cloudCalls.map((call) => call.method), ["POST", "DELETE"]);
  assert.equal(h.cloudCalls[1].url, `${CLOUD}/api/bot-link/pair?computer=11111111-1111-4111-8111-111111111111`);
  for (let minute = 0; minute < 30; minute += 1) { h.the.clock += 60_000; await h.link.look(); }
  assert.equal(h.pairs(), 1);
});

test("switch turned off: this computer's server is told and My Cloud forgets this computer; My Cloud out of sight or an unreadable switch ends nothing", async (t) => {
  const h = harness({ on: true });
  t.after(() => h.link.close());
  await h.link.look();
  h.the.origin = null;
  await h.link.look();
  h.the.origin = CLOUD;
  h.the.unreadable = true;
  await h.link.look();
  assert.equal(h.server.on, true);
  h.the.unreadable = false;
  h.the.switch = false;
  await h.link.look();
  assert.deepEqual(h.server, { on: false });
  assert.deepEqual([h.cloudCalls.at(-1).method, h.cloudCalls.at(-1).background], ["DELETE", true]);
  await h.link.look();
  assert.equal(h.pairs(), 1);
});

test("signing out, another account or another Cloud ends the link on this computer at once, and the old Cloud is not asked over the new sign-in", async (t) => {
  for (const change of [(the) => { the.signedOut = true; the.account = null; }, (the) => { the.account = "account-2"; }, (the) => { the.origin = "https://omb-u-2.fly.dev"; }]) {
    const h = harness({ on: true });
    t.after(() => h.link.close());
    await h.link.look();
    const asked = h.cloudCalls.length;
    change(h.the);
    await h.link.look();
    assert.deepEqual(h.localCalls.at(-1), { method: "PUT", body: { on: false } });
    assert.equal(h.cloudCalls.length, asked);
  }
  const h = harness({ on: true });
  t.after(() => h.link.close());
  await h.link.look();
  h.the.account = "account-2";
  await h.link.look();
  assert.deepEqual(h.server, { on: false });
});

test("the Admin's word on sleep goes to this computer's server for its own Cloud, for as long as its end disagrees; a link that ended unheard is told when the Cloud is awake", async (t) => {
  const h = harness({ on: true });
  t.after(() => h.link.close());
  await h.link.look();
  h.the.asleep = true;
  await h.link.look();
  assert.deepEqual(h.localCalls.at(-1), { method: "PUT", body: { cloud: "asleep", origin: CLOUD } });
  const puts = h.localCalls.filter((call) => call.method === "PUT").length;
  await h.link.look();
  assert.equal(h.localCalls.filter((call) => call.method === "PUT").length, puts);
  h.the.asleep = false;
  await h.link.look();
  assert.deepEqual(h.localCalls.at(-1), { method: "PUT", body: { cloud: "awake", origin: CLOUD } });
  h.server = { ...h.server, asleep: true };
  await h.link.look();
  assert.deepEqual(h.localCalls.at(-1), { method: "PUT", body: { cloud: "awake", origin: CLOUD } });
  const asked = h.cloudCalls.length;
  h.server = { ...h.server, needsPairing: true };
  h.the.asleep = true;
  await h.link.look();
  assert.equal(h.cloudCalls.length, asked);

  const ended = harness();
  t.after(() => ended.link.close());
  ended.server = { on: false, ended: [CLOUD, "https://old.example"] };
  ended.the.asleep = true;
  await ended.link.look();
  assert.equal(ended.localCalls.some((call) => call.method === "PUT"), false);
  ended.the.asleep = false;
  await ended.link.look();
  assert.deepEqual(ended.localCalls.filter((call) => call.method === "PUT"), [{ method: "PUT", body: { cloud: "awake", origin: CLOUD } }]);
});

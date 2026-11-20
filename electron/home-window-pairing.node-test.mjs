// A code from the Admin for My Cloud is never asked for in a loop (home-window.mjs PAIR_RETRY_MS): not when its page won't
// load from this computer, and not when the Admin answers 429; and the screen names the address this computer couldn't reach.
import assert from "node:assert/strict";
import test from "node:test";

import { PAIR_RETRY_MS } from "./home-window.mjs";
import { CLOUD, world } from "./fixtures/home-window-world.mjs";

test("My Cloud's page that never loads from here: one code from the Admin, not one per look, and the screen names the address", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  assert.equal(w.pairs, 1);
  // This computer couldn't load it (a VPN, firewall or DNS filter in the way): the screen, which asks again as it mounts,
  // when the window comes to the front and on each session read.
  w.home.failed(w.url, -102);
  await w.later(0);
  for (let i = 0; i < 10; i++) { await w.home.retry(); await w.home.changed(); }
  assert.equal(w.pairs, 1, "the Admin is not asked for another code at once");
  assert.deepEqual(w.home.view(), { screen: "offline", cause: "network", host: "omb-t-1.fly.dev" });
  await w.later(PAIR_RETRY_MS[0]);
  await w.home.retry();
  assert.equal(w.pairs, 2, "asked again once the wait is over");
  w.home.failed(w.url, -102); await w.later(0);
  await w.later(PAIR_RETRY_MS[0]); await w.home.retry();
  assert.equal(w.pairs, 2, "each failure waits longer");
  await w.later(PAIR_RETRY_MS[1]); await w.home.retry();
  assert.equal(w.pairs, 3);
  w.home.navigated(`${CLOUD}/`); w.home.failed(`${CLOUD}/`, -102); await w.later(0);
  await w.later(PAIR_RETRY_MS[0]); await w.home.retry();
  assert.equal(w.pairs, 4, "a page that loaded starts the waits again");
});

test("the Admin's 429 on a pairing is honoured, Retry-After included, however often the window asks", async () => {
  const w = world({ cloud: { signedIn: false, pairError: Object.assign(new Error("Cloud request failed."), { status: 429, retryAfter: 120 }) } });
  await w.home.show();
  assert.equal(w.pairs, 1);
  for (let i = 0; i < 10; i++) { await w.home.changed(); await w.home.retry(); await w.later(1_000); }
  assert.equal(w.pairs, 1, "nothing asks again before the Admin's Retry-After");
  assert.equal(w.home.view().screen, "offline");
  w.cloud.pairError = null;
  await w.later(120_000); await w.home.retry();
  assert.equal(w.pairs, 2);
});

test("My Cloud that doesn't answer this computer, with no reason from the Admin: the screen names its address", async () => {
  const w = world({ cloud: { down: true } });
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "offline", cause: "network", host: "omb-t-1.fly.dev" });
  assert.equal(w.pairs, 0);
});

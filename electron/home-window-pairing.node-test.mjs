// A code from the Admin for My Cloud is never asked for in a loop (home-pairing.mjs PAIR_RETRY_MS): not when its page won't
// load from this computer, and not when the Admin answers 429. One passing failure costs seconds, Try again is never held by
// that wait, and the screen names the address only after its page has failed to connect from here for about a minute.
import assert from "node:assert/strict";
import test from "node:test";

import { connectionError } from "./home-pairing.mjs";
import { NETWORK_HINT_MS, PAIR_FLOOR_MS, PAIR_LIMIT_MS, PAIR_RETRY_MS, RETRY_MS } from "./home-window.mjs";
import { CLOUD, connected, world } from "./fixtures/home-window-world.mjs";

/** Moves the clock a second at a time (the screen's own timer runs as it falls due) until `check()`: the ms that took, or null. */
async function until(w, check, most = 600_000) {
  for (let t = 1_000; t <= most; t += 1_000) { await w.later(1_000); if (check()) return t; }
  return null;
}
const refused = (status, more = {}) => Object.assign(new Error("Cloud request failed."), { status, ...more });

test("My Cloud's page that doesn't load from here: one code from the Admin, not one per look, and the waits grow", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  assert.equal(w.pairs, 1);
  // The screen asks again as it mounts, when the window comes to the front and on each session read.
  w.home.failed(w.url, -102);
  await w.later(0);
  for (let i = 0; i < 10; i++) { await w.home.retry(); await w.home.changed(); }
  assert.equal(w.pairs, 1, "the Admin is not asked for another code at once");
  assert.deepEqual(w.home.view(), { screen: "offline" }, "no address named for a page that failed a moment ago");
  await w.later(PAIR_RETRY_MS[0]);
  await w.home.retry();
  assert.equal(w.pairs, 2, "asked again once the first wait is over");
  w.home.failed(w.url, -102); await w.later(0);
  await w.later(PAIR_RETRY_MS[0]); await w.home.retry();
  assert.equal(w.pairs, 2, "each failure waits longer");
  await w.later(PAIR_RETRY_MS[1]); await w.home.retry();
  assert.equal(w.pairs, 3);
  w.home.navigated(`${CLOUD}/`); w.home.failed(`${CLOUD}/`, -102); await w.later(0);
  await w.later(PAIR_RETRY_MS[0]); await w.home.retry();
  assert.equal(w.pairs, 4, "a page that loaded starts the waits again");
});

test("one passing failure costs a few seconds, and Try again is never held by the wait", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  w.home.failed(w.url, -102); await w.later(0);
  const opened = await until(w, () => w.pairs >= 2);
  assert.ok(opened !== null && opened <= PAIR_RETRY_MS[0], `opened ${opened} ms after the failure`);
  assert.ok(PAIR_RETRY_MS[0] <= 5_000);

  // Two failures in a row wait 10 s; the page failed a few seconds after its code.
  const pressed = world({ cloud: { signedIn: false } });
  await pressed.home.show();
  pressed.home.failed(pressed.url, -102); await pressed.later(0);
  assert.notEqual(await until(pressed, () => pressed.pairs >= 2), null);
  await pressed.later(PAIR_FLOOR_MS);
  pressed.home.failed(pressed.url, -102); await pressed.later(0);
  await pressed.home.retry();
  assert.equal(pressed.pairs, 2, "the screen's own look still waits");
  await pressed.home.retry({ pressed: true });
  assert.equal(pressed.pairs, 3, "Try again asks for the code at once");
});

test("Try again is never a loop: codes for one Cloud stay PAIR_FLOOR_MS apart, and a press inside that waits for its end", async () => {
  const w = world({ cloud: { signedIn: false, pairError: refused(502) } });
  await w.home.show();
  assert.equal(w.pairs, 1);
  await w.later(500);
  await w.home.retry({ pressed: true });
  assert.equal(w.pairs, 1, "too soon after the last code");
  assert.equal(await until(w, () => w.pairs >= 2), PAIR_FLOOR_MS - 500 + 500, "asked by itself once that floor ends, no second press needed");
  // A held key, or a page asking in a loop: ten presses a second for a minute.
  const before = w.pairs, start = w.clock;
  for (let t = 0; t < 60_000; t += 100) { await w.home.retry({ pressed: true }); await w.later(100); }
  assert.ok(w.pairs - before <= Math.ceil((w.clock - start) / PAIR_FLOOR_MS) + 1, `${w.pairs - before} codes in a minute`);
});

test("a Cloud whose look flaps between no answer and an answer ends a wait early once, not on every flap", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  // Every other look at /api/health gets no answer.
  Object.defineProperty(w.cloud, "down", { get() { return w.fetched.filter(([url]) => url === "/api/health").length % 2 === 1; }, set() {} });
  // Every page it is sent to fails to load.
  let went = 0;
  for (let t = 0; t < 40 * 60_000; t += 500) {
    if (w.went.length > went) { went = w.went.length; if (w.url.startsWith("https:")) w.home.failed(w.url, -7); }
    await w.later(500);
  }
  // Main asked 11 times in these 40 minutes; an early end on every flap asked about 400 times.
  assert.ok(w.pairs > 5 && w.pairs <= 16, `${w.pairs} codes in 40 minutes`);
});

test("a Cloud that restarted: the look that finds it answering again opens it, whatever the wait", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  // Two pages in a row that didn't load: the third failure waits PAIR_RETRY_MS[2].
  for (let i = 1; i <= 2; i++) {
    w.home.failed(w.url, -102); await w.later(0);
    assert.notEqual(await until(w, () => w.pairs > i), null);
  }
  w.home.failed(w.url, -102); w.cloud.down = true; await w.later(0);
  const failedAt = w.clock;
  await w.later(RETRY_MS[0]);
  assert.equal(w.home.view().screen, "offline", "a look finds it not answering");
  w.cloud.down = false;
  const opened = await until(w, () => w.pairs > 3);
  assert.ok(opened !== null && opened <= RETRY_MS[1], `opened ${opened} ms after it answered again`);
  assert.ok(w.clock - failedAt < PAIR_RETRY_MS[2]);
});

test("an Admin that refuses (a restart): Try again asks at once; its 429 holds at most a few minutes and says until when", async () => {
  const w = world({ cloud: { signedIn: false, pairError: refused(502) } });
  await w.home.show();
  assert.equal(w.pairs, 1);
  assert.notEqual(await until(w, () => w.pairs >= 2), null);
  // Refused twice: the next code waits PAIR_RETRY_MS[1].
  await w.later(PAIR_FLOOR_MS);
  await w.home.retry();
  assert.equal(w.pairs, 2, "not every look");
  await w.home.retry({ pressed: true });
  assert.equal(w.pairs, 3, "the person's press");

  const limited = world({ cloud: { signedIn: false, pairError: refused(429, { retryAfter: 7200 }) } });
  await limited.home.show();
  const at = limited.clock;
  assert.equal(limited.pairs, 1);
  assert.deepEqual(limited.home.view(), { screen: "offline", retryAt: at + PAIR_LIMIT_MS }, "the screen says when it tries again");
  assert.ok(PAIR_LIMIT_MS <= 5 * 60_000);
  for (let i = 0; i < 10; i++) { await limited.home.changed(); await limited.home.retry({ pressed: true }); await limited.later(1_000); }
  assert.equal(limited.pairs, 1, "nothing asks again before the Admin's wait, not even Try again");
  limited.cloud.pairError = null;
  const opened = await until(limited, () => limited.pairs >= 2);
  assert.equal(at + PAIR_LIMIT_MS <= limited.clock && limited.clock <= at + PAIR_LIMIT_MS + 1_000, true, `asked again ${opened} ms later`);
});

test("My Cloud opened before it is home: a page of it that loads starts the waits again", async () => {
  const w = world({ journal: null, cloud: { signedIn: false } });
  await w.home.openCloud();
  assert.equal(w.pairs, 1);
  for (let round = 0; round < 3; round++) {
    w.home.failed(w.url, -102); await w.later(0);
    const before = w.pairs;
    const next = await until(w, () => w.pairs > before);
    assert.ok(next !== null && next <= PAIR_RETRY_MS[0], `round ${round}: the next code after ${next} ms`);
    w.home.navigated(`${CLOUD}/`);
  }
});

test("another account taking over, or signing out and in again, drops the wait", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  w.home.failed(w.url, -102); await w.later(0);
  w.home.accountLeaving();
  await w.home.show();
  assert.equal(w.pairs, 2);

  const again = world({ cloud: { signedIn: false } });
  await again.home.show();
  // Five pages in a row that didn't load: the next code waits minutes.
  for (let i = 1; i <= 5; i++) { again.home.failed(again.url, -102); await again.later(0); assert.notEqual(await until(again, () => again.pairs > i), null); }
  again.home.failed(again.url, -102); await again.later(PAIR_FLOOR_MS);
  await again.home.retry();
  assert.equal(again.pairs, 6, "held");
  again.state = { status: "signed-out" }; await again.home.changed();
  again.state = connected(); await again.home.changed();
  await again.home.retry();
  assert.equal(again.pairs, 7, "signed in again: asked at once");
});

const host = (w) => w.home.view().host ?? null;

test("the screen names the address only when the page fails to connect again a minute after it first did", async () => {
  const w = world({ cloud: { signedIn: false } });
  await w.home.show();
  w.cloud.down = true; w.home.failed(w.url, -102); await w.later(0);
  assert.equal(await until(w, () => host(w) !== null, 3 * NETWORK_HINT_MS), null, "a minute and more of failed looks alone never names it");
  // It answers its look again, and its page still doesn't load: the address is named.
  w.cloud.down = false;
  assert.notEqual(await until(w, () => w.pairs >= 2), null);
  w.home.failed(w.url, -102); await w.later(0);
  assert.deepEqual(w.home.view(), { screen: "offline", cause: "network", host: "omb-t-1.fly.dev" });
  // It answers again, while the Admin refuses its code: the screen stays, without the address.
  w.cloud.pairError = refused(502);
  assert.notEqual(await until(w, () => w.pairs >= 3), null);
  assert.equal(w.home.view().screen, "offline");
  assert.equal(host(w), null, "a look that got an answer doesn't name it");
  // A page of it that loads forgets it.
  w.home.navigated(`${CLOUD}/`); w.home.failed(`${CLOUD}/`, -102); await w.later(0);
  assert.equal(host(w), null);

  const soon = world({ cloud: { signedIn: false } });
  await soon.home.show();
  soon.home.failed(soon.url, -102); await soon.later(0);
  assert.notEqual(await until(soon, () => soon.pairs >= 2), null);
  soon.cloud.down = true; soon.home.failed(soon.url, -102); await soon.later(0);
  assert.equal(host(soon), null, "a second failure seconds later is not this computer being blocked");
});

test("no address is named for a Cloud that only fails its look, answers 5xx, or a computer with no network", async () => {
  const quiet = world({ cloud: { down: true } });
  await quiet.home.show();
  await until(quiet, () => false, 3 * NETWORK_HINT_MS);
  assert.equal(quiet.home.view().screen, "offline");
  assert.equal(host(quiet), null, "a look that fails or is slow is not this computer being blocked");

  const failing = world({ cloud: { signedIn: false } });
  await failing.home.show();
  failing.cloud.health = 502; failing.home.failed(failing.url, -102); await failing.later(0);
  await until(failing, () => false, 3 * NETWORK_HINT_MS);
  assert.equal(failing.home.view().screen, "offline");
  assert.equal(host(failing), null, "a Cloud answering 5xx (restarting, updating) was reached");

  for (const code of [-106, -21]) {
    const offline = world({ cloud: { signedIn: false } });
    await offline.home.show();
    offline.cloud.down = true; offline.home.failed(offline.url, code); await offline.later(0);
    await until(offline, () => false, 3 * NETWORK_HINT_MS);
    assert.equal(host(offline), null, `net error ${code}`);
  }
});

test("Chromium's errors that name this computer's connection: names, refused, timed out, TLS and certificates", () => {
  for (const code of [-105, -137, -802, -102, -101, -118, -7, -107, -113, -200, -202, -138, -130]) assert.equal(connectionError(code), true, String(code));
  for (const code of [-106, -21, -3, -2, -300, 0]) assert.equal(connectionError(code), false, String(code));
});

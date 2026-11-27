// While an operation of the Admin's own has a Cloud down (an update, resize, move, restore or start: cloud-operation.mjs), the
// window says what it is instead of "can't be reached", looks again by itself, and opens the Cloud once it answers.
import assert from "node:assert/strict";
import test from "node:test";

import { parseCloudSummary } from "./cloud-home.mjs";
import { parseCloudList } from "./cloud-list.mjs";
import { anyOperation, cloudOperationAt, OPERATION_GRACE_MS, OPERATION_REFRESH_MS, operationEndsAt, parseCloudOperation } from "./cloud-operation.mjs";
import { HOME_SCREEN_PATH } from "./home-window.mjs";
import { ACME, CLIENT, CLIENT_A, CLOUD, connected, LOCAL, TEAM, world } from "./fixtures/home-window-world.mjs";

const UPDATE = { kind: "update", since: 1_000_000, until: 2_080_000, expectedAt: 1_180_000 };

test("an operation is read whole or not at all; a malformed estimate is left out; a kind this app doesn't know is kept", () => {
  assert.deepEqual(parseCloudOperation(UPDATE), UPDATE);
  assert.deepEqual(parseCloudOperation({ ...UPDATE, expectedAt: "soon", backup: true, bigger: "yes", label: "its move to Hetzner" }),
    { kind: "update", since: 1_000_000, until: 2_080_000, backup: true }, "never the Admin's label, only fixed fields");
  assert.deepEqual(parseCloudOperation({ kind: "teleport", since: 5, until: 9 }), { kind: "teleport", since: 5, until: 9 });
  for (const bad of [null, [], { ...UPDATE, kind: "<b>" }, { ...UPDATE, kind: 3 }, { ...UPDATE, since: 0 }, { ...UPDATE, until: 1.5 }, { kind: "update" }]) assert.equal(parseCloudOperation(bad), null);
});

test("the session's cloud and each listed Cloud carry it; an older Admin's (none) reads as before", () => {
  const summary = parseCloudSummary({ state: "ready", origin: CLOUD, operation: UPDATE });
  assert.deepEqual(summary.operation, UPDATE);
  assert.equal("operation" in parseCloudSummary({ state: "ready", origin: CLOUD }), false);
  assert.equal("operation" in parseCloudSummary({ state: "stopped", origin: CLOUD, operation: UPDATE }), false, "a stopped Cloud has no operation of ours");
  const [entry] = parseCloudList([{ ...CLIENT_A, operation: { kind: "move", since: 1, until: 2 } }]);
  assert.deepEqual(entry.operation, { kind: "move", since: 1, until: 2 });
  assert.equal(anyOperation(summary, null), true);
  assert.equal(anyOperation({ status: "ready" }, [entry]), true);
  assert.equal(anyOperation({ status: "ready" }, [CLIENT_A]), false);
  const state = { ...connected({ operation: UPDATE }), clouds: [entry] };
  assert.deepEqual([cloudOperationAt(state, CLOUD), cloudOperationAt(state, CLIENT), cloudOperationAt(state, "https://other.example"), cloudOperationAt({ status: "signed-out" }, CLOUD)],
    [UPDATE, { kind: "move", since: 1, until: 2 }, null, null]);
});

test("My Cloud being updated: this computer's screen says so, never \"can't reach\", and opens it by itself once it answers", async () => {
  const w = world({ cloud: { down: true }, state: connected({ operation: UPDATE }) });
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "working", operation: UPDATE });
  assert.deepEqual(w.went.at(-1), [`${LOCAL}${HOME_SCREEN_PATH}`, null]);
  assert.ok(w.timers.length > 0 && w.timers.every((timer) => timer.at - w.clock <= OPERATION_REFRESH_MS), "it looks again by itself, within OPERATION_REFRESH_MS");
  // The update is done: the Admin says nothing more, the Cloud answers, and the window goes there without a press.
  w.cloud.down = false;
  w.state = connected();
  await w.later(OPERATION_REFRESH_MS);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.went.at(-1)[1], CLOUD, "My Cloud opens");
  // The same Cloud down with nothing of ours on it is the offline screen, as before.
  const plain = world({ cloud: { down: true } });
  await plain.home.show();
  assert.equal(plain.home.view().screen, "offline");
});

test("a Cloud the Admin is starting again says so, never its setup, and its address is never looked up; a failed one keeps its own screen", async () => {
  const start = { kind: "start", since: 1_000_000, until: 2_800_000 };
  const w = world({ state: connected({ status: "provisioning", setup: { step: "starting" }, operation: start }) });
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "working", operation: start });
  assert.deepEqual(w.fetched, []);
  // Without the Admin's word: its setup, as before.
  const before = world({ state: connected({ status: "provisioning", setup: { step: "starting" } }) });
  await before.home.show();
  assert.equal(before.home.view().screen, "setup");
  // Its start failed for good: the failed screen with its own words and its Try again, whatever an Admin sends with it.
  assert.equal("operation" in parseCloudSummary({ state: "failed", operation: start }), false, "a failed Cloud has no operation");
  const failed = world({ state: connected({ status: "failed", operation: start }) });
  await failed.home.show();
  assert.deepEqual(failed.home.view(), { screen: "plan", machine: "failed" });
  assert.equal(cloudOperationAt(connected({ status: "failed", operation: start }), CLOUD), null);
});

test("the screen ends by itself 15 minutes past the operation's deadline by this computer's clock, whatever the Admin keeps saying", async () => {
  const update = { kind: "update", since: 1_000_000, until: 1_000_000 + 18 * 60_000, expectedAt: 1_000_000 + 3 * 60_000 };
  assert.equal(operationEndsAt(update, 1_000_000), update.until + OPERATION_GRACE_MS);
  // A clock far ahead of the Admin's: never past its own span; far behind: still at most the span plus the grace.
  assert.equal(operationEndsAt(update, update.until + 60 * 60_000), update.until + 60 * 60_000 + OPERATION_GRACE_MS);
  assert.equal(operationEndsAt(update, 0), 18 * 60_000 + OPERATION_GRACE_MS);
  const w = world({ cloud: { down: true }, state: connected({ operation: update }) });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const look = async () => { await w.home.show(); await settle(); };
  w.clock = update.since;
  await look();
  assert.equal(w.home.view().screen, "working");
  // The Admin goes on saying it, and its `since` even moves on with each read: the end was fixed when it was first shown.
  await w.later(update.until - w.clock + OPERATION_GRACE_MS - 60_000);
  w.state = connected({ operation: { ...update, since: w.clock, until: w.clock + 18 * 60_000 } });
  await look();
  assert.equal(w.home.view().screen, "working", "inside its hard end");
  await w.later(2 * 60_000);
  w.state = connected({ operation: { ...update, since: w.clock, until: w.clock + 18 * 60_000 } });
  await look();
  assert.equal(w.home.view().screen, "offline", "past it: the plain \"couldn't reach\", with Try again");
  // Once the Cloud answers, its next operation is a new outage.
  w.cloud.down = false;
  w.state = connected();
  await look();
  assert.equal(w.went.at(-1)[1], CLOUD);
  w.cloud.down = true;
  w.url = "";
  w.state = connected({ operation: { ...update, since: w.clock, until: w.clock + 18 * 60_000 } });
  await look();
  assert.equal(w.home.view().screen, "working", "a new outage");
});

test("another Cloud of the person's own being moved: its screen names it", async () => {
  const move = { kind: "move", since: 1_000_000, until: 4_600_000 };
  const w = world({ client: { down: true }, state: { ...connected(), clouds: [{ ...CLIENT_A, operation: move }] } });
  await w.home.show({ place: { cloud: "c-a" } });
  assert.deepEqual(w.home.view(), { screen: "working", operation: move, name: "Client A" });
});

test("the Cloud's own page asks what has it down: the Admin's word for the place on screen only, read again when it is old, while the Admin fails at most each minute", async () => {
  const w = world({ state: { ...connected({ operation: UPDATE }), verifiedAt: 1_000_000 } });
  await w.home.refresh();
  assert.deepEqual(await w.home.operation(), UPDATE);
  w.state = { ...connected(), verifiedAt: 1_000_000 };
  assert.equal(await w.home.operation(), null);
  assert.equal(w.refreshes, 0, "a fresh read is not read again");
  // An old read is read again first, so the page gets the Admin's word as of now: here the update has just begun.
  const stale = world({ state: { ...connected(), verifiedAt: 1 } });
  await stale.home.refresh();
  stale.refreshed = { ...connected({ operation: UPDATE }), verifiedAt: stale.clock };
  assert.deepEqual(await stale.home.operation(), UPDATE);
  assert.equal(stale.refreshes, 1);
  // The Admin itself failing: within a minute of the account's last try, its retry wait is kept, however often the page asks.
  const failing = world({ state: { ...connected(), verifiedAt: 1 } });
  await failing.home.refresh();
  failing.failingUntil = failing.clock + 300_000; failing.lastAttemptAt = failing.clock;
  for (let i = 0; i < 3; i++) assert.equal(await failing.home.operation(), null);
  assert.equal(failing.refreshes, 0);
  failing.clock += 60_000;
  await failing.home.operation();
  assert.equal(failing.refreshes, 1, "a minute after the last try: read again, inside a 5-minute wait");
  failing.lastAttemptAt = failing.clock; failing.clock += 30_000;
  await failing.home.operation();
  assert.equal(failing.refreshes, 1);
  failing.failingUntil = 0;
  await failing.home.operation();
  assert.equal(failing.refreshes, 2, "read again once its wait is over");
  const signedOut = world({ state: { status: "signed-out" } });
  assert.equal(await signedOut.home.operation(), null);
});

test("a team's Cloud's own page is told its name with what has it down", async () => {
  const move = { kind: "move", since: 1_000_000, until: 4_600_000 };
  const w = world({ state: { ...connected(), teams: [ACME], clouds: [{ ...CLIENT_A, id: "t-acme", name: "Acme", teamId: ACME.id, origin: TEAM, operation: move }], verifiedAt: 1_000_000 } });
  await w.home.show({ place: { team: ACME.id } });
  assert.deepEqual(await w.home.operation(), { ...move, name: "Acme" });
});

test("a rollback is its own kind", () => {
  assert.deepEqual(parseCloudOperation({ kind: "rollback", since: 5, until: 9, expectedAt: 7 }), { kind: "rollback", since: 5, until: 9, expectedAt: 7 });
});

test("Try again draws the screen at once, never after a session read that hangs, and again when that read lands", async () => {
  const w = world({ state: { status: "signed-out" } });
  await w.home.show();
  await w.home.retry();
  assert.equal(w.freshens ?? 0, 0, "only a press reads the sign-in");
  let land, timer;
  w.freshRead = new Promise((resolve) => { land = resolve; });
  const drawn = await Promise.race([w.home.retry({ pressed: true }).then(() => "drawn"), new Promise((resolve) => { timer = setTimeout(resolve, 5_000, "waited for the read"); })]);
  clearTimeout(timer);
  assert.equal(drawn, "drawn");
  assert.equal(w.freshens, 1);
  const reads = w.stateReads;
  land(w.state);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(w.stateReads > reads, "drawn again once the read lands");
});

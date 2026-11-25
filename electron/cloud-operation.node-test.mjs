// While an operation of the Admin's own has a Cloud down (an update, resize, move, restore or start: cloud-operation.mjs), the
// window says what it is instead of "can't be reached", looks again by itself, and opens the Cloud once it answers.
import assert from "node:assert/strict";
import test from "node:test";

import { parseCloudSummary } from "./cloud-home.mjs";
import { parseCloudList } from "./cloud-list.mjs";
import { anyOperation, cloudOperationAt, OPERATION_REFRESH_MS, parseCloudOperation } from "./cloud-operation.mjs";
import { HOME_SCREEN_PATH } from "./home-window.mjs";
import { CLIENT, CLIENT_A, CLOUD, connected, LOCAL, world } from "./fixtures/home-window-world.mjs";

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

test("a Cloud the Admin is starting again says so, never its setup or a failure, and its address is never looked up", async () => {
  const start = { kind: "start", since: 1_000_000, until: 2_800_000 };
  for (const machine of [{ status: "provisioning", setup: { step: "starting" }, operation: start }, { status: "failed", operation: start }]) {
    const w = world({ state: connected(machine) });
    await w.home.show();
    assert.deepEqual(w.home.view(), { screen: "working", operation: start }, machine.status);
    assert.deepEqual(w.fetched, [], machine.status);
  }
  // Without the Admin's word: its setup, as before.
  const before = world({ state: connected({ status: "provisioning", setup: { step: "starting" } }) });
  await before.home.show();
  assert.equal(before.home.view().screen, "setup");
});

test("another Cloud of the person's own being moved: its screen names it", async () => {
  const move = { kind: "move", since: 1_000_000, until: 4_600_000 };
  const w = world({ client: { down: true }, state: { ...connected(), clouds: [{ ...CLIENT_A, operation: move }] } });
  await w.home.show({ place: { cloud: "c-a" } });
  assert.deepEqual(w.home.view(), { screen: "working", operation: move, name: "Client A" });
});

test("the Cloud's own page asks what has it down: the Admin's word for the place on screen only, read again when it is old", async () => {
  const w = world({ state: { ...connected({ operation: UPDATE }), verifiedAt: 1_000_000 } });
  await w.home.refresh();
  assert.deepEqual(await w.home.operation(), UPDATE);
  w.state = { ...connected(), verifiedAt: 1_000_000 };
  assert.equal(await w.home.operation(), null);
  // An old read is read again first when the account can (this fixture's can't): it still answers what it has, never throws.
  const stale = world({ state: { ...connected({ operation: UPDATE }), verifiedAt: 1 } });
  await stale.home.refresh();
  assert.deepEqual(await stale.home.operation(), UPDATE);
  const signedOut = world({ state: { status: "signed-out" } });
  assert.equal(await signedOut.home.operation(), null);
});

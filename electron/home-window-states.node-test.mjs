// This computer's screen for a Cloud the Admin's list says isn't running (home-window.mjs `cloudScreen`): what it is in plain
// words, never its address looked up, a page that never loads turned into the offline screen with Try again, and Remove from
// list from that screen.
import assert from "node:assert/strict";
import test from "node:test";

import { cloudScreen, HOME_SCREEN_PATH, installHomeWindowIpc, OPEN_MS } from "./home-window.mjs";
import { CLIENT, CLIENT_A, CLOUD, connected, LOCAL, world } from "./fixtures/home-window-world.mjs";

const ENDED_HOME = { ...CLIENT_A, id: "c-home", name: "My Cloud", color: null, origin: CLOUD, primary: true, status: "ended", deleteAfter: 1_900_000_000_000, removable: true };
test("My Cloud that ended, asked for before the move: its own screen with the day its files go and Remove from list; its address is never looked up", async () => {
  const w = world({ journal: null, state: { ...connected({ status: "stopped", hold: { until: 1_900_000_000_000 } }), clouds: [ENDED_HOME, CLIENT_A] }, url: `${LOCAL}/` });
  await w.home.openCloud();
  assert.deepEqual(w.home.view(), { screen: "ended", name: "My Cloud", deleteAt: 1_900_000_000_000, removable: true });
  assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]], "this computer's own screen, never My Cloud's address");
  assert.deepEqual([w.fetched, w.pairs, w.wakes], [[], 0, 0], "nothing dials it, pairs with it or wakes it");
  assert.equal(w.home.asking(), true, "This computer still leaves the screen");
  assert.equal(w.timers.length, 0, "nothing to look again for: the session's word moves it");
  // Its checkout left unpaid, or its payment: each its own screen, and still nothing looked up.
  for (const [status, screen] of [["checkout", "checkout"], ["payment_problem", "payment"], ["stopped", "ended"]]) {
    const other = world({ journal: null, state: { ...connected({ status: "stopped" }), clouds: [{ ...ENDED_HOME, status, removable: undefined, deleteAfter: undefined }] }, url: `${LOCAL}/` });
    await other.home.openCloud();
    assert.deepEqual(other.home.view(), { screen, name: "My Cloud" }, status);
    assert.deepEqual([other.fetched, other.pairs], [[], 0], status);
  }
  // An Admin without the list: the machine's word, still never its address.
  const older = world({ journal: null, state: connected({ status: "stopped" }), url: `${LOCAL}/` });
  await older.home.openCloud();
  assert.deepEqual([older.home.view(), older.fetched], [{ screen: "plan", machine: "stopped" }, []]);
  // Removed from the list (its machine still keeps its files): a saved entry asked for is simply this computer, never dialled.
  const removed = world({ journal: null, state: { ...connected({ status: "stopped" }), clouds: [CLIENT_A] }, url: `${LOCAL}/` });
  await removed.home.openCloud();
  assert.deepEqual([removed.went, removed.fetched, removed.pairs, removed.home.asking()], [[], [], 0, false]);
  // Once My Cloud is home, its list's word too.
  const home = world({ state: { ...connected({ status: "stopped" }), clouds: [ENDED_HOME] } });
  await home.home.show();
  assert.deepEqual([home.home.view().screen, home.fetched], ["ended", []]);
});

test("another Cloud of the person's own that isn't running shows what it is, never its address: ended, its checkout not finished, its payment", async () => {
  for (const [status, screen] of [["ended", "ended"], ["stopped", "ended"], ["checkout", "checkout"], ["payment_problem", "payment"]]) {
    const w = world({ state: { ...connected(), clouds: [{ ...CLIENT_A, status, ...(status === "checkout" ? { origin: null } : {}) }] } });
    await w.home.show({ place: { cloud: "c-a" } });
    assert.deepEqual(w.home.view(), { screen, name: "Client A" }, status);
    assert.deepEqual([w.fetched, w.ownPairs, w.pairs], [[], [], 0], status);
    assert.deepEqual(w.went, [[`${LOCAL}${HOME_SCREEN_PATH}`, null]], status);
    assert.deepEqual(w.remembers, [{ cloud: "c-a" }], status);
  }
  assert.deepEqual(cloudScreen({ ...CLIENT_A, status: "setting_up", setup: { step: "starting" } }), { screen: "setup", step: "starting" }, "being set up: its setup, as before");
  for (const status of ["ready", "offline"]) assert.equal(cloudScreen({ ...CLIENT_A, status }), null, `${status}: it opens`);
  // The running one opens as always.
  const w = world({ state: { ...connected(), clouds: [CLIENT_A] } });
  await w.home.show({ place: { cloud: "c-a" } });
  assert.deepEqual(w.went.at(-1), [CLIENT, CLIENT, "c-a"]);
});

test("a Cloud that answers the look but whose page never loads is the offline screen after OPEN_MS, with Try again: never an endless spinner", async () => {
  const w = world({ state: { ...connected(), clouds: [CLIENT_A] } });
  w.stall = (url) => url.startsWith(CLIENT);
  const shown = w.home.show({ place: { cloud: "c-a" } });
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(w.went.at(-1), [CLIENT, CLIENT, "c-a"], "it went there");
  assert.deepEqual(w.home.view(), { screen: "opening", name: "Client A" });
  await w.later(OPEN_MS);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(w.home.view(), { screen: "offline", name: "Client A" });
  await shown;
  assert.deepEqual(w.went.at(-1), [`${LOCAL}${HOME_SCREEN_PATH}`, null], "this computer's screen says so");
  w.stall = () => false;
  await w.later(2_000);
  assert.deepEqual(w.went.at(-1), [CLIENT, CLIENT, "c-a"], "and it looks again by itself");
  // My Cloud too: a load that never finishes is the offline screen, never a spinner that goes on.
  const mine = world();
  mine.stall = (url) => url.startsWith(CLOUD);
  const opening = mine.home.show();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  await mine.later(OPEN_MS);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mine.home.view().screen, "offline");
  await opening;
});

test("Remove from list on this computer's screen: the Admin first, then the window goes on without that Cloud; the Admin's no keeps the screen", async () => {
  const w = world({ journal: null, state: { ...connected({ status: "stopped" }), clouds: [ENDED_HOME, CLIENT_A] }, url: `${LOCAL}/` });
  await w.home.openCloud();
  w.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  w.removeAnswer = "refused";
  assert.equal(await w.home.remove(), "refused");
  assert.equal(w.home.view().screen, "ended", "refused: the screen stays");
  w.removeAnswer = "removed";
  assert.equal(await w.home.remove(), "removed");
  assert.deepEqual(w.hides, ["c-home", "c-home"]);
  assert.deepEqual([w.local.at(-1), w.home.asking()], [true, false], "this computer's own page again");
  assert.deepEqual(w.fetched, [], "still nothing looked up");
  // Removed elsewhere (the rail's menu, another device) while its screen shows: the window leaves that screen.
  const elsewhere = world({ journal: null, state: { ...connected({ status: "stopped" }), clouds: [ENDED_HOME, CLIENT_A] }, url: `${LOCAL}/` });
  await elsewhere.home.openCloud();
  elsewhere.url = `${LOCAL}${HOME_SCREEN_PATH}`;
  elsewhere.state = { ...elsewhere.state, clouds: [CLIENT_A] };
  await elsewhere.home.changed();
  assert.deepEqual([elsewhere.local.at(-1), elsewhere.home.asking(), elsewhere.fetched], [true, false, []]);
  // Another Cloud of their own: out of the switcher at once, and the window goes home.
  const other = world({ state: { ...connected(), clouds: [{ ...CLIENT_A, status: "ended", removable: true }] } });
  await other.home.show({ place: { cloud: "c-a" } });
  assert.equal(await other.home.remove(), "removed");
  assert.deepEqual([other.hides, other.dropped], [["c-a"], ["c-a"]]);
  assert.deepEqual(other.went.at(-1), [CLOUD, CLOUD], "My Cloud, home");
  // Nothing is asked of a Cloud the session doesn't say may be removed, or from any other screen.
  const kept = world({ state: { ...connected(), clouds: [{ ...CLIENT_A, status: "ended" }] } });
  await kept.home.show({ place: { cloud: "c-a" } });
  assert.equal(await kept.home.remove(), "unsupported");
  const running = world({ state: { ...connected(), clouds: [{ ...CLIENT_A, removable: true }] } });
  await running.home.show({ place: { cloud: "c-a" } });
  assert.equal(await running.home.remove(), "unsupported");
  assert.deepEqual([kept.hides, running.hides], [[], []]);
  // Only this computer's screen asks.
  const handlers = new Map();
  installHomeWindowIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} }, homeWindow: w.home, cloudPage: () => null });
  w.url = `${CLOUD}/`;
  assert.throws(() => handlers.get("home:remove")({ sender: w.contents, senderFrame: w.contents.mainFrame }), /only available/);
});

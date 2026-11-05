import assert from "node:assert/strict";
import test from "node:test";

import { homeOf, noWayHome } from "./home-window.mjs";
import { ACCOUNT, ACME, CLIENT, CLIENT_A, CLOUD, connected, done, LOCAL, world } from "./fixtures/home-window-world.mjs";

// The window of a computer whose bots moved, when nobody here can reach them (clean-workspace.mjs): the clean workspace opens
// in place of the sign-in screen, and a person who can reach them never gets it, whatever is wrong with the connection.
function cleanSide() {
  const side = { on: false, enters: 0, leaves: 0, fails: false, order: [],
    active: () => side.on,
    enter: async () => { side.enters++; side.order.push("enter"); if (side.fails) return false; side.on = true; return true; },
    leave: async () => { side.leaves++; side.order.push("leave"); side.on = false; return true; } };
  return side;
}
const signedOut = { status: "signed-out" };
const other = () => ({ ...connected(), account: { id: "acct-2", email: "b@example.test" } });

test("the clean workspace is for nobody signed in, or an account with no way to the Cloud; nothing else", () => {
  const cases = [
    ["signed out", { journal: done(), state: signedOut }, true],
    ["no sign-in at all", { journal: done(), state: null }, true],
    ["a sign-in on its way", { journal: done(), state: { status: "connecting" } }, true],
    ["another account", { journal: done(), state: other() }, true],
    ["another account, with the Admin not answering", { journal: done(), state: { status: "unavailable", account: { id: "acct-2" } } }, true],
    ["a freeze for another Cloud", { frozenCloud: "https://omb-t-2.fly.dev", state: connected() }, true],
    ["signed in, with no Cloud a freeze can name", { frozenCloud: true, state: { status: "connected", account: ACCOUNT, machine: null } }, true],
    ["a sign-in still being read", { journal: done(), state: { status: "signed-out", message: "restoring" } }, false],
    ["the owner", { journal: done(), state: connected() }, false],
    ["the owner's sign-in ended", { journal: done(), state: { status: "reauth-required", account: ACCOUNT } }, false],
    ["the Admin not answering", { journal: done(), state: { status: "unavailable", account: ACCOUNT } }, false],
    ["the Admin not answering, and no Cloud a freeze can name", { frozenCloud: true, state: { status: "unavailable", account: ACCOUNT } }, false],
    ["never moved", { state: signedOut }, false],
  ];
  for (const [name, input, expected] of cases) assert.equal(noWayHome(homeOf(input), input.state), expected, name);
});

test("signed out: the clean workspace opens on this computer, never the sign-in screen, and nothing asks the Cloud or the Admin", async () => {
  const clean = cleanSide(), w = world({ clean, state: signedOut, url: "" });
  await w.home.show();
  assert.equal(clean.enters, 1);
  assert.deepEqual(w.local, [true], "this computer's page, with no window page to leave");
  assert.deepEqual([w.went, w.fetched, w.pairs], [[], [], 0]);
  assert.equal(w.home.cloudOrigin(), null);
  assert.equal(w.home.current().clean, true);
  assert.equal(w.home.current().kind, "computer");
});

test("another account with no way to that Cloud gets the same, and the journal's Cloud is never asked", async () => {
  const clean = cleanSide(), w = world({ clean, state: other() });
  await w.home.show();
  assert.equal(clean.enters, 1);
  assert.deepEqual([w.went, w.fetched, w.pairs], [[], [], 0]);
  assert.equal(w.home.current().other, true);
});

test("it survives a restart: a new launch with the same journal, or only the freeze marker, opens it again", async () => {
  for (const setup of [{ state: signedOut }, { state: signedOut, journal: null, marker: { frozen: true, cloud: CLOUD } }, { state: signedOut, journal: null, marker: { frozen: true } }]) {
    const clean = cleanSide(), w = world({ clean, ...setup });
    await w.home.show();
    assert.equal(clean.enters, 1, JSON.stringify(setup));
    assert.deepEqual(w.went, []);
  }
});

test("signing back in as the owner goes to that Cloud as ever, with this computer's own copy running first", async () => {
  const clean = cleanSide(), w = world({ clean, state: signedOut });
  await w.home.show();
  w.state = connected();
  await w.home.changed();
  assert.deepEqual(clean.order, ["enter", "leave"]);
  assert.equal(clean.on, false);
  assert.deepEqual(w.went, [[CLOUD, CLOUD]]);
  assert.equal(w.home.cloudOrigin(), CLOUD);
  assert.equal(w.home.current().clean, undefined);
});

test("signed in and the Cloud doesn't answer: the normal can't-be-reached screen, never the clean workspace, so nobody thinks their bots are gone", async () => {
  const clean = cleanSide(), w = world({ clean, state: signedOut });
  await w.home.show();
  w.state = connected();
  w.cloud.down = true;
  await w.home.changed();
  assert.equal(clean.on, false);
  assert.equal(w.home.view().screen, "offline");
  assert.equal(clean.enters, 1, "it isn't opened again");
  w.state = { status: "unavailable", account: ACCOUNT };
  await w.home.show();
  assert.equal(clean.enters, 1, "nor when the Admin doesn't answer either");
  assert.equal(w.home.view().screen, "offline");
});

test("a launch while the sign-in is still being read never opens it", async () => {
  const clean = cleanSide(), w = world({ clean, state: { status: "signed-out", message: "restoring" } });
  await w.home.show();
  assert.equal(clean.enters, 0);
  assert.equal(w.home.view().screen, "signin");
});

test("a sign-in that ended keeps today's Sign in screen: that person didn't choose to leave, and their bots are one sign-in away", async () => {
  const clean = cleanSide(), w = world({ clean, state: { status: "reauth-required", account: ACCOUNT } });
  w.cloud.signedIn = false;
  await w.home.show();
  assert.equal(clean.enters, 0);
  assert.equal(w.home.view().screen, "signin");
});

test("the clean workspace that can't start is the sign-in screen, as before", async () => {
  const clean = cleanSide(), w = world({ clean, state: other() });
  clean.fails = true;
  await w.home.show();
  assert.deepEqual(w.home.view(), { screen: "signin", other: true });
  assert.deepEqual(w.local, []);
});

test("without a clean workspace (an app that can't sign in here), nothing changes", async () => {
  const w = world({ state: signedOut });
  await w.home.show();
  assert.equal(w.home.current().kind, "signin");
  assert.equal(w.home.view().screen, "signin");
});

test("signed out with a place remembered: the clean workspace opens, and the place is still there once they're back", async () => {
  const remembered = { team: ACME.id, name: ACME.name, origin: "https://omb-u-acme.fly.dev" };
  const clean = cleanSide(), w = world({ clean, state: signedOut, remembered });
  await w.home.show();
  assert.equal(clean.enters, 1);
  assert.deepEqual(w.remembers, []);
  assert.deepEqual(w.teamPairs, []);
  assert.deepEqual(w.went, []);
});

test("another account with a Cloud of its own: that Cloud opens, with no clean workspace, and the frozen copy stays frozen", async () => {
  const clean = cleanSide(), w = world({ clean, state: { ...other(), machine: { status: "ready", origin: CLIENT } } });
  await w.home.show();
  assert.equal(clean.enters, 0);
  assert.equal(w.home.current().origin, CLIENT);
  assert.equal(w.went.at(-1)?.[1], CLIENT);
});

test("from the clean workspace, another Cloud of this account's own, or a team, opens as for anyone, and the frozen copy stays stopped", async () => {
  const mine = { ...other(), machine: null, clouds: [{ ...CLIENT_A, id: "c-b", primary: false }] };
  const clean = cleanSide(), w = world({ clean, state: mine });
  await w.home.show();
  assert.equal(clean.enters, 1);
  await w.home.show({ place: { cloud: "c-b" } });
  assert.equal(w.went.at(-1)?.[1], CLIENT);
  assert.equal(clean.on, true);
  assert.equal(clean.leaves, 0);
});

test("the Sign in that switches account ends this sign-in first, as the screen's did", async () => {
  const clean = cleanSide(), w = world({ clean, state: other() });
  await w.home.show();
  await w.home.signIn();
  assert.deepEqual(w.signIns, ["out", "begin"]);
  w.signIns.length = 0;
  const owner = world({ clean: cleanSide(), state: connected() });
  await owner.home.signIn();
  assert.deepEqual(owner.signIns, [], "still good: it only looks again");
});

test("signing out of a moved computer's Cloud leaves it for the clean workspace at once", async () => {
  const clean = cleanSide(), w = world({ clean, state: connected(), url: `${CLOUD}/` });
  await w.home.show();
  assert.equal(clean.enters, 0);
  w.state = signedOut;
  await w.home.changed();
  assert.equal(clean.enters, 1);
  assert.deepEqual(w.local.at(-1), true, "the window leaves the Cloud's page");
  assert.equal(w.url, `${LOCAL}/`);
});

test("the move's word changing while nobody's signed in moves the window too, both ways", async () => {
  const clean = cleanSide(), w = world({ clean, journal: null, state: signedOut });
  await w.home.show();
  assert.equal(clean.enters, 0, "never moved: this computer as ever");
  w.journal = done();
  await w.home.changed();
  assert.equal(clean.enters, 1);
  assert.equal(clean.on, true);
  w.journal = { ...done(), phase: "back" };
  await w.home.changed();
  assert.equal(clean.on, false, "home again: this computer's own copy, not the clean workspace");
  assert.equal(w.home.current().clean, undefined);
});

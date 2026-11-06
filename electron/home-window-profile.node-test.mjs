import assert from "node:assert/strict";
import test from "node:test";

import { ACCOUNT, CLOUD, connected, LOCAL, world } from "./fixtures/home-window-world.mjs";

// This Mac on the rail while My Cloud is home (clean-workspace.mjs `open`): the window shows a profile of this computer's own,
// My Cloud is one click away, and a launch still opens My Cloud.
function profiles() {
  const side = { running: "copy", opened: [], enters: 0, leaves: 0, fails: false,
    active: () => side.running !== "copy",
    profile: () => (side.running.startsWith("profile:") ? side.running.slice("profile:".length) : null),
    open: async (id) => { side.opened.push(id); if (side.fails) return false; side.running = `profile:${id}`; return true; },
    enter: async () => { side.enters++; if (side.running === "copy") side.running = "clean"; return true; },
    leave: async () => { side.leaves++; side.running = "copy"; return true; } };
  return side;
}

test("This Mac from the rail: the profile opens on this computer's page, and My Cloud is one click back with the profile still running", async () => {
  const clean = profiles(), w = world({ clean });
  await w.home.show();
  assert.deepEqual(w.went, [[CLOUD, CLOUD]]);
  w.url = `${CLOUD}/`;
  assert.equal(await w.home.openProfile("default"), true);
  assert.deepEqual(clean.opened, ["default"]);
  assert.deepEqual(w.local, [true], "the window leaves My Cloud for this computer's page");
  assert.equal(w.home.profile(), "default");
  assert.equal(w.home.cloudOrigin(), CLOUD, "My Cloud is still home");
  await w.home.show({ place: "cloud" });
  assert.deepEqual(w.went, [[CLOUD, CLOUD], [CLOUD, CLOUD]]);
  assert.equal(w.home.profile(), null);
  assert.equal(clean.leaves, 0, "the profile keeps running, so This Mac is one click again");
  assert.equal(clean.profile(), "default");
  assert.equal(await w.home.openProfile("default"), true);
  assert.deepEqual(w.local, [true, true]);
  assert.deepEqual(clean.opened, ["default", "default"]);
});

test("the default stays My Cloud: a launch after using This Mac opens My Cloud, never the profile", async () => {
  const clean = profiles(), w = world({ clean });
  await w.home.show();
  await w.home.openProfile("default");
  const next = world({ clean });
  await next.home.show();
  assert.deepEqual(next.went, [[CLOUD, CLOUD]]);
  assert.deepEqual(next.local, []);
  assert.equal(next.home.profile(), null);
});

test("it stays on screen through the sign-in's changes and the window's own retries, until the person picks a place", async () => {
  const clean = profiles(), w = world({ clean });
  await w.home.show();
  w.url = `${CLOUD}/`;
  await w.home.openProfile("default");
  for (const again of [() => w.home.changed(), () => w.home.retry(), () => w.home.show()]) await again();
  assert.deepEqual(w.went, [[CLOUD, CLOUD]], "nothing pulls the window back to My Cloud");
  assert.equal(w.local[0], true);
  assert.ok(w.local.length > 1 && w.local.slice(1).every((leaving) => leaving === false), "and nothing reloads the page it is on");
  assert.equal(w.home.profile(), "default");
});

test("only while My Cloud is home: signed out, another account or a computer that never moved never opens it from here", async () => {
  for (const setup of [{ state: { status: "signed-out" } }, { state: { ...connected(), account: { id: "acct-2", email: "b@example.test" } } }, { journal: null }]) {
    const clean = profiles(), w = world({ clean, ...setup });
    await w.home.show();
    assert.equal(await w.home.openProfile("default"), false, JSON.stringify(setup));
    assert.deepEqual(clean.opened, [], JSON.stringify(setup));
  }
  assert.equal(await world({ clean: null }).home.openProfile("default"), false, "an app with no profiles");
});

test("a profile that can't open leaves the window on My Cloud", async () => {
  const clean = profiles(), w = world({ clean });
  clean.fails = true;
  await w.home.show();
  assert.equal(await w.home.openProfile("default"), false);
  assert.equal(new URL(w.url).origin, CLOUD);
  assert.deepEqual(w.local, []);
  assert.equal(w.home.profile(), null);
});

test("signing out from the profile ends it as the place on screen: the next sign-in opens My Cloud", async () => {
  const clean = profiles(), w = world({ clean });
  await w.home.show();
  await w.home.openProfile("default");
  w.state = { status: "signed-out" };
  await w.home.changed();
  assert.equal(w.home.profile(), null);
  w.state = { status: "connected", account: ACCOUNT, machine: { status: "ready", origin: CLOUD } };
  await w.home.changed();
  assert.deepEqual(w.went.at(-1), [CLOUD, CLOUD]);
  assert.equal(new URL(w.url).origin === LOCAL, false);
});

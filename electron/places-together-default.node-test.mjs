// This computer and My Cloud together, on by default (places-together.mjs): the notice, the person's own choices, the
// switch file, and which workspace joins. The rest of the switch is in places-together.node-test.mjs.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { CLOUD_EVERY_MS, createPlacesTogether, installPlacesTogether, readTogether, START_QUIET_MS, togetherComputer, togetherPrefFile } from "./places-together.mjs";

const CLOUD = "https://mine.cloud.test";
const answer = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (name) => headers[name] ?? null }, json: async () => body, body: { cancel: async () => {} } });
const bot = (id, name, over = {}) => ({ id, threadId: `t-${id}`, name, title: "", color: "blue", mascotBody: "classic", ...over });
const ai = (displayName, snapshot = {}) => ({ instanceId: displayName.toLowerCase(), driverKind: "claude", displayName, snapshot: { state: "available", ...snapshot } });
const settle = () => new Promise((done) => setImmediate(done));

function setup(over = {}) {
  const f = {
    saved: "saved" in over ? over.saved : { v: 1, on: true }, asked: [], sent: [], opened: [], changes: 0, tick: null, cleared: 0, clock: 1_000,
    cloud: { origin: CLOUD, account: "acct-a", asleep: false }, computer: true, shown: "computer", focused: true, napped: 0, checks: 0, admin: true, timeouts: [], opening: new Promise(() => {}),
    bots: { computer: [bot("scout", "Scout")], cloud: [bot("scout", "Scout"), bot("nova", "Nova", { unread: true })] },
    reply: { computer: null, cloud: null },
    instances: { computer: [ai("Claude"), ai("Codex")], cloud: [ai("Claude"), ai("Included AI")] }, makes: { computer: true, cloud: true },
  };
  f.together = createPlacesTogether({
    pref: { read: () => f.saved, write: (value) => { f.saved = value; } },
    cloud: () => f.cloud, computer: () => f.computer,
    powerChecked: async () => { f.checks += 1; f.asked.push(["admin"]); return typeof f.admin === "function" ? f.admin() : f.admin; },
    local: async (route, init) => { f.asked.push(["computer", route, init]); return f.reply.computer ?? answer(200, route === "/api/instances" ? { instances: f.instances.computer } : { bots: f.bots.computer, ...(f.makes.computer ? { together: { newBot: true } } : {}) }); },
    cloudFetch: async (url, init) => { f.asked.push(["cloud", url, init]); return typeof f.reply.cloud === "function" ? f.reply.cloud() : f.reply.cloud ?? answer(200, url.endsWith("/api/instances") ? { instances: f.instances.cloud } : { bots: f.bots.cloud, ...(f.makes.cloud ? { together: { newBot: true } } : {}) }); },
    napped: () => { f.napped += 1; },
    shown: () => f.shown, focused: () => f.focused, openPlace: (home) => { f.opened.push(home); return f.opening; },
    send: (channel, value) => { f.sent.push([channel, value]); },
    changed: () => { f.changes += 1; },
    now: () => f.clock,
    setTimer: (run, ms) => { f.tick = { run, ms }; return {}; }, clearTimer: () => { f.cleared += 1; },
    later: (run, ms) => { const timer = { run, ms, cancelled: false }; f.timeouts.push(timer); return timer; }, cancelLater: (timer) => { if (timer) timer.cancelled = true; },
    startQuietMs: 0,
    ...over.deps,
  });
  /** The next read of My Cloud is due: a minute has passed. */
  f.later = () => { f.clock += CLOUD_EVERY_MS; };
  f.cloudAsked = (route = "") => f.asked.filter(([side, url]) => side === "cloud" && url.endsWith(route)).length;
  return f;
}


/** A person signed in, with "Let your Clouds run commands on this computer" as `lent`, and what the notice's switch and the
 * person's own turn on did to it. */
function withCommands(over = {}, lent = false) {
  const c = { lent, set: [], turnedOn: 0 };
  const f = setup({ ...over, deps: { ...over.deps, commands: { on: () => c.lent, set: (on) => { c.set.push(on); c.lent = on; } }, turnedOn: () => { c.turnedOn += 1; c.lent = true; } } });
  return { f, c };
}

test("on by default: a person who never chose has it on from the moment this computer's page showed the notice, and not before", async () => {
  const { f, c } = withCommands({ saved: null });
  assert.equal(f.together.on(), false);
  assert.equal(f.together.switchedOff(), true, "the link stays off too");
  assert.equal(f.together.chosen(), null);
  await f.together.refresh("cloud");
  assert.deepEqual(f.asked, [], "nothing is read before the notice");
  assert.equal(f.together.noticeShown("cloud"), false, "My Cloud's page never turns the default on");
  assert.equal(f.together.on(), false);
  assert.equal(f.together.noticeShown("computer"), true);
  assert.equal(f.together.on(), true);
  assert.equal(f.together.switchedOff(), false);
  assert.equal(f.together.chosen(), null, "still never chosen: the person's own choice stays theirs to make");
  assert.deepEqual(f.saved, { v: 1, noticed: { "acct-a": 1_000 } }, "no `on`: an older app reads the file as off");
  assert.equal(f.together.state("computer").notice, true, "the notice stays due until it is closed");
  await f.together.refresh("cloud");
  assert.equal(f.cloudAsked("/api/bots?messages=3"), 1, "now My Cloud's bots are read, under the list's own rules");
  assert.deepEqual([c.set, c.turnedOn, c.lent], [[], 0, false], "the default never lets My Cloud run commands here");
});

test("the notice shows once: closed, it never shows again, after a restart too, and the default stays on", () => {
  const { f } = withCommands({ saved: null });
  f.together.noticeShown("computer");
  const reopened = withCommands({ saved: f.saved }).f;
  assert.equal(reopened.together.state("computer").notice, true, "shown but never closed (the app quit first): it shows again");
  assert.equal(reopened.together.on(), true);
  f.together.noticeDone("computer");
  assert.equal(f.together.state("computer").notice, undefined);
  const later = withCommands({ saved: f.saved }).f;
  assert.equal(later.together.state("computer").notice, undefined, "closed: never again");
  assert.equal(later.together.on(), true, "and still on");
  assert.equal(later.together.noticeShown("computer"), false, "a stale page cannot show it again");
});

test("a person who chose keeps their choice: off stays off, on stays on, and neither sees the notice", async () => {
  const off = withCommands({ saved: { v: 1, on: false } });
  assert.equal(off.f.together.state("computer").notice, undefined);
  assert.equal(off.f.together.noticeShown("computer"), false);
  assert.equal(off.f.together.on(), false);
  await off.f.together.refresh("cloud");
  assert.deepEqual(off.f.asked, []);
  assert.deepEqual(off.f.saved, { v: 1, on: false });
  const on = withCommands({ saved: { v: 1, on: true } });
  assert.equal(on.f.together.state("computer").notice, undefined);
  assert.equal(on.f.together.on(), true);
  assert.equal(on.f.together.chosen(), true);
  assert.deepEqual(on.c.set, []);
});

test("touching the switch anywhere ends the notice: off in the notice gives back today's two lists at once and lends nothing", async () => {
  const { f, c } = withCommands({ saved: null });
  f.together.noticeShown("computer");
  await f.together.refresh("cloud");
  assert.equal(f.together.state("computer").other.bots.length, 2);
  f.together.noticeDone("computer");
  const state = f.together.set("computer", false);
  assert.deepEqual(state, { v: 1, available: true, on: false, here: "computer", other: null, commands: false }, "the other place's rows are gone and no notice is due");
  assert.equal(f.saved.on, false);
  assert.equal(f.together.switchedOff(), true, "the link ends");
  assert.deepEqual([c.set, c.turnedOn], [[], 0]);
  const restarted = withCommands({ saved: f.saved }).f;
  assert.equal(restarted.together.on(), false, "the person's off is kept");
  assert.equal(restarted.together.state("computer").notice, undefined);
  const settings = withCommands({ saved: null });
  settings.f.together.set("computer", false);
  assert.equal(settings.f.together.state("computer").notice, undefined, "turned off in Settings before the notice ever showed: it never shows");
  assert.equal(settings.f.together.noticeShown("computer"), false);
});

test("running commands: the notice's own switch, read from lending itself and kept live, as the person has it; the person's own turn on in Settings still lends it", async () => {
  const had = withCommands({ saved: null }, true);
  assert.equal(had.f.together.state("computer").commands, true, "a grant the person had shows as on");
  had.f.together.noticeShown("computer");
  assert.equal(had.c.lent, true, "and stays as it was");
  const never = withCommands({ saved: null });
  never.f.together.noticeShown("computer");
  assert.equal(never.f.together.state("computer").commands, false);
  assert.equal(await never.f.together.setCommands("computer", true), true);
  assert.deepEqual(never.c.set, [true]);
  assert.equal(await never.f.together.setCommands("computer", false), false);
  assert.deepEqual(never.c.set, [true, false]);
  await assert.rejects(never.f.together.setCommands("cloud", true), /this computer's page/);
  const gone = withCommands({ saved: null, deps: { computer: () => null } });
  await assert.rejects(gone.f.together.setCommands("computer", true), /this computer's page/, "not offered: not turned here");
  const declined = setup({ saved: null, deps: { commands: { on: () => false, set: async () => false } } });
  assert.equal(await declined.together.setCommands("computer", true), false, "Cancel in the icon's own question: still off, as lending says");
  const live = withCommands({ saved: null });
  live.f.together.noticeShown("computer");
  const changes = live.f.changes;
  live.c.lent = true;
  live.f.together.commandsChanged(true);
  assert.equal(live.f.changes, changes + 1, "turned on from the icon's menu while the notice is up: the page is told");
  assert.equal(live.f.together.state("computer").commands, true, "and reads lending's own word, not a copy");
  live.f.together.commandsChanged(true);
  assert.equal(live.f.changes, changes + 1, "the same word again tells nothing");
  const again = withCommands({ saved: null });
  again.f.together.noticeShown("computer");
  again.f.together.set("computer", false, { listOnly: true });
  again.f.together.set("computer", true, { listOnly: true });
  assert.equal(again.c.turnedOn, 0, "off and on again in the notice: the joining only, never the grant");
  const byHand = withCommands({ saved: null });
  byHand.f.together.set("computer", true);
  assert.equal(byHand.c.turnedOn, 1, "turned on in Settings, whose words say so, it comes with the grant as before");
  assert.equal(byHand.f.together.state("computer").notice, undefined);
});

test("no read of My Cloud at the app's start: the first waits START_QUIET_MS, whatever a page asks", async () => {
  const f = setup({ deps: { startQuietMs: START_QUIET_MS } });
  f.together.state("computer");
  await f.together.refresh("cloud");
  await settle();
  assert.equal(f.asked.filter(([side]) => side !== "computer").length, 0, "neither the Admin nor My Cloud");
  f.clock += START_QUIET_MS;
  await f.together.refresh("cloud");
  assert.deepEqual(f.asked.map(([side]) => side), ["admin", "cloud"]);
  assert.equal(START_QUIET_MS >= 10_000, true);
});

test("on by default, a sleeping Cloud is never asked or woken: its list says asleep, with no error", async () => {
  const { f } = withCommands({ saved: null });
  f.cloud.asleep = true;
  f.together.noticeShown("computer");
  await f.together.refresh("cloud");
  f.later();
  await f.together.refresh("cloud");
  assert.deepEqual(f.asked, [], "not even the Admin is asked while it is known asleep");
  assert.deepEqual(f.together.state("computer").other, { home: "cloud", state: "asleep", bots: [] });
});

test("the default is per account: another account signed in here has not seen the notice, so it is off for them", () => {
  const { f } = withCommands({ saved: null });
  f.together.noticeShown("computer");
  f.cloud = { ...f.cloud, account: "acct-b" };
  assert.equal(f.together.on(), false);
  assert.equal(f.together.state("computer").notice, true);
  f.cloud = { ...f.cloud, account: null };
  assert.equal(f.together.noticeShown("computer"), false, "no account: nothing is noted");
});

test("a switch file that can't be read is off and shows no notice, and leaves a link alone; one that makes no sense is off", () => {
  const busy = setup({ deps: { pref: { read: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, write: () => {} } } });
  assert.equal(busy.together.on(), false);
  assert.equal(busy.together.state("computer").notice, undefined);
  assert.equal(busy.together.switchedOff(), false);
  const missing = () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  assert.equal(readTogether(missing).choice, null);
  assert.equal(readTogether(() => ({ v: 2, on: true })).choice, false);
  assert.equal(readTogether(() => ({ v: 1, on: "yes" })).choice, false);
  assert.equal(readTogether(() => ({ v: 1, noticed: {} })).choice, null);
});

test("which of this computer's workspaces joins My Cloud: its own server with this computer home; the workspace that runs with My Cloud home; none for the frozen copy or a server of their own as home", () => {
  assert.equal(togetherComputer({ cloudHome: false, ownHome: false, profile: null, running: "/data/omb" }), "computer:/data/omb");
  assert.equal(togetherComputer({ cloudHome: true, ownHome: false, profile: "default", running: "/data/omb-profiles/default" }), "profile:default");
  assert.equal(togetherComputer({ cloudHome: true, ownHome: false, profile: null, running: "/data/omb" }), null, "the frozen copy a move left admits no turns");
  assert.equal(togetherComputer({ cloudHome: true, ownHome: false, profile: null, running: "/data/omb-clean" }), null, "the clean workspace");
  assert.equal(togetherComputer({ cloudHome: false, ownHome: true, profile: null, running: "/data/omb" }), null);
  assert.equal(togetherComputer({ cloudHome: false, ownHome: false, frozen: true, profile: null, running: "/data/omb" }), null,
    "the freeze marker is there before the home window knows My Cloud is home: the frozen copy still never joins");
  assert.equal(togetherComputer({ cloudHome: false, ownHome: false, frozen: true, profile: null, running: "/data/omb-clean" }), null, "nor the clean workspace (signed in with no way to the moved Cloud)");
  assert.equal(togetherComputer({ cloudHome: false, ownHome: false, frozen: true, profile: "default", running: "/data/omb-profiles/default" }), "profile:default");
});

test("My Cloud as home: offered (and on by default) while a workspace of this computer's own runs; another one has lists of its own; the frozen copy has none", async () => {
  let here = "profile:default";
  const { f } = withCommands({ saved: null, deps: { computer: () => here } });
  assert.equal(f.together.state("computer").available, true);
  assert.equal(f.together.state("computer").notice, true);
  f.together.noticeShown("computer");
  await f.together.refresh("cloud");
  assert.deepEqual(f.together.state("computer").other.bots.map((row) => row.id), ["scout", "nova"]);
  assert.equal(f.together.state("cloud").other.bots.length, 0, "My Cloud's page asks for this computer's rows as before");
  const changes = f.changes;
  here = "profile:work";
  assert.equal(f.together.state("computer").other.state, "loading", "another workspace: the last one's list is dropped");
  assert.equal(f.changes > changes, true);
  here = null;
  assert.deepEqual(f.together.state("computer"), { v: 1, available: false, on: true, here: "computer", other: null }, "the frozen copy runs: nothing is offered or read");
  assert.equal(f.together.on(), false);
  f.asked.length = 0;
  await f.together.refresh("computer");
  assert.deepEqual(f.asked, []);
});

test("the rail turns the same switch from a circle's menu, only from the window's rail, and turning it on there switches the list alone, never lending commands", () => {
  const handlers = new Map();
  const { f, c } = withCommands({ saved: null });
  installPlacesTogether({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, asking: (event) => event.page, rail: (event) => event.rail === true, together: f.together });
  assert.throws(() => handlers.get("places-together:rail-set")({ page: "local" }, true), /Only the window's rail/);
  assert.equal(handlers.get("places-together:rail-set")({ rail: true }, true), true);
  assert.deepEqual([f.together.chosen(), c.turnedOn, c.set], [true, 0, []], "the rail's row never lets My Cloud run commands here");
  assert.equal(handlers.get("places-together:rail-set")({ rail: true }, false), false);
  assert.equal(f.saved.on, false);
  assert.deepEqual(f.together.offered(), { on: false });
  const none = withCommands({ saved: null, deps: { computer: () => null } });
  assert.equal(none.f.together.offered(), null, "where it is not offered the circles show nothing");
});

test("a switch file this app does not understand (another shape, a newer version) is left alone: no default, no notice, the link untouched, never written over", () => {
  for (const odd of [{ v: 2, on: true }, [], "on", { v: 1, on: "yes" }]) {
    const writes = [];
    const f = setup({ saved: odd, deps: { pref: { read: () => odd, write: (value) => { writes.push(value); } } } });
    const state = f.together.state("computer");
    assert.equal(state.on, false, JSON.stringify(odd));
    assert.equal(state.notice, undefined, `no notice for ${JSON.stringify(odd)}`);
    assert.equal(f.together.noticeShown("computer"), false);
    f.together.noticeDone("computer");
    if (!(Array.isArray(odd) || typeof odd === "string" || odd.v !== 1)) continue;
    assert.equal(f.together.switchedOff(), false, "the link is left as it is");
    assert.throws(() => f.together.set("computer", true), /not one this app can change/);
    assert.deepEqual(writes, [], `never written over: ${JSON.stringify(odd)}`);
  }
});

test("the notice says this computer's workspace now starts with the app only to a person whose home is My Cloud", () => {
  const cloudHome = setup({ saved: null, deps: { computer: () => "profile:default" } });
  assert.equal(cloudHome.together.state("computer").profileHome, true);
  const computerHome = setup({ saved: null, deps: { computer: () => "computer:/data" } });
  assert.equal(computerHome.together.state("computer").profileHome, undefined);
});

test("a switch file that is not JSON at all is off and quiet until the person turns the switch in Settings, which keeps the bad file beside it and writes a good one; a newer version's file stays untouched", async (t) => {
  const { mkdtempSync, readdirSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "together-pref-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "places-together.json");
  writeFileSync(path, "{\"v\":1,\"on\":tr");
  const f = setup({ deps: { pref: togetherPrefFile(path, undefined, () => 42) } });
  assert.equal(f.together.state("computer").notice, undefined);
  assert.equal(f.together.on(), false);
  assert.throws(() => f.together.set("computer", true, { listOnly: true }), /not one this app can change/, "the rail and the notice never repair it");
  assert.equal(read(path, "utf8"), "{\"v\":1,\"on\":tr");
  f.together.set("computer", true);
  assert.equal(read(join(dir, "places-together.json.unreadable-42"), "utf8"), "{\"v\":1,\"on\":tr", "the bad file is kept beside it");
  assert.deepEqual(JSON.parse(read(path, "utf8")), { v: 1, on: true, choices: { "acct-a": true } });
  assert.equal(f.together.on(), true);
  writeFileSync(path, JSON.stringify({ v: 3, on: true }));
  const newer = setup({ deps: { pref: togetherPrefFile(path, undefined, () => 43) } });
  assert.throws(() => newer.together.set("computer", false), /not one this app can change/);
  assert.deepEqual(JSON.parse(read(path, "utf8")), { v: 3, on: true }, "a newer version's file is read only");
  assert.equal(readdirSync(dir).filter((name) => name.includes("unreadable")).length, 1);
});

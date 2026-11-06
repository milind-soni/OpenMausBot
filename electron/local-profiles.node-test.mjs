import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCleanWorkspace, DEFAULT_PROFILE, profileDir, profilesDir } from "./clean-workspace.mjs";
import { createLocalProfiles, createProfileRegistry, MAX_PROFILES, PROFILES_FILE, profileName, SETTLE_MS } from "./local-profiles.mjs";

/** This computer's data folder on disk, with the one server the app runs at a time (`running`), the real profile swap
 * (clean-workspace.mjs) over it, the registry beside it and the home window's side of a profile on screen. */
function computer(t, { home = "cloud", frozen = home === "cloud" } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "omb-profiles-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dataDir = join(parent, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  if (frozen) writeFileSync(join(dataDir, "moved.json"), JSON.stringify({ v: 1, at: 1, cloud: "https://omb-t-1.fly.dev" }));
  let clock = 1_000;
  const w = { dataDir, running: dataDir, swaps: [], home, shown: null, onScreen: "cloud", busy: [], trashed: [], trashFails: false, changes: 0, logs: [], waits: 0 };
  w.now = () => clock;
  w.clean = createCleanWorkspace({ dataDir: () => dataDir, running: () => w.running,
    swap: async (dir) => { w.swaps.push(dir); await new Promise((resolve) => setImmediate(resolve)); w.running = dir; w.onScreen = "local"; return { ok: true }; } });
  w.registry = createProfileRegistry({ dataDir: () => dataDir, now: w.now, random: () => "abc123" });
  w.profiles = createLocalProfiles({ registry: w.registry, clean: w.clean, dataDir: () => dataDir, home: () => w.home,
    window: {
      openProfile: async (id) => { if (w.beforeOpen) return w.beforeOpen(); const opened = await w.clean.open(id); if (opened) { w.shown = id; w.onScreen = "local"; } return opened; },
      profile: () => w.shown,
      showCloud: async () => { w.shown = null; w.onScreen = "cloud"; },
    },
    showLocal: () => { w.onScreen = "local"; }, onLocal: () => w.onScreen === "local",
    busy: async () => w.busy[0] ?? null,
    trash: async (dir) => { if (w.trashFails) throw new Error("no Trash here"); w.trashed.push(dir); rmSync(dir, { recursive: true, force: true }); },
    reserved: () => "This Mac", changed: () => { w.changes++; }, log: (line) => w.logs.push(line), now: w.now,
    sleep: async (ms) => { clock += ms; w.waits++; w.onWait?.(); } });
  w.file = () => join(profilesDir(dataDir), PROFILES_FILE);
  w.saved = () => JSON.parse(readFileSync(w.file(), "utf8"));
  return w;
}

test("a name is one line a person typed: trimmed, no control characters, at most 40 characters", () => {
  assert.equal(profileName("  Work \n stuff  "), "Work stuff");
  assert.equal(profileName("\u0007Bell"), "Bell");
  assert.equal(profileName("   "), null);
  assert.equal(profileName(42), null);
  assert.equal([...profileName("😀".repeat(60))].length, 40, "by characters, never splitting one");
});

test("This Mac is the registry's first entry before anything is written: a computer from before keeps its folder and its data", (t) => {
  const w = computer(t);
  mkdirSync(profileDir(w.dataDir, DEFAULT_PROFILE), { recursive: true });
  writeFileSync(join(profileDir(w.dataDir, DEFAULT_PROFILE), "bots.json"), "[\"made-there\"]");
  assert.deepEqual(w.registry.list().map(({ id, name, color }) => ({ id, name, color })), [{ id: "default", name: null, color: null }]);
  assert.equal(existsSync(w.file()), false, "reading writes nothing");
  const made = w.registry.create({ name: "Work", color: "green" });
  assert.equal(made.ok, true);
  assert.deepEqual(w.saved().profiles.map(({ id, name, color }) => ({ id, name, color })), [{ id: "default", name: null, color: null }, { id: "work", name: "Work", color: "green" }],
    "the first change writes This Mac down first, as it was");
  assert.equal(readFileSync(join(profileDir(w.dataDir, DEFAULT_PROFILE), "bots.json"), "utf8"), "[\"made-there\"]");
});

test("create, rename, colour and remove: names stay unique (This Mac's own name included), ids are folder names that never change", (t) => {
  const w = computer(t);
  const work = w.registry.create({ name: "  Work  ", color: "rose" });
  assert.deepEqual(work, { ok: true, profile: { id: "work", name: "Work", color: "rose", createdAt: 1_000 } });
  assert.deepEqual(w.registry.create({ name: "work" }), { ok: false, error: "taken" });
  assert.deepEqual(w.registry.create({ name: "this mac", reserved: "This Mac" }), { ok: false, error: "taken" }, "This Mac's name is This Mac's");
  assert.deepEqual(w.registry.create({ name: " " }), { ok: false, error: "name" });
  assert.equal(w.registry.create({ name: "Café ☕", color: "not-a-swatch" }).profile.id, "cafe", "a folder name from the name");
  assert.equal(w.registry.create({ name: "工作" }).profile.id, "w-abc123", "a name with no letters a folder can take");
  mkdirSync(profileDir(w.dataDir, "personal"), { recursive: true });
  assert.equal(w.registry.create({ name: "Personal" }).profile.id, "personal-abc123", "a folder already there is never reused");
  assert.equal(w.registry.get("cafe").color, null, "an unknown colour is none");
  assert.deepEqual(w.registry.rename("work", "Office"), { ok: true });
  assert.deepEqual(w.registry.rename("work", "café ☕"), { ok: false, error: "taken" });
  assert.deepEqual(w.registry.rename("work", ""), { ok: false, error: "name" });
  assert.deepEqual(w.registry.rename("gone", "X"), { ok: false, error: "gone" });
  assert.deepEqual(w.registry.rename(DEFAULT_PROFILE, "Home"), { ok: true }, "This Mac may take a name of its own");
  assert.deepEqual(w.registry.recolor("work", "violet"), { ok: true });
  assert.deepEqual(w.registry.recolor("work", null), { ok: true });
  assert.deepEqual(w.registry.get("work"), { id: "work", name: "Office", color: null, createdAt: 1_000 });
  assert.equal(w.registry.remove("work"), true);
  assert.equal(w.registry.remove("work"), false);
  assert.deepEqual(w.registry.list().map((entry) => entry.id), ["default", "cafe", "w-abc123", "personal-abc123"]);
  assert.equal(w.registry.remove(DEFAULT_PROFILE), true);
  assert.deepEqual(w.registry.list().map((entry) => entry.id), ["cafe", "w-abc123", "personal-abc123"], "This Mac removed stays removed");
});

test("a registry someone edited by hand: anything not a folder name is dropped, nothing reaches outside the profiles' folder", (t) => {
  const w = computer(t);
  mkdirSync(profilesDir(w.dataDir), { recursive: true });
  writeFileSync(w.file(), JSON.stringify({ v: 1, profiles: [{ id: "../.openmausbot", name: "Evil" }, { id: "work", name: "Work" }, { id: "work", name: "Again" }, { id: "Work2" }, null] }));
  assert.deepEqual(w.registry.list().map((entry) => entry.id), ["work"]);
  writeFileSync(w.file(), "not json");
  assert.deepEqual(w.registry.list().map((entry) => entry.id), ["default"]);
});

test(`at most ${MAX_PROFILES} workspaces`, (t) => {
  const w = computer(t);
  for (let at = 1; at < MAX_PROFILES; at++) assert.equal(w.registry.create({ name: `W${at}` }).ok, true);
  assert.deepEqual(w.registry.create({ name: "One more" }), { ok: false, error: "full" });
});

test("who sees which: once My Cloud is home every workspace, This Mac first; with no home the named ones only; another home none", (t) => {
  const w = computer(t);
  w.registry.create({ name: "Work", color: "green" });
  assert.deepEqual(w.profiles.places({ activeLocal: false }), [
    { id: "default", name: null, color: null, swatch: null },
    { id: "work", name: "Work", color: "teal", swatch: "green" },
  ]);
  w.home = "local";
  assert.deepEqual(w.profiles.places({ activeLocal: true }).map((row) => row.id), ["work"]);
  assert.equal(w.profiles.creatable(), true);
  w.home = null;
  assert.deepEqual(w.profiles.places({ activeLocal: true }), []);
  assert.equal(w.profiles.creatable(), false);
  assert.deepEqual(w.profiles.create({ name: "Lab" }), { outcome: "failed" });
});

test("switching once My Cloud is home: one runs at a time, the next one starts on its own folder, My Cloud never stops it", async (t) => {
  const w = computer(t);
  const work = w.profiles.create({ name: "Work" });
  assert.deepEqual(work, { outcome: "made", id: "work" });
  assert.equal(await w.profiles.open(DEFAULT_PROFILE), true);
  assert.deepEqual([w.running, w.shown], [profileDir(w.dataDir, DEFAULT_PROFILE), DEFAULT_PROFILE]);
  assert.deepEqual(w.profiles.places({ activeLocal: true }).filter((row) => row.active).map((row) => row.id), [DEFAULT_PROFILE]);
  writeFileSync(join(profileDir(w.dataDir, DEFAULT_PROFILE), "bots.json"), "[\"Scout\"]");
  assert.equal(await w.profiles.open("work"), true);
  assert.deepEqual(w.swaps, [profileDir(w.dataDir, DEFAULT_PROFILE), profileDir(w.dataDir, "work")], "This Mac's server stopped, Work's started");
  assert.equal(readFileSync(join(profileDir(w.dataDir, DEFAULT_PROFILE), "bots.json"), "utf8"), "[\"Scout\"]", "what was made in This Mac stays");
  assert.equal(existsSync(join(profileDir(w.dataDir, "work"), "bots.json")), false, "Work starts fresh");
  assert.equal(await w.profiles.open(DEFAULT_PROFILE), true);
  assert.equal(readFileSync(join(profileDir(w.dataDir, DEFAULT_PROFILE), "bots.json"), "utf8"), "[\"Scout\"]");
  assert.equal(JSON.parse(readFileSync(join(w.dataDir, "moved.json"), "utf8")).cloud, "https://omb-t-1.fly.dev", "the frozen copy stays frozen and never runs");
  assert.equal(w.swaps.includes(w.dataDir), false);
  assert.equal(await w.profiles.open("nope"), false, "only a workspace the registry has");
});

test("a switch waits for the work under way in the workspace it leaves, says so on the circle it opens, then goes", async (t) => {
  const w = computer(t);
  w.profiles.create({ name: "Work" });
  await w.profiles.open(DEFAULT_PROFILE);
  w.busy = [{ name: "Scout", what: "bot" }];
  let seen = null;
  w.onWait = () => { seen ??= w.profiles.places({ activeLocal: true }).find((row) => row.id === "work"); if (w.waits === 3) w.busy = []; };
  assert.equal(await w.profiles.open("work"), true);
  assert.equal(w.waits, 3, "it waited while Scout answered");
  assert.deepEqual(seen, { id: "work", name: "Work", color: null, swatch: null, settling: "Scout" });
  assert.equal(w.profiles.places({ activeLocal: true }).find((row) => row.id === "work").settling, undefined, "and the circle says nothing once it went");
  assert.equal(w.running, profileDir(w.dataDir, "work"));
});

test(`a switch waits at most ${SETTLE_MS / 1000} s: then the server stops as a quit stops it, and each cut turn says so there`, async (t) => {
  const w = computer(t);
  w.profiles.create({ name: "Work" });
  await w.profiles.open(DEFAULT_PROFILE);
  w.busy = [{ name: "Scout", what: "bot" }];
  assert.equal(await w.profiles.open("work"), true);
  assert.equal(w.waits, SETTLE_MS / 1000);
  assert.match(w.logs.at(-1), /work opens though Scout still works/);
});

test("nothing to wait for when the frozen copy runs: My Cloud's first This Mac opens at once", async (t) => {
  const w = computer(t);
  w.busy = [{ name: "never asked", what: "bot" }];
  assert.equal(await w.profiles.open(DEFAULT_PROFILE), true);
  assert.equal(w.waits, 0);
});

test("a second click takes over: the first switch's wait ends, and only the last place clicked opens", async (t) => {
  const w = computer(t);
  w.profiles.create({ name: "Work" });
  w.profiles.create({ name: "Personal" });
  await w.profiles.open(DEFAULT_PROFILE);
  w.busy = [{ name: "Scout", what: "bot" }];
  let second = null;
  w.onWait = () => { if (w.waits === 2) { w.busy = []; second = w.profiles.open("personal"); } };
  assert.equal(await w.profiles.open("work"), null, "taken over");
  assert.equal(await second, true);
  assert.deepEqual(w.swaps.slice(1), [profileDir(w.dataDir, "personal")], "Work never started");
  w.busy = [{ name: "Scout", what: "bot" }];
  w.waits = 0; w.onWait = () => { if (w.waits === 1) w.profiles.cancel(); };
  assert.equal(await w.profiles.open("work"), null, "My Cloud clicked meanwhile: nothing opens");
  assert.equal(w.running, profileDir(w.dataDir, "personal"));
  assert.equal(w.profiles.settling(), null);
});

test("with no home but this computer: This computer is the data folder as ever, and a workspace's switch stops it, and back", async (t) => {
  const w = computer(t, { home: "local" });
  w.onScreen = "local";
  w.profiles.create({ name: "Work" });
  assert.equal(await w.profiles.open("work"), true);
  assert.equal(w.running, profileDir(w.dataDir, "work"));
  assert.deepEqual(w.profiles.places({ activeLocal: true }), [{ id: "work", name: "Work", color: null, swatch: null, active: true }]);
  w.busy = [{ name: "Juno", what: "bot" }];
  w.onWait = () => { assert.deepEqual(w.profiles.settling(), { id: null, name: "Juno" }); w.busy = []; };
  assert.equal(await w.profiles.computer(), true);
  assert.equal(w.running, w.dataDir, "This computer's own server again");
  w.onScreen = "elsewhere";
  assert.equal(await w.profiles.open("work"), true);
  w.onScreen = "a server";
  assert.equal(await w.profiles.open("work"), true, "already running: the window comes back to it");
  assert.equal(w.onScreen, "local");
  assert.equal(await w.profiles.open(DEFAULT_PROFILE), false, "This Mac's profile isn't one here");
});

test("removing the workspace on screen: the window goes to My Cloud and its server stops first, then its folder goes to the Trash", async (t) => {
  const w = computer(t);
  w.profiles.create({ name: "Work" });
  await w.profiles.open("work");
  writeFileSync(join(profileDir(w.dataDir, "work"), "bots.json"), "[]");
  assert.deepEqual(await w.profiles.remove("work"), { outcome: "removed" });
  assert.equal(w.running, w.dataDir, "stopped before anything was removed");
  assert.equal(w.onScreen, "cloud");
  assert.deepEqual(w.trashed, [profileDir(w.dataDir, "work")]);
  assert.deepEqual(w.registry.list().map((entry) => entry.id), ["default"]);
  assert.deepEqual(await w.profiles.remove("work"), { outcome: "gone" });
});

test("removing the last one leaves My Cloud; one that never opened has no folder to keep; a missing Trash keeps the folder aside", async (t) => {
  const w = computer(t);
  w.profiles.create({ name: "Work" });
  assert.deepEqual(await w.profiles.remove("work"), { outcome: "removed" });
  assert.deepEqual(w.trashed, [], "never opened, nothing on disk");
  await w.profiles.open(DEFAULT_PROFILE);
  w.trashFails = true;
  assert.deepEqual(await w.profiles.remove(DEFAULT_PROFILE), { outcome: "removed" });
  assert.deepEqual([w.onScreen, w.profiles.places({ activeLocal: true })], ["cloud", []], "no workspace of this computer's own left: My Cloud");
  assert.equal(existsSync(profileDir(w.dataDir, DEFAULT_PROFILE)), false);
  assert.ok(readdirSync(profilesDir(w.dataDir)).some((name) => name.startsWith(".removed-default-")), "kept aside, never deleted outright");
});

test("removing the workspace on screen with no home: back on This computer, and the rail's rows go with it", async (t) => {
  const w = computer(t, { home: "local" });
  w.profiles.create({ name: "Work" });
  await w.profiles.open("work");
  assert.deepEqual(await w.profiles.remove("work"), { outcome: "removed" });
  assert.deepEqual([w.running, w.onScreen], [w.dataDir, "local"]);
  assert.deepEqual(w.profiles.places({ activeLocal: true }), []);
});

test("renaming and recolouring a workspace the rail lists, and refusing one it doesn't", (t) => {
  const w = computer(t, { home: "local" });
  w.profiles.create({ name: "Work" });
  assert.deepEqual(w.profiles.rename("work", "Office"), { outcome: "saved" });
  assert.deepEqual(w.profiles.recolor("work", "amber"), { outcome: "saved" });
  assert.deepEqual(w.profiles.rename(DEFAULT_PROFILE, "Home"), { outcome: "gone" }, "This Mac isn't on this rail");
  assert.deepEqual(w.profiles.places({ activeLocal: false }), [{ id: "work", name: "Office", color: "yellow", swatch: "amber" }]);
  assert.equal(w.profiles.name("work"), "Office");
  assert.equal(w.profiles.name(DEFAULT_PROFILE), null);
});

test("a switch a newer click took over while its workspace started says so (null), never that it failed: no error over the place the person chose", async (t) => {
  const w = computer(t);
  w.profiles.create({ name: "Work" });
  w.beforeOpen = () => { w.profiles.cancel(); return false; };
  assert.equal(await w.profiles.open("work"), null, "the home window gave way to the newer click");
  w.beforeOpen = () => false;
  assert.equal(await w.profiles.open("work"), false, "with no newer click it didn't open: main says so");
});

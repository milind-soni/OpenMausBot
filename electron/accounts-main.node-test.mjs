import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountPlace, accountPlaces, clearPlaceStorage, createPlaceStash, withoutAccountPlaces, withoutPlaces, withPlacesBack } from "./account-places.mjs";
import { accountsView, createAccountLeave, createDesktopRing, installAccounts } from "./accounts-main.mjs";

const signedIn = { status: "connected", account: { id: "a", email: "a@example.test" }, deviceId: "d" };

function harness({ state = signedIn, others = [], placePage = () => true, ownPage = () => true } = {}) {
  const handlers = new Map(), calls = [];
  const client = { state: () => state, signOut: async () => { calls.push("client-sign-out"); return { status: "signed-out" }; } };
  const ring = { others: () => others, switchTo: async (id) => { calls.push(`switch:${id}`); return { outcome: "switched" }; }, signOut: async (id) => { calls.push(`sign-out:${id}`); return { outcome: "signed-out" }; },
    addStart: async (email) => { calls.push(`add:${email}`); return { outcome: "sent", email }; }, addVerify: async () => ({ outcome: "switched", email: "b@example.test" }) };
  const accounts = installAccounts({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, ownPage, placePage, account: () => client, client: () => client, ring: () => ring,
    holdSheet: (open) => calls.push(`hold:${open}`), tellSheet: () => calls.push("tell-sheet"), tell: () => calls.push("tell") });
  return { handlers, calls, accounts, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

test("the view names the account in use and its address, never a token, and nothing while signed out; no page reads the others through it", () => {
  assert.deepEqual(accountsView(signedIn), { active: { id: "a", email: "a@example.test" } });
  assert.deepEqual(accountsView({ status: "reauth-required", account: { id: "a", email: "a@example.test" } }), { active: { id: "a", email: "a@example.test", signIn: true } });
  for (const state of [null, { status: "signed-out" }, { status: "connecting", account: { id: "a", email: "a@example.test" } }]) assert.deepEqual(accountsView(state), { active: null });
  assert.equal(JSON.stringify(accountsView({ ...signedIn, token: "omc_secret" })).includes("omc_"), false);
});

test("only this app's own pages read who is signed in, add or sign out; another page only opens the sheet, from main", async () => {
  const f = harness({ ownPage: () => false, others: [{ id: "b", email: "b@example.test" }] });
  for (const channel of ["accounts:list", "accounts:sign-out", "accounts:add-start", "accounts:add-verify", "accounts:add-browser", "accounts:add-reopen", "accounts:add-cancel", "accounts:sheet-pending", "accounts:sheet-closed"]) {
    await assert.rejects(async () => f.call(channel, "a"), /only available/, channel);
  }
  assert.equal(await f.call("accounts:offered"), true);
  assert.equal(await f.call("accounts:open"), undefined, "the page gets nothing back");
  assert.deepEqual(f.calls, ["hold:true", "tell-sheet"]);
  const refused = harness({ ownPage: () => false, placePage: () => false });
  assert.equal(await refused.call("accounts:offered"), false);
  await assert.rejects(async () => refused.call("accounts:open"), /only available/);
  assert.deepEqual(refused.calls, []);
});

test("the sheet asked for before the rail's page was up opens once when that page asks, and closing lets the rail go", async () => {
  const f = harness();
  await f.call("accounts:open");
  assert.equal(await f.call("accounts:sheet-pending"), true);
  assert.equal(await f.call("accounts:sheet-pending"), false);
  await f.call("accounts:sheet-closed");
  assert.deepEqual(f.calls, ["hold:true", "tell-sheet", "hold:false"]);
});

test("no page can switch or read another account's address: switching is a click on the rail, which main acts on", async () => {
  const f = harness({ others: [{ id: "b", email: "b@example.test" }] });
  assert.equal(f.handlers.has("accounts:switch"), false);
  assert.deepEqual(await f.call("accounts:list"), { active: { id: "a", email: "a@example.test" } });
  assert.equal(JSON.stringify(await f.call("accounts:list")).includes("b@example.test"), false);
});

test("a sign-out answers with who is signed in now; a failure says failed, with no detail", async () => {
  const f = harness();
  assert.deepEqual((await f.call("accounts:sign-out", "a")).outcome, "signed-out");
  const handlers = new Map();
  installAccounts({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, ownPage: () => true, placePage: () => true, account: () => null, client: () => null,
    ring: () => ({ signOut: async () => { throw new Error("omc_secret token in a message"); } }), holdSheet() {}, tellSheet() {}, tell() {} });
  assert.deepEqual(await handlers.get("accounts:sign-out")({}, "b"), { outcome: "failed", view: { active: null } });
});

test("Settings' Sign out is the same sign-out, refused while the move holds it, and works with no account to name", async () => {
  const f = harness();
  assert.equal((await f.accounts.signOutActive()).account.id, "a");
  assert.deepEqual(f.calls, ["sign-out:a"]);
  const none = harness({ state: { status: "signed-out" } });
  await none.accounts.signOutActive();
  assert.deepEqual(none.calls, ["client-sign-out"]);
});

const places = {
  activeId: "cloud-a",
  environments: [
    { id: "home-a", origin: "https://home-a.test", name: "My Cloud", home: true },
    { id: "cloud-a", origin: "https://second-a.test", name: "Second", cloud: { id: "c2", role: "owner" } },
    { id: "team-a", origin: "https://shared-team.test", name: "Team", team: { id: "t1", role: "member" } },
    { id: "by-hand", origin: "https://mine.example", name: "By hand" },
    { id: "local-2", kind: "local", dataDir: "/x", name: "Another" },
  ],
};

test("an account's places are its Clouds and its teams'; a server saved by hand and a local workspace stay", () => {
  assert.equal(accountPlace(places.environments[3]), false);
  assert.equal(accountPlace(places.environments[3], "https://mine.example"), true, "My Cloud saved by hand before it was known to be one");
  assert.equal(accountPlace(places.environments[4], "https://mine.example"), false);
  const { saved, left } = withoutAccountPlaces(places);
  assert.deepEqual(left.map((entry) => entry.id), ["home-a", "cloud-a", "team-a"]);
  assert.deepEqual(saved.environments.map((entry) => entry.id), ["by-hand", "local-2"]);
  assert.equal(saved.activeId, "local", "the window showed one of them: This computer");
  assert.equal(withoutAccountPlaces({ ...places, activeId: "by-hand" }).saved.activeId, "by-hand");
});

test("a team's Cloud, which another account here may share, loses all it kept; a Cloud of one's own only its session", async () => {
  const cleared = [];
  await clearPlaceStorage({ clearStorageData: async (options) => { cleared.push(options); } }, places.environments.slice(0, 3));
  assert.deepEqual(cleared.find((entry) => entry.origin === "https://home-a.test").storages, ["cookies"]);
  assert.deepEqual(cleared.find((entry) => entry.origin === "https://second-a.test").storages, ["cookies"]);
  assert.deepEqual(cleared.find((entry) => entry.origin === "https://shared-team.test").storages, ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"]);
});

test("leaving: the list changes, then the window leaves, and only then the sessions go, so its page can't sign in again", async () => {
  const order = [];
  const leave = createAccountLeave({ saved: () => places, persist: () => order.push("persist"), mine: () => null, leaveWindow: async () => order.push("window"),
    session: () => ({ clearStorageData: async () => { order.push("clear"); } }) });
  const left = await leave.finish(leave.places());
  assert.equal(left.length, 3);
  assert.deepEqual(order, ["persist", "window", "clear", "clear", "clear"]);
});

test("sessions go only after what was still waiting on those places has been answered, since a Cloud's answer re-issues its cookie", async () => {
  const order = [];
  let answer;
  const waiting = new Promise((resolve) => { answer = resolve; });
  const jar = new Map(places.environments.filter((entry) => entry.origin).map((entry) => [entry.origin, "session"]));
  const leave = createAccountLeave({ saved: () => places, persist: () => order.push("persist"), mine: () => null, leaveWindow: async () => order.push("window"),
    settled: () => waiting.then(() => { jar.set("https://home-a.test", "re-issued in the disconnect's answer"); order.push("answered"); }),
    session: () => ({ clearStorageData: async ({ origin }) => { order.push("clear"); jar.delete(origin); } }) });
  const left = leave.finish(leave.places());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["persist", "window"], "nothing is cleared while an answer is on its way");
  answer();
  await left;
  assert.deepEqual(order, ["persist", "window", "answered", "clear", "clear", "clear"]);
  assert.equal(jar.has("https://home-a.test"), false, "the re-issued cookie went with the rest");
});

function cookieJar() {
  const jar = new Map();
  return { jar, session: { clearStorageData: async ({ origin }) => { jar.delete(origin); } } };
}

test("cookies never cross accounts: leaving takes every session of that account's places, a team's Cloud the two share included, and leaves a server saved by hand", async () => {
  const { jar, session } = cookieJar();
  for (const entry of places.environments) if (entry.origin) jar.set(entry.origin, `session-of-a-at-${entry.id}`);
  const leave = createAccountLeave({ saved: () => places, persist() {}, mine: () => null, leaveWindow: async () => {}, session: () => session });
  await leave.finish(leave.places());
  assert.deepEqual([...jar.keys()], ["https://mine.example"], "account B opening the shared team's Cloud finds no cookie of A's, so it signs in with its own code");
});

function memoryFile(start = null) { let held = start; return { read: () => held, write: (value) => { held = value; } }; }

test("an account's places wait with it and come back as they were: same ids, so what was lent to them comes back too", () => {
  const stash = createPlaceStash(memoryFile());
  const { saved: without, left } = withoutAccountPlaces(places);
  const rows = [{ id: "home-a", name: "My Cloud", color: "green", kind: "cloud", opens: true }];
  stash.put("a", left, rows);
  assert.deepEqual(stash.peek("b"), { places: [], rows: [] });
  assert.deepEqual(stash.peek("a").rows, rows, "what the rail shows while it waits");
  const backAgain = withPlacesBack(without, stash.take("a").places);
  assert.deepEqual(backAgain.environments.map((entry) => entry.id).sort(), ["by-hand", "cloud-a", "home-a", "local-2", "team-a"]);
  assert.deepEqual(stash.take("a"), { places: [], rows: [] }, "taken once");
  const keptOne = withPlacesBack({ ...without, environments: [...without.environments, { id: "new", origin: "https://shared-team.test", team: { id: "t1" } }] }, left);
  assert.equal(keptOne.environments.filter((entry) => entry.origin === "https://shared-team.test").length, 1, "a place at that address saved meanwhile stays the one");
  assert.deepEqual(createPlaceStash({ read: () => { throw new Error("unreadable"); }, write() {} }).take("a"), { places: [], rows: [] }, "an unreadable file is nothing kept");
});

/** The ring on real stash and leave code, with a sign-in that says who is in use. */
function desktopRing({ environments = places.environments, order = [], activeId = "a", mine = "https://home-a.test" } = {}) {
  let saved = { activeId: "cloud-a", environments }, state = { status: "connected", account: { id: activeId, email: `${activeId}@example.test` } };
  const stash = memoryFile(), lent = [];
  const tokens = (id) => ({ origin: "https://admin.test", token: `omc_${id.repeat(43)}`, account: { id, email: `${id}@example.test` }, device: { id: `d-${id}` }, expiresAt: Date.now() + 86_400_000 });
  const files = { active: tokens(activeId), saved: { v: 1, accounts: [tokens("b")] } };
  const store = (key) => ({ read: async () => files[key], write: async (value) => { files[key] = value; } });
  let quiet = false;
  const client = { state: () => state, quiesce() { quiet = true; }, async reload() { quiet = false; const id = files.active.account.id; state = { status: "connected", account: { id, email: `${id}@example.test` } }; order.push(`reload:${id}`); }, async refresh() {}, async revokeSaved() { order.push("revoke"); },
    async signOut() { order.push("client-sign-out"); files.active = null; state = { status: "signed-out" }; return state; } };
  const ring = createDesktopRing({ allowed: () => true, active: () => store("active"), savedStore: () => store("saved"), stash: () => stash, client: () => client, origin: "https://admin.test", makeClient: () => { throw new Error("not here"); },
    saved: () => saved, persist: (next) => { saved = next; order.push("persist"); }, session: () => ({ clearStorageData: async ({ origin }) => { order.push(`clear:${origin}`); } }), mine: () => (quiet ? null : mine), leaveWindow: async () => order.push("window"),
    // A quiet sign-in says nothing of its Clouds: what the rail keeps is read before that.
    rows: () => (quiet ? [] : [{ id: "home-a", name: "My Cloud", color: "green", kind: "cloud", opens: true, active: true, progress: 0.5, attention: true, paint: { swatch: "green" } }, { id: "by-hand", name: "By hand", kind: "server", opens: true, forget: true }, { id: "local", name: "This computer", kind: "computer", opens: true }]),
    holding: () => null, letGo: (id) => order.push(`let-go:${id}`), lendingDone: async () => { order.push("lending-done"); }, settled: async () => order.push("settled"), forgetLending: (place) => lent.push(place.id), tell: () => order.push("tell"), log: () => {} });
  return { ring, order, lent, saved: () => saved, files };
}

test("a switch keeps the rail's rows for the account leaving, without their live state, and brings the other's places back", async () => {
  const f = desktopRing({ order: [] });
  await f.ring().start();
  assert.deepEqual(f.ring.waiting().map((row) => row.id), ["b"], "the other account waits, with nothing kept for it yet");
  assert.deepEqual(f.ring.waiting()[0].rows, []);
  assert.equal((await f.ring().switchTo("b")).outcome, "switched");
  const [a] = f.ring.waiting();
  assert.equal(a.id, "a");
  assert.deepEqual(a.rows, [{ id: "home-a", name: "My Cloud", color: "green", kind: "cloud", opens: true }], "no live state, no menu; this computer and a hand-saved server aren't the account's");
  assert.deepEqual(a.places.map((entry) => entry.id), ["home-a", "cloud-a", "team-a"]);
  assert.deepEqual(f.saved().environments.map((entry) => entry.id), ["by-hand", "local-2"], "they leave the list while they wait");
  assert.equal((await f.ring().switchTo("a")).outcome, "switched");
  assert.deepEqual(f.saved().environments.map((entry) => entry.id).sort(), ["by-hand", "cloud-a", "home-a", "local-2", "team-a"], "same ids back");
  assert.deepEqual(f.ring.waiting()[0].id, "b");
});

test("signing out the last account: the sign-in ends before its sessions go, since lending's last answers can re-issue a cookie", async () => {
  const order = [];
  const f = desktopRing({ order });
  await f.ring().start();
  f.files.saved = null;
  await f.ring().start();
  assert.equal((await f.ring().signOut("a")).outcome, "signed-out");
  const steps = order.filter((step) => !step.startsWith("clear:") || step === "clear:https://home-a.test");
  assert.deepEqual(steps.slice(steps.indexOf("let-go:a")), ["let-go:a", "client-sign-out", "persist", "window", "lending-done", "clear:https://home-a.test", "settled", "tell"]);
  assert.deepEqual(f.lent.sort(), ["cloud-a", "home-a", "team-a"], "what was lent to its places is forgotten with it");
  assert.deepEqual(f.ring.waiting(), []);
});

test("signing out one of two: only its group goes, and the other account takes over", async () => {
  const f = desktopRing({ order: [] });
  await f.ring().start();
  assert.equal((await f.ring().signOut("a")).outcome, "signed-out");
  assert.deepEqual(f.ring.waiting(), [], "nothing of it kept");
  assert.equal(f.files.active.account.id, "b");
  assert.deepEqual(f.saved().environments.map((entry) => entry.id), ["by-hand", "local-2"], "servers saved by hand stay");
});

test("the app waits for lending's last answers before it clears an account's sessions", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /createDesktopRing\(\{[^\n]*lendingDone: \(\) => computerSharing\?\.goodbyesDone\(\)/);
});

test("a My Cloud saved by hand is the account's only while the sign-in names it; what left is removed by id, so a list that changed meanwhile loses nothing else", () => {
  const byHand = { id: "h", kind: "remote", origin: "https://byhand.example.test", name: "My server" };
  const saved = { activeId: "h", environments: [byHand, places.environments[3]] };
  assert.deepEqual(accountPlaces(saved, "https://byhand.example.test").map((entry) => entry.id), ["h"]);
  assert.deepEqual(accountPlaces(saved, null), [], "once the sign-in has ended, nothing says which server was My Cloud");
  const changed = { activeId: "h", environments: [...saved.environments, { id: "new", kind: "remote", origin: "https://new.example", name: "New" }] };
  assert.deepEqual(withoutPlaces(changed, [byHand]).environments.map((entry) => entry.id), ["by-hand", "new"]);
  assert.equal(withoutPlaces(changed, [byHand]).activeId, "local");
  assert.equal(withoutPlaces(changed, []), changed, "nothing to remove: the same list");
});

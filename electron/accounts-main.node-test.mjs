import assert from "node:assert/strict";
import test from "node:test";
import { accountPlace, clearPlaceStorage, createPlaceStash, withoutAccountPlaces, withPlacesBack } from "./account-places.mjs";
import { accountsView, createAccountLeave, installAccounts } from "./accounts-main.mjs";

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

test("the view names each account by id and address, never a token, and the active one once", () => {
  assert.deepEqual(accountsView({ ...signedIn, token: "omc_secret", machine: { origin: "https://a.test" } }), { active: { id: "a", email: "a@example.test" }, others: [] });
  assert.deepEqual(accountsView({ status: "reauth-required", account: signedIn.account }).active.signIn, true);
  assert.deepEqual(accountsView({ status: "signed-out" }), { active: null, others: [] });
  assert.deepEqual(accountsView({ status: "connecting" }), { active: null, others: [] });
  assert.deepEqual(accountsView(null), { active: null, others: [] });
  const b = { id: "b", email: "b@example.test" };
  assert.deepEqual(accountsView(signedIn, [{ id: "a", email: "a@example.test" }, b]).others, [b]);
});

test("only this app's own pages read the list, switch, add or sign out; another page only opens the sheet, from main", async () => {
  const f = harness({ ownPage: () => false, others: [{ id: "b", email: "b@example.test" }] });
  for (const channel of ["accounts:list", "accounts:switch", "accounts:sign-out", "accounts:add-start", "accounts:add-verify", "accounts:add-browser", "accounts:add-reopen", "accounts:add-cancel", "accounts:sheet-pending", "accounts:sheet-closed"]) {
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

test("a switch and a sign-out answer with the list as it is now; a failure says failed, with no detail", async () => {
  const f = harness();
  assert.deepEqual(await f.call("accounts:switch", "b"), { outcome: "switched", view: { active: { id: "a", email: "a@example.test" }, others: [] } });
  assert.deepEqual((await f.call("accounts:sign-out", "a")).outcome, "signed-out");
  const handlers = new Map();
  installAccounts({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, ownPage: () => true, placePage: () => true, account: () => null, client: () => null,
    ring: () => ({ others: () => [], switchTo: async () => { throw new Error("omc_secret token in a message"); } }), holdSheet() {}, tellSheet() {}, tell() {} });
  assert.deepEqual(await handlers.get("accounts:switch")({}, "b"), { outcome: "failed", view: { active: null, others: [] } });
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
  const left = await leave();
  assert.equal(left.length, 3);
  assert.deepEqual(order, ["persist", "window", "clear", "clear", "clear"]);
});

/** The window's cookies, by address, as Electron's session keeps them. */
function cookieJar() {
  const jar = new Map();
  return { jar, session: { clearStorageData: async ({ origin }) => { jar.delete(origin); } } };
}

test("cookies never cross accounts: leaving takes every session of that account's places, a team's Cloud the two share included, and leaves a server saved by hand", async () => {
  const { jar, session } = cookieJar();
  for (const entry of places.environments) if (entry.origin) jar.set(entry.origin, `session-of-a-at-${entry.id}`);
  const stash = createPlaceStash(memoryFile());
  const leave = createAccountLeave({ saved: () => places, persist() {}, mine: () => null, leaveWindow: async () => {}, keep: (id, left) => stash.put(id, left), session: () => session });
  await leave("a");
  assert.deepEqual([...jar.keys()], ["https://mine.example"], "account B opening the shared team's Cloud finds no cookie of A's, so it signs in with its own code");
});

function memoryFile(start = null) { let held = start; return { read: () => held, write: (value) => { held = value; } }; }

test("an account's places wait with it and come back as they were: same ids, so what was lent to them comes back too", () => {
  const stash = createPlaceStash(memoryFile());
  const { saved: without, left } = withoutAccountPlaces(places);
  stash.put("a", left);
  assert.deepEqual(stash.peek("b"), []);
  const backAgain = withPlacesBack(without, stash.take("a"));
  assert.deepEqual(backAgain.environments.map((entry) => entry.id).sort(), ["by-hand", "cloud-a", "home-a", "local-2", "team-a"]);
  assert.deepEqual(stash.take("a"), [], "taken once");
  const keptOne = withPlacesBack({ ...without, environments: [...without.environments, { id: "new", origin: "https://shared-team.test", team: { id: "t1" } }] }, left);
  assert.equal(keptOne.environments.filter((entry) => entry.origin === "https://shared-team.test").length, 1, "a place at that address saved meanwhile stays the one");
  assert.deepEqual(createPlaceStash({ read: () => { throw new Error("unreadable"); }, write() {} }).take("a"), [], "an unreadable file is nothing kept");
});

import assert from "node:assert/strict";
import test from "node:test";
import { accountPlace, clearPlaceStorage, withoutAccountPlaces } from "./account-places.mjs";
import { accountsView, createAccountLeave, installAccounts } from "./accounts-main.mjs";

const signedIn = { status: "connected", account: { id: "a", email: "a@example.test" }, deviceId: "d" };

function harness({ state = signedIn, placePage = () => true, ownPage = () => true } = {}) {
  const handlers = new Map(), calls = [];
  let current = state;
  const client = { state: () => current, signOut: async () => { calls.push("sign-out"); current = { status: "signed-out" }; return current; } };
  const accounts = installAccounts({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, ownPage, placePage, account: () => client, client: () => client,
    holdSheet: (open) => calls.push(`hold:${open}`), tellSheet: () => calls.push("tell-sheet"), leaving: () => calls.push("leaving"), leave: async () => calls.push("leave"), show: async () => calls.push("show"), tell: () => calls.push("tell"),
  });
  return { handlers, calls, accounts, call: (channel, ...args) => handlers.get(channel)({}, ...args) };
}

test("the view names the account and its address, never a token, and nothing while signed out", () => {
  assert.deepEqual(accountsView({ ...signedIn, token: "omc_secret", machine: { origin: "https://a.test" } }), { active: { id: "a", email: "a@example.test" }, others: [] });
  assert.deepEqual(accountsView({ status: "reauth-required", account: signedIn.account }).active.signIn, true);
  assert.deepEqual(accountsView({ status: "signed-out" }), { active: null, others: [] });
  assert.deepEqual(accountsView({ status: "connecting" }), { active: null, others: [] });
  assert.deepEqual(accountsView(null), { active: null, others: [] });
});

test("only this app's own pages read the list or sign out; another page only opens the sheet, from main", async () => {
  const f = harness({ ownPage: () => false });
  for (const channel of ["accounts:list", "accounts:sign-out", "accounts:sheet-pending", "accounts:sheet-closed"]) await assert.rejects(async () => f.call(channel, "a"), /only available/);
  assert.equal(await f.call("accounts:offered"), true);
  assert.equal(await f.call("accounts:open"), undefined);
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

test("sign out: the window lets go first, the sign-in ends, the account's places leave, then the window goes where it belongs", async () => {
  const f = harness();
  assert.deepEqual(await f.call("accounts:sign-out", "a"), { active: null, others: [] });
  assert.deepEqual(f.calls, ["leaving", "sign-out", "leave", "show", "tell"]);
});

test("signing out an account that isn't the one here changes nothing", async () => {
  const f = harness();
  await assert.rejects(f.call("accounts:sign-out", "other"), /isn't signed in here/);
  assert.deepEqual(f.calls, []);
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

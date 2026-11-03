import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accountPlace, accountPlaces, clearPlaceStorage, withoutAccountPlaces, withoutPlaces } from "./account-places.mjs";
import { accountsView, createAccountLeave, installAccounts } from "./accounts-main.mjs";

const signedIn = { status: "connected", account: { id: "a", email: "a@example.test" }, deviceId: "d" };

function harness({ state = signedIn, placePage = () => true, ownPage = () => true } = {}) {
  const handlers = new Map(), calls = [];
  let current = state;
  const client = { state: () => current, signOut: async () => { calls.push("sign-out"); current = { status: "signed-out" }; return current; } };
  const accounts = installAccounts({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, ownPage, placePage, account: () => client, client: () => client,
    holdSheet: (open) => calls.push(`hold:${open}`), tellSheet: () => calls.push("tell-sheet"), leaving: () => calls.push("leaving"), leave: { places: () => { calls.push("places"); return []; }, finish: async () => calls.push("leave") }, show: async () => calls.push("show"), tell: () => calls.push("tell"),
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

test("sign out: the window lets go, the account's places are named while the sign-in still names My Cloud, the sign-in ends, they leave, then the window goes where it belongs", async () => {
  const f = harness();
  assert.deepEqual(await f.call("accounts:sign-out", "a"), { active: null, others: [] });
  assert.deepEqual(f.calls, ["leaving", "places", "sign-out", "leave", "show", "tell"]);
});

test("a My Cloud saved by hand, which carries no mark of its own, leaves with the account although the sign-in no longer names it by the time its session goes", async () => {
  const HOME = "https://byhand.example.test";
  let state = signedIn, saved = { activeId: "h", environments: [{ id: "h", kind: "remote", origin: HOME, name: "My server" }, { id: "s", kind: "remote", origin: "https://other.example", name: "Other" }] };
  const cleared = [];
  const client = { state: () => state, signOut: async () => { state = { status: "signed-out" }; return state; } };
  const leave = createAccountLeave({ saved: () => saved, persist: (next) => { saved = next; }, mine: () => (state.status === "connected" ? HOME : null), leaveWindow: async () => {},
    session: () => ({ clearStorageData: async ({ origin }) => { cleared.push(origin); } }) });
  const accounts = installAccounts({ ipcMain: { handle() {} }, ownPage: () => true, placePage: () => true, account: () => client, client: () => client, leave, holdSheet() {}, tellSheet() {}, leaving() {}, show: async () => {}, tell() {} });
  await accounts.signOutActive();
  assert.deepEqual(saved.environments.map((entry) => entry.id), ["s"], "the hand-saved My Cloud left the list; the other server stays");
  assert.equal(saved.activeId, "local");
  assert.deepEqual(cleared, [HOME]);
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

test("the app waits for lending's last answers before it clears a signed-out account's sessions", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /createAccountLeave\(\{[^\n]*settled: \(\) => computerSharing\?\.goodbyesDone\(\)/);
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

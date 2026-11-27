import assert from "node:assert/strict";
import test from "node:test";

import environments from "./environments.cjs";
import { installCloudRail, railPlaces } from "./cloud-rail.mjs";
import { accountRows, ACCOUNT_PLACE, withAccounts } from "./rail-accounts.mjs";

const { LOCAL_ID } = environments;
// The owner's list of cases for the rail with several accounts: each is a test here, by its number.
const A = "alice@omb-test.example", B = "bob@omb-test.example", C = "carol@omb-test.example";
const myCloud = (origin, id = origin) => ({ id, kind: "remote", origin, name: "My Cloud", home: true });
const ownCloud = (origin, name, id = origin) => ({ id, kind: "remote", origin, name, cloud: { id: `c-${id}`, role: "owner" } });
const teamCloud = (origin, name, id = origin) => ({ id, kind: "remote", origin, name, team: { id: `t-${origin}`, role: "member" } });
const byHand = (origin, name) => ({ id: origin, kind: "remote", origin, name });
const signedIn = (email, extra = {}) => ({ status: "connected", account: { id: email, email }, ...extra });
const list = (environmentsList, activeId = LOCAL_ID) => ({ environments: environmentsList, activeId });
const waits = (email, places, rows = places.map((entry) => ({ id: entry.id, name: entry.name, color: null, kind: entry.team ? "team" : "cloud", opens: true }))) => ({ id: email, email, places, rows });
const ids = (rows) => rows.map((row) => row.id);
const dividers = (rows) => rows.slice(1).filter((row, at) => row.group !== rows[at].group).length;

test("1. no account: This computer and hand-connected servers only, as ever, with no grouping", () => {
  assert.deepEqual(railPlaces({ saved: list([]) }), [], "only This computer: no rail");
  const rows = railPlaces({ saved: list([byHand("https://hand.test", "Hand")]) });
  assert.deepEqual(ids(rows), [LOCAL_ID, "https://hand.test"]);
  assert.equal(dividers(rows), 0);
  assert.equal(rows.some((row) => row.email || row.group), false);
});

test("2, 3, 4, 5. one account: exactly today's rail, with no grouping, divider or address", () => {
  const shapes = [
    [myCloud("https://a.test")],
    [myCloud("https://a.test"), ownCloud("https://a2.test", "Two"), ownCloud("https://a3.test", "Three"), ownCloud("https://a4.test", "Four"), ownCloud("https://a5.test", "Five")],
    [myCloud("https://a.test"), teamCloud("https://t.test", "Team")],
    [teamCloud("https://t.test", "Team")],
  ];
  for (const places of shapes) {
    const state = signedIn(A);
    const none = railPlaces({ saved: list(places), mine: "https://a.test", state });
    assert.deepEqual(railPlaces({ saved: list(places), mine: "https://a.test", state, accounts: [] }), none);
    assert.equal(dividers(none), 0);
    assert.equal(JSON.stringify(none).includes("@"), false, "no address");
    assert.equal(none.some((row) => row.group !== undefined), false);
  }
});

test("6. two accounts, one Cloud each, both called My Cloud: told apart by group, divider and address; This computer on top", () => {
  const rows = railPlaces({ saved: list([myCloud("https://a.test", "a-home")]), mine: "https://a.test", state: signedIn(A), accounts: [waits(B, [myCloud("https://b.test", "b-home")])] });
  assert.deepEqual(ids(rows), [LOCAL_ID, "a-home", "b-home"]);
  assert.deepEqual(rows.map((row) => row.name), ["This computer", "My Cloud", "My Cloud"]);
  assert.deepEqual(rows.map((row) => row.email ?? null), [null, A, B]);
  assert.equal(rows[0].group, undefined, "This computer is no account's");
  assert.equal(dividers(rows), 2);
  assert.equal(rows[1].account, undefined, "a click on the account in use's own place doesn't switch");
  assert.equal(rows[2].account, B);
});

test("7. two accounts with several Clouds and teams: groups in a fixed order by address, each in its order, colours per Cloud", () => {
  const b = [myCloud("https://b.test", "b1"), ownCloud("https://b2.test", "B Two", "b2"), teamCloud("https://bt.test", "B Team", "b3")];
  const rows = railPlaces({ saved: list([myCloud("https://a.test", "a1"), ownCloud("https://a2.test", "A Two", "a2"), teamCloud("https://at.test", "A Team", "a3")]), mine: "https://a.test", state: signedIn(A),
    accounts: [waits(B, b, [{ id: "b1", name: "My Cloud", color: "red", kind: "cloud", opens: true }, { id: "b2", name: "B Two", color: "blue", kind: "cloud", opens: true }, { id: "b3", name: "B Team", color: null, kind: "team", opens: true }])] });
  assert.deepEqual(ids(rows), [LOCAL_ID, "a1", "a2", "a3", "b1", "b2", "b3"]);
  assert.deepEqual(rows.slice(4).map((row) => row.color), ["red", "blue", null], "as they looked");
  assert.equal(new Set(rows.slice(1, 4).map((row) => row.group)).size, 1);
  assert.equal(new Set(rows.slice(4).map((row) => row.group)).size, 1);
});

test("8. an account with no Clouds has one row of its own while it waits; while it's the one in use, it has none", () => {
  const rows = railPlaces({ saved: list([myCloud("https://a.test", "a1")]), mine: "https://a.test", state: signedIn(A), accounts: [{ id: C, email: C, places: [], rows: [] }] });
  assert.deepEqual(ids(rows), [LOCAL_ID, "a1", `${ACCOUNT_PLACE}${C}`]);
  assert.deepEqual({ kind: rows[2].kind, name: rows[2].name, opens: rows[2].opens, account: rows[2].account }, { kind: "account", name: C, opens: true, account: C });
  const active = railPlaces({ saved: list([]), state: signedIn(C), accounts: [waits(A, [myCloud("https://a.test", "a1")])] });
  assert.deepEqual(ids(active), [LOCAL_ID, "a1"], "the rail stands though the one in use has nothing on it");
});

test("9. the same team under both accounts is one row: the account in use's when it's a member, else the first that waits", () => {
  const mine = teamCloud("https://t.test", "Team", "t-as-a"), theirs = teamCloud("https://t.test", "Team", "t-as-b");
  const both = railPlaces({ saved: list([mine]), state: signedIn(A), accounts: [waits(B, [theirs])] });
  assert.deepEqual(ids(both).sort(), [LOCAL_ID, "t-as-a", `${ACCOUNT_PLACE}${B}`].sort(), "one row, opened as the account in use, and B can still be reached");
  assert.equal(both[1].account, undefined);
  const notMine = railPlaces({ saved: list([]), state: signedIn(A), accounts: [waits(B, [theirs]), waits(C, [teamCloud("https://t.test", "Team", "t-as-c")])] });
  assert.deepEqual(ids(notMine), [LOCAL_ID, "t-as-b", `${ACCOUNT_PLACE}${C}`]);
  assert.equal(notMine[1].account, B, "a click switches to the one that is a member");
});

test("10. a Cloud that ended keeps looking so while it waits; once its account is in use, today's rows say the rest", () => {
  const rows = accountRows([{ id: "x", name: "Old", color: "red", kind: "cloud", opens: true, ended: true, removable: true, cloudId: "c1", attention: true, progress: 0.2, paint: {} }]);
  assert.deepEqual(rows, [{ id: "x", name: "Old", color: "red", kind: "cloud", opens: true, ended: true }], "no Remove here: it needs the account in use, which a click makes it");
});

test("11. hand-connected servers stay outside any account's group, after them, and aren't kept with an account", () => {
  const rows = railPlaces({ saved: list([myCloud("https://a.test", "a1"), byHand("https://hand.test", "Hand")]), mine: "https://a.test", state: signedIn(A), accounts: [waits(B, [myCloud("https://b.test", "b1")])] });
  assert.deepEqual(ids(rows), [LOCAL_ID, "a1", "b1", "https://hand.test"]);
  assert.equal(rows[3].group, "hand");
  assert.equal(rows[3].email, undefined);
  assert.equal(rows[3].account, undefined);
  assert.deepEqual(accountRows(rows), [{ id: "a1", name: "My Cloud", color: null, kind: "cloud", opens: true }], "this computer, a hand-saved server and another account's rows aren't this account's");
});

test("12. a place that waits carries no live state: nothing on the rail can say it is lent or busy", () => {
  const rows = railPlaces({ saved: list([]), state: signedIn(A), accounts: [waits(B, [myCloud("https://b.test", "b1")], accountRows([{ id: "b1", name: "My Cloud", color: null, kind: "cloud", opens: true, active: true, progress: 0.4, attention: true, update: {}, offline: true, server: true }]))] });
  assert.deepEqual(Object.keys(rows[1]).sort(), ["account", "color", "email", "group", "id", "kind", "name", "opens"]);
});

test("14. a moved computer whose home is a Cloud of the account that waits: its row is there, and This computer is the clean workspace's", () => {
  const rows = railPlaces({ saved: list([]), home: null, state: signedIn(B), accounts: [waits(A, [myCloud("https://a.test", "a1")])] });
  assert.deepEqual(ids(rows), [LOCAL_ID, "a1"]);
  assert.equal(rows[1].account, A);
  const home = railPlaces({ saved: list([myCloud("https://a.test", "a1")]), home: "https://a.test", mine: "https://a.test", state: signedIn(A), accounts: [waits(B, [myCloud("https://b.test", "b1")])] });
  assert.deepEqual(ids(home), ["a1", "b1"], "home on the account in use: as today, no This computer, and the other account's Clouds beside it");
});

test("an account whose sign-in ended keeps its rows, and says so", () => {
  const rows = withAccounts([], { saved: list([]), accounts: [{ ...waits(B, [myCloud("https://b.test", "b1")]), signIn: true }] });
  assert.equal(rows[0].signIn, true);
  assert.equal(rows[0].opens, true);
});

function railWith({ rows, switched = async () => ({ outcome: "switched" }), after = rows }) {
  const handlers = new Map(), opened = [], asked = [];
  let current = rows;
  installCloudRail({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (handler) => handler, trusted: () => true, lists: (event) => event.rail === true, places: () => current, open: async (id) => opened.push(id),
    add: { choices: () => ({ cloud: false, link: false, address: false }), run() {} }, account: () => null, clipboard: {}, openCloud: async (id) => opened.push(`cloud:${id}`), targets: () => [],
    switchAccount: async (id) => { asked.push(id); const said = await switched(id); if (said.outcome === "switched") current = after; return said; } });
  return { call: (channel, ...args) => handlers.get(channel)({ rail: true }, ...args), page: (channel, ...args) => handlers.get(channel)({ rail: false }, ...args), opened, asked };
}
const mineRow = { id: "a1", name: "My Cloud", kind: "cloud", opens: true, group: "active", email: A };
const theirRow = { id: "b1", name: "My Cloud", kind: "cloud", opens: true, group: B, email: B, account: B };
const theirsActive = { id: "b1", name: "My Cloud", kind: "cloud", opens: true, group: "active", email: B };

test("a click on the account in use's place opens it, with no switch", async () => {
  const f = railWith({ rows: [mineRow, theirRow] });
  await f.call("workspaces:open", "a1");
  assert.deepEqual([f.asked, f.opened], [[], ["a1"]]);
});

test("a click on another account's place switches first, then opens it as that account's own", async () => {
  const f = railWith({ rows: [mineRow, theirRow], after: [theirsActive, { ...mineRow, account: A }] });
  assert.deepEqual(await f.call("workspaces:open", "b1"), { outcome: "switched" });
  assert.deepEqual([f.asked, f.opened], [[B], ["b1"]]);
});

test("a click during a move is refused with the plain outcome, and nothing moves", async () => {
  const f = railWith({ rows: [mineRow, theirRow], switched: async () => ({ outcome: "moving" }) });
  assert.deepEqual(await f.call("workspaces:open", "b1"), { outcome: "moving" });
  assert.deepEqual(f.opened, []);
});

test("a saved sign-in past its time: the click asks for the code for that address, and nothing moves", async () => {
  const f = railWith({ rows: [mineRow, { ...theirRow, signIn: true }], switched: async () => ({ outcome: "sign-in", email: B }) });
  assert.deepEqual(await f.call("workspaces:open", "b1"), { outcome: "sign-in", email: B });
  assert.deepEqual(f.opened, []);
});

test("a click on an account with no place of its own switches, and the window goes where that account belongs", async () => {
  const id = `${ACCOUNT_PLACE}${C}`;
  const f = railWith({ rows: [mineRow, { id, name: C, kind: "account", opens: true, group: C, email: C, account: C }], after: [{ ...mineRow, account: A }] });
  assert.deepEqual(await f.call("workspaces:open", id), { outcome: "switched" });
  assert.deepEqual([f.asked, f.opened], [[C], []]);
});

test("no page but the rail's reads the rows, and the rail's never hears which account main switches to", async () => {
  const f = railWith({ rows: [mineRow, theirRow] });
  const seen = await f.call("workspaces:places");
  assert.equal(JSON.stringify(seen.places).includes('"account"'), false);
  assert.deepEqual((await f.page("workspaces:places")).places, []);
  assert.throws(() => f.page("workspaces:open", "b1"), /only available/);
});

test("the groups keep their order whichever account is in use, so a click doesn't move the row under the pointer", () => {
  const a = [myCloud("https://a.test", "a1")], b = [myCloud("https://b.test", "b1")];
  const asAlice = railPlaces({ saved: list(a), mine: "https://a.test", state: signedIn(A), accounts: [waits(B, b)] });
  const asBob = railPlaces({ saved: list(b), mine: "https://b.test", state: signedIn(B), accounts: [waits(A, a)] });
  assert.deepEqual(ids(asAlice), ids(asBob));
  assert.deepEqual(ids(asAlice), [LOCAL_ID, "a1", "b1"], "alice before bob");
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { createCloudAccounts } from "./cloud-accounts.mjs";

const tokenOf = (letter) => `omc_${letter.repeat(43)}`;
const ATTEMPT = "a".repeat(43), CODE = "48201937", DAY = 86400_000;
const person = (letter) => ({ id: `acct-${letter}`, email: `${letter}@example.test` });

/** A fixture Admin: each account has a token per sign-in, and its session answers only for that token. */
async function world(t, { active = null, saved = null } = {}) {
  const w = { now: 1_800_000_000_000, requests: [], revoked: [], writes: [], calls: [], holding: null, nextLetter: "b", activeFile: active, savedFile: saved, failActive: false, readSaved: null };
  const accounts = new Map();
  const account = (letter, token = tokenOf(letter)) => { accounts.set(token, { letter, ...person(letter) }); return token; };
  for (const letter of "abc") account(letter);
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const token = req.headers.authorization?.replace("Bearer ", "");
    w.requests.push({ route: req.url, method: req.method, token });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/app/sign-in/start") { w.emailed = JSON.parse(body).email; return send(200, { cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: true }); }
    if (req.url === "/api/cloud/app/sign-in/verify") {
      if (JSON.parse(body).code !== CODE) return send(400, { error: "invalid_code" });
      const letter = w.emailed[0], fresh = w.freshToken ?? tokenOf(letter);
      account(letter, fresh);
      return send(200, { cloudContractVersion: 1, accessToken: fresh, expiresAt: w.now + 30 * DAY, device: { id: `device-${letter}` }, account: person(letter) });
    }
    const who = accounts.get(token);
    if (req.url === "/api/cloud/desktop/session") {
      if (!who || w.revoked.includes(token)) return send(401, { error: "invalid_token" });
      if (req.method === "DELETE") { w.revoked.push(token); return send(200, { ok: true }); }
      return send(200, { cloudContractVersion: 1, expiresAt: w.now + 30 * DAY, device: { id: `device-${who.letter}` }, account: { id: who.id, email: who.email }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, cloud: null });
    }
    send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  w.origin = origin;
  w.grant = (letter, extra = {}) => ({ origin, token: tokenOf(letter), expiresAt: w.now + 30 * DAY, device: { id: `device-${letter}` }, account: person(letter), ...extra });
  const options = { origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.140", now: () => w.now, openBrowser: async () => {}, setTimer: () => 1, clearTimer: () => {} };
  const activeStore = { read: async () => (typeof w.activeFile === "function" ? w.activeFile() : w.activeFile), write: async (value) => { if (w.failActive) throw new Error("no keychain"); w.writes.push(["active", value?.account?.id ?? null]); w.activeFile = structuredClone(value); } };
  w.make = () => {
    w.client = createCloudAccountClient({ ...options, store: activeStore, onState: () => w.calls.push("state") });
    w.ring = createCloudAccounts({ active: activeStore, client: () => w.client, origin, now: () => w.now,
      saved: { read: async () => { if (w.readSaved) throw w.readSaved; return w.savedFile; }, write: async (value) => { w.writes.push(["saved", (value?.accounts ?? []).map((entry) => entry.account.id)]); w.savedFile = structuredClone(value); } },
      makeClient: ({ store, onState }) => createCloudAccountClient({ ...options, store, onState }),
      holding: () => w.holding, leaving: async (id) => { w.calls.push(`leaving:${id}`); await w.duringLeave?.(); }, arriving: async (id) => { w.calls.push(`arriving:${id}`); }, settled: async () => { w.calls.push("settled"); }, removed: async (id) => { w.calls.push(`removed:${id}`); }, changed: () => w.calls.push("changed") });
    return w;
  };
  w.boot = async () => { w.make(); await w.client.start(); await w.ring.start(); return w; };
  w.addByCode = async (letter) => { await w.ring.addStart(`${letter}@example.test`); return w.ring.addVerify(CODE); };
  w.signedInAs = () => w.client.state().account?.id ?? null;
  t.after(async () => { w.ring?.close(); w.client?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return w;
}
const ids = (w) => w.ring.others().map((row) => row.id);

test("an old saved sign-in upgrades as it is: no prompt, no sign-out, nothing written", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  const before = structuredClone(w.activeFile);
  await w.boot();
  assert.equal(w.client.state().status, "connected");
  assert.equal(w.signedInAs(), "acct-a");
  assert.deepEqual(w.activeFile, before, "the file an older app reads is untouched");
  assert.deepEqual(w.writes.filter(([file]) => file === "saved"), [], "no file of accounts until there is another");
  assert.deepEqual(w.ring.others(), []);
  assert.equal(w.ring.count(), 1);
  assert.deepEqual(w.revoked, []);
});

test("a downgrade: the active account stays in the old format for the old file, and the others are in a file an older app never opens", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  assert.deepEqual(Object.keys(w.activeFile).sort(), ["account", "device", "expiresAt", "origin", "token"], "exactly what an older app validates");
  assert.equal(w.activeFile.account.id, "acct-b");
  assert.equal(w.savedFile.v, 1);
  w.client.close();
  const older = createCloudAccountClient({ origin: w.origin, fixture: true, deviceName: "Old", platform: "darwin", now: () => w.now, openBrowser: async () => {}, setTimer: () => 1, clearTimer: () => {}, store: { read: async () => w.activeFile, write: async () => { throw new Error("nothing to write"); } } });
  await older.start();
  assert.equal(older.state().status, "connected", "an older app starts signed in, without a crash");
  assert.equal(older.state().account.id, "acct-b");
  older.close();
});

test("add: signs in beside the account in use, which goes on until it succeeds, then the new one is active and the old one waits", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  assert.equal((await w.ring.addStart("b@example.test")).outcome, "sent");
  assert.equal(w.signedInAs(), "acct-a", "still A while the code is on its way");
  assert.equal((await w.ring.addVerify("00000000")).outcome, "wrong-code");
  assert.equal(w.signedInAs(), "acct-a");
  const added = await w.ring.addVerify(CODE);
  assert.deepEqual([added.outcome, added.email], ["switched", "b@example.test"]);
  assert.equal(w.client.state().status, "connected");
  assert.equal(w.signedInAs(), "acct-b");
  assert.deepEqual(w.ring.others(), [{ id: "acct-a", email: "a@example.test" }]);
  assert.equal(w.ring.count(), 2);
  assert.deepEqual(w.revoked, [], "A stays signed in");
  assert.ok(!JSON.stringify([w.ring.others(), added]).includes("omc_"), "no token leaves this module");
});

test("a cancelled add changes nothing and asks nothing of the account in use", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.ring.addStart("b@example.test");
  w.ring.addCancel();
  assert.equal((await w.ring.addVerify(CODE)).outcome, "expired");
  assert.equal(w.signedInAs(), "acct-a");
  assert.deepEqual(w.savedFile, null);
});

test("switch: one tap, no code, each account's own token; a saved account asks nothing while it waits", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  w.requests.length = 0; w.calls.length = 0;
  assert.deepEqual(await w.ring.switchTo("acct-a"), { outcome: "switched" });
  assert.equal(w.signedInAs(), "acct-a");
  assert.deepEqual(w.requests.map((request) => request.route), ["/api/cloud/desktop/session"], "no sign-in route");
  assert.equal(w.requests[0].token, tokenOf("a"));
  assert.deepEqual(w.calls.filter((call) => !["state"].includes(call)), ["leaving:acct-b", "arriving:acct-a", "settled", "changed"]);
  w.requests.length = 0;
  await w.client.refresh();
  assert.deepEqual(w.requests.map((request) => request.token), [tokenOf("a")], "only the active account's token is ever used");
  assert.deepEqual(ids(w), ["acct-b"]);
  assert.deepEqual(await w.ring.switchTo("acct-a"), { outcome: "switched" }, "already that one");
});

test("three accounts: each is one tap from any other", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b"); await w.addByCode("c");
  assert.deepEqual(ids(w).sort(), ["acct-a", "acct-b"]);
  await w.ring.switchTo("acct-b");
  assert.deepEqual(ids(w).sort(), ["acct-a", "acct-c"]);
  await w.ring.switchTo("acct-a");
  assert.deepEqual(ids(w).sort(), ["acct-b", "acct-c"]);
  assert.equal(w.ring.count(), 3);
  assert.deepEqual(w.revoked, []);
});

test("a switch writes in the order that loses nothing: at every write each token is in a file", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  w.writes.length = 0;
  await w.ring.switchTo("acct-a");
  assert.deepEqual(w.writes, [["saved", ["acct-a", "acct-b"]], ["active", "acct-a"], ["saved", ["acct-b"]]]);
});

test("a crash mid-switch: an account found in both files is the active one, shown once", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  w.savedFile = { v: 1, accounts: [w.grant("a"), w.grant("b")] };
  await w.boot();
  assert.equal(w.signedInAs(), "acct-a");
  assert.deepEqual(ids(w), ["acct-b"]);
  assert.equal(w.ring.count(), 2);
});

test("the active file can't be written: nothing changes, the account in use goes on, and both tokens are kept", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  w.failActive = true; w.calls.length = 0;
  await assert.rejects(w.ring.switchTo("acct-a"), /no keychain/);
  assert.equal(w.signedInAs(), "acct-b");
  assert.ok(!w.calls.some((call) => call.startsWith("leaving")), "nothing of B's was stopped");
  assert.equal(w.savedFile.accounts.some((entry) => entry.account.id === "acct-a"), true);
  assert.equal(w.activeFile.account.id, "acct-b");
});

test("sign out of the active account: gone from this device and ended at the Admin, and the app moves to another signed in here", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  w.calls.length = 0;
  assert.deepEqual(await w.ring.signOut("acct-b"), { outcome: "signed-out" });
  assert.equal(w.signedInAs(), "acct-a");
  assert.deepEqual(w.ring.others(), []);
  assert.deepEqual(w.revoked, [tokenOf("b")]);
  assert.equal(w.savedFile, null);
  assert.ok(w.calls.includes("removed:acct-b"));
  assert.ok(!JSON.stringify(w.activeFile).includes(tokenOf("b")));
});

test("sign out of the last account: signed out, with nothing left on this device", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  w.calls.length = 0;
  assert.deepEqual(await w.ring.signOut("acct-a"), { outcome: "signed-out" });
  assert.equal(w.client.state().status, "signed-out");
  assert.equal(w.activeFile, null);
  assert.deepEqual(w.revoked, [tokenOf("a")]);
  assert.equal(w.ring.count(), 0);
  assert.deepEqual(w.calls.filter((call) => call !== "state"), ["leaving:acct-a", "settled", "removed:acct-a", "changed"]);
});

test("sign out of an account that is waiting: its token ends, and the one in use isn't touched", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  w.calls.length = 0;
  await w.ring.signOut("acct-a");
  assert.equal(w.signedInAs(), "acct-b");
  assert.deepEqual(w.revoked, [tokenOf("a")]);
  assert.deepEqual(w.ring.others(), []);
  assert.ok(!w.calls.some((call) => call.startsWith("leaving")));
});

test("while the move holds the account: no switch and no sign-out, nothing written; an added account waits", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  await w.addByCode("b");
  w.holding = "moving"; w.writes.length = 0; w.calls.length = 0;
  assert.deepEqual(await w.ring.switchTo("acct-a"), { outcome: "moving" });
  assert.deepEqual(await w.ring.signOut("acct-b"), { outcome: "moving" });
  assert.deepEqual(w.writes, []);
  assert.equal(w.signedInAs(), "acct-b");
  assert.ok(!w.calls.some((call) => call.startsWith("leaving")));
  const added = await w.addByCode("c");
  assert.equal(added.outcome, "added");
  assert.equal(w.signedInAs(), "acct-b", "stays with the move");
  assert.deepEqual(ids(w).sort(), ["acct-a", "acct-c"]);
});

test("adding the account that's already here: its new token ends at once, and the address is said", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  w.freshToken = tokenOf("d");
  const added = await w.addByCode("a");
  assert.equal(added.outcome, "already");
  assert.deepEqual(w.revoked, [tokenOf("d")]);
  assert.equal(w.activeFile.token, tokenOf("a"), "the sign-in in use is still that one");
});

test("a waiting sign-in that ended by its date asks for the code again, and changes nothing", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  w.savedFile = { v: 1, accounts: [w.grant("b", { expiresAt: w.now - 1 })] };
  await w.boot();
  assert.deepEqual(w.ring.others(), [{ id: "acct-b", email: "b@example.test", signIn: true }]);
  assert.deepEqual(await w.ring.switchTo("acct-b"), { outcome: "sign-in", email: "b@example.test" });
  assert.equal(w.signedInAs(), "acct-a");
});

test("a switch to an account no longer here says so", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  assert.deepEqual(await w.ring.switchTo("acct-z"), { outcome: "gone" });
});

test("a locked keychain never loses the saved accounts: the switch fails and the file stays; one that can never be read is dropped", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  w.savedFile = { v: 1, accounts: [w.grant("b")] };
  await w.boot();
  w.readSaved = new Error("Unlock your keychain");
  w.writes.length = 0;
  await assert.rejects(w.ring.switchTo("acct-b"), /Unlock/);
  assert.deepEqual(w.writes, []);
  assert.equal(w.savedFile.accounts.length, 1);
  w.readSaved = Object.assign(new Error("corrupt"), { code: "unreadable_record" });
  assert.deepEqual(await w.ring.switchTo("acct-b"), { outcome: "gone" });
});

test("a saved file from a newer version is left alone; a record for another Admin or with a bad token is never used", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  const newer = { v: 2, accounts: [] };
  w.savedFile = newer;
  await w.boot();
  await assert.rejects(w.ring.switchTo("acct-b"), /newer version/);
  assert.deepEqual(w.savedFile, newer);
  w.savedFile = { v: 1, accounts: [{ ...w.grant("b"), origin: "https://elsewhere.test" }, { ...w.grant("c"), token: "stolen" }] };
  assert.deepEqual(await w.ring.switchTo("acct-b"), { outcome: "gone" });
  assert.deepEqual(await w.ring.switchTo("acct-c"), { outcome: "gone" });
  assert.equal(w.signedInAs(), "acct-a");
});

test("a launch with no one active but others waiting: the first still good takes its place; a locked active file is left alone", async (t) => {
  const w = await world(t);
  w.savedFile = { v: 1, accounts: [w.grant("b", { expiresAt: w.now - 1 }), w.grant("c")] };
  await w.boot();
  assert.equal(w.signedInAs(), "acct-c");
  assert.deepEqual(ids(w), ["acct-b"]);
});

test("a sign-in that ended gives way: the code brings that account back with the new token, for the active one and for one waiting", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  w.savedFile = { v: 1, accounts: [w.grant("b", { expiresAt: w.now - 1 })] };
  await w.boot();
  w.freshToken = tokenOf("e");
  assert.equal((await w.addByCode("b")).outcome, "switched");
  assert.equal(w.signedInAs(), "acct-b");
  assert.equal(w.activeFile.token, tokenOf("e"));
  assert.deepEqual(ids(w), ["acct-a"], "A waits, B is there once");
  assert.deepEqual(w.revoked, []);
  w.revoked.push(tokenOf("e"));
  await w.client.refresh();
  assert.equal(w.client.state().status, "reauth-required");
  w.freshToken = tokenOf("f");
  assert.equal((await w.addByCode("b")).outcome, "switched");
  assert.equal(w.activeFile.token, tokenOf("f"));
  assert.equal(w.client.state().status, "connected");
  assert.deepEqual(ids(w), ["acct-a"]);
});

test("until the saved accounts have been read, there may be more than one: nothing that needs one account starts on a guess", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  w.make();
  await w.client.start();
  assert.equal(w.ring.count(), 2);
  w.readSaved = new Error("Unlock your keychain");
  await w.ring.start();
  assert.equal(w.ring.count(), 2, "still unknown");
  w.readSaved = null;
  await w.ring.start();
  assert.equal(w.ring.count(), 1);
});

test("while a switch is under way nothing of the old sign-in runs: a window coming to the front or Settings' Refresh can't write it over the new one", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a"); w.savedFile = { v: 1, accounts: [w.grant("b")] };
  await w.boot();
  w.requests.length = 0;
  let during = null;
  w.duringLeave = async () => {
    assert.equal(w.activeFile.account.id, "acct-b", "the new sign-in is in the file by now");
    during = await w.client.refresh();
    assert.equal(w.activeFile.account.id, "acct-b", "and stays there");
  };
  assert.equal((await w.ring.switchTo("acct-b")).outcome, "switched");
  assert.ok(during, "a refresh mid-switch still answers");
  assert.deepEqual(w.requests.filter((row) => row.token === tokenOf("a")), [], "nothing was asked with the old token");
  assert.equal(w.activeFile.account.id, "acct-b");
  assert.deepEqual(w.ring.others().map((row) => row.id), ["acct-a"]);
  assert.equal(w.signedInAs(), "acct-b");
  assert.equal(w.client.state().status, "connected", "it runs again once the new sign-in is read");
});

test("a change of account that fails partway never leaves the sign-in stopped: it reads its file again, and the window goes where it belongs", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a"); w.savedFile = { v: 1, accounts: [w.grant("b")] };
  await w.boot();
  w.calls.length = 0;
  w.duringLeave = async () => { throw new Error("the window wouldn't move"); };
  await assert.rejects(w.ring.switchTo("acct-b"), /wouldn't move/);
  assert.equal(w.signedInAs(), "acct-b", "the file says b, and the sign-in reads it");
  assert.equal(w.client.state().status, "connected");
  assert.ok(w.calls.includes("settled"), JSON.stringify(w.calls));
  await w.client.refresh();
  assert.equal(w.client.state().status, "connected", "a refresh works again");
});

test("a sign-in that can't be written stays the old account's, running again", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a"); w.savedFile = { v: 1, accounts: [w.grant("b")] };
  await w.boot();
  w.failActive = true;
  await assert.rejects(w.ring.switchTo("acct-b"), /no keychain/);
  assert.equal(w.signedInAs(), "acct-a");
  assert.equal(w.client.state().status, "connected");
  assert.deepEqual(w.savedFile.accounts.map((record) => record.account.id).sort(), ["acct-a", "acct-b"], "neither sign-in is lost");
});

/** A ring whose Add another account runs through a fake browser sign-in: `w.browserFinished(letter)` is the browser coming back. */
function browserRing({ active = "a", holding = null } = {}) {
  const w = { active, changes: 0, signOuts: 0, activeFile: null, savedFile: null };
  const record = (letter) => ({ origin: "https://admin.test", token: tokenOf(letter), expiresAt: Date.now() + DAY, device: { id: `device-${letter}` }, account: person(letter) });
  w.activeFile = record(active);
  const state = () => ({ status: "connected", account: person(w.activeFile.account.id.at(-1)) });
  const client = { state, quiesce() {}, reload: async () => {}, signOut: async () => {}, revokeSaved: async () => {} };
  let fire = null, held = null;
  w.ring = createCloudAccounts({ origin: "https://admin.test", client: () => client, holding: () => holding, changed: () => { w.changes++; },
    active: { read: async () => w.activeFile, write: async (value) => { w.activeFile = value; } }, saved: { read: async () => w.savedFile, write: async (value) => { w.savedFile = value; } },
    makeClient: ({ store, onState }) => { fire = onState; held = store; return { begin: async () => ({ status: "connecting" }), signOut: async () => { w.signOuts++; }, close() {} }; } });
  w.browserFinished = async (letter) => { await held.write(record(letter)); fire({ status: "connected" }); for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return w;
}

test("the browser's way says how it ended: the account in use already, one kept during a move, one switched to, once each", async () => {
  const already = browserRing();
  await already.ring.start();
  await already.ring.addBrowser();
  assert.equal(already.ring.addResult(), null, "nothing yet");
  await already.browserFinished("a");
  assert.deepEqual(already.ring.addResult(), { outcome: "already", email: "a@example.test" }, "the sheet isn't left waiting");
  assert.equal(already.ring.addResult(), null, "told once");
  assert.equal(already.signOuts, 1, "the extra sign-in ends at once");
  assert.ok(already.changes > 0, "the page is told to look");
  const moving = browserRing({ holding: "moving" });
  await moving.ring.start();
  await moving.ring.addBrowser();
  await moving.browserFinished("b");
  assert.deepEqual(moving.ring.addResult(), { outcome: "added", email: "b@example.test" });
  const fresh = browserRing();
  await fresh.ring.start();
  await fresh.ring.addBrowser();
  await fresh.browserFinished("b");
  assert.deepEqual(fresh.ring.addResult(), { outcome: "switched", email: "b@example.test" });
});

test("the browser's way failing says so rather than leaving the sheet waiting", async () => {
  const w = browserRing();
  await w.ring.start();
  await w.ring.addBrowser();
  w.savedFile = { v: 99, accounts: [] };
  await w.browserFinished("b");
  assert.deepEqual(w.ring.addResult(), { outcome: "failed" });
});

test("the emailed code's way answers directly, and leaves nothing for the browser's way to say", async (t) => {
  const w = await world(t);
  w.activeFile = w.grant("a");
  await w.boot();
  assert.equal((await w.addByCode("b")).outcome, "switched");
  assert.equal(w.ring.addResult(), null);
});

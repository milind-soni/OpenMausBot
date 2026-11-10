import assert from "node:assert/strict";
import test from "node:test";
import { createTeamJoin, createTeamLanding, takeTeamLink, TEAM_JOIN_WAIT_MS, teamIdFromLink } from "./team-join.mjs";
import { isCloudDeepLink } from "./cloud-entry.mjs";
import { chatLinkFrom } from "./chat-link.mjs";

const ACME = "0f8b6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const LINK = `openmausbot://team/${ACME}`;

test("a team link names a team by its id and nothing else; anything more is no link", () => {
  assert.equal(teamIdFromLink(LINK), ACME);
  for (const value of [null, undefined, 42, "", `${LINK}/`, `${LINK}?code=ABCDE`, `${LINK}#token=x`, "openmausbot://team/", "openmausbot://team/acme",
    `openmausbot://team/${ACME.toUpperCase()}`, `OPENMAUSBOT://team/${ACME}`, `openmausbot://teams/${ACME}`, `https://evil.example/openmausbot://team/${ACME}`, ` ${LINK}`]) {
    assert.equal(teamIdFromLink(value), null, String(value));
  }
  // Older handlers leave it alone, and it is no Cloud or chat link.
  assert.equal(isCloudDeepLink(LINK), false);
  assert.equal(chatLinkFrom(LINK), null);
});

test("a launch's team link is taken out of the command line, so a relaunch doesn't open it again", () => {
  const argv = ["/Applications/MausBot", "--flag", LINK, "openmausbot://cloud"];
  assert.equal(takeTeamLink(argv), ACME);
  assert.deepEqual(argv, ["/Applications/MausBot", "--flag", "openmausbot://cloud"]);
  assert.equal(takeTeamLink(argv), null);
});

/** The sign-in as main keeps it: its state, and what a refresh, a begin and a sign-in again do. */
function harness(initial, { afterRefresh = initial, answer = true, now = () => 1_000 } = {}) {
  const calls = [];
  let current = initial;
  const client = {
    state: () => current,
    refresh: async () => { calls.push("refresh"); current = afterRefresh; return current; },
    begin: async () => { calls.push("begin"); current = { status: "connecting" }; return current; },
    signInAgain: async () => { calls.push("signInAgain"); return current; },
  };
  const join = createTeamJoin({ account: () => client, now,
    addAccount: async () => { calls.push("addAccount"); },
    open: async (team) => { calls.push(["open", team]); },
    ask: async (question) => { calls.push(["ask", question]); return answer; },
    reveal: () => calls.push("reveal") });
  return { join, calls, set: (state) => { current = state; } };
}
const connected = (teams, email = "sam@acme.test") => ({ status: "connected", account: { id: "u1", email }, teams });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("signed in as the same address: the team list is read again at once and the team opens", async () => {
  const h = harness(connected([]), { afterRefresh: connected([{ id: ACME, name: "Acme", role: "member" }]) });
  await h.join.ready();
  assert.equal(h.join.request(ACME), true);
  await settle();
  assert.deepEqual(h.calls, ["reveal", "refresh", ["open", { id: ACME, name: "Acme" }]]);
  assert.equal(h.join.pending(), null);
});

test("signed out: the app's own browser sign-in starts, and the team opens once the sign-in lists it", async () => {
  const h = harness({ status: "signed-out" });
  await h.join.ready();
  h.join.request(ACME);
  await settle();
  assert.deepEqual(h.calls, ["reveal", "begin"]);
  // Another account's list first (the wrong address in the browser): nothing opens, and the link keeps waiting.
  h.join.changed(connected([{ id: OTHER, name: "Other", role: "member" }]));
  await settle();
  assert.equal(h.calls.length, 2);
  h.join.changed(connected([{ id: ACME, name: "Acme", role: "admin" }]));
  await settle();
  assert.deepEqual(h.calls.at(-1), ["open", { id: ACME, name: "Acme" }]);
});

test("signed in as another address: it says so once, and offers to sign in with the other one, keeping this one", async () => {
  const h = harness(connected([], "me@home.test"));
  await h.join.ready();
  h.join.request(ACME);
  await settle();
  assert.deepEqual(h.calls, ["reveal", "refresh", ["ask", { kind: "other-account", email: "me@home.test" }], "addAccount"]);
  // The added account becomes the one in use, listing the team: it opens.
  h.join.changed(connected([{ id: ACME, name: "Acme", role: "member" }], "sam@acme.test"));
  await settle();
  assert.deepEqual(h.calls.at(-1), ["open", { id: ACME, name: "Acme" }]);
  // Cancel drops the link: nothing opens later by surprise.
  const declined = harness(connected([], "me@home.test"), { answer: false });
  await declined.join.ready();
  declined.join.request(ACME);
  await settle();
  assert.equal(declined.join.pending(), null);
});

test("a link from the launch waits for the app to be ready, shows nothing before, and a link left waiting ends after half an hour", async () => {
  let clock = 1_000;
  const h = harness({ status: "signed-out", message: "restoring" }, { now: () => clock });
  h.join.request(ACME, { launch: true });
  await settle();
  assert.deepEqual(h.calls, []);
  h.set({ status: "signed-out" });
  await h.join.ready();
  assert.deepEqual(h.calls, ["begin"]);
  clock += TEAM_JOIN_WAIT_MS;
  h.join.changed(connected([{ id: ACME, name: "Acme", role: "member" }]));
  await settle();
  assert.deepEqual(h.calls, ["begin"]);
});

test("an invited person's team opens first, once on this device; never again once opened here, and never a team the session doesn't list", async () => {
  let kept = null;
  const opened = [];
  const landing = createTeamLanding({ store: { read: () => kept, write: (value) => { kept = value; } }, open: async (team) => { opened.push(team.id); } });
  const state = { ...connected([{ id: ACME, name: "Acme", role: "member" }]), landing: { teamId: ACME } };
  landing.changed({ ...state, teams: [] });
  landing.changed({ status: "signed-out", landing: { teamId: ACME } });
  await settle();
  assert.deepEqual(opened, []);
  landing.changed(state);
  landing.changed(state);
  await settle();
  assert.deepEqual(opened, [ACME]);
  assert.deepEqual(kept, { teams: [ACME] });
  // A team opened by hand first is no landing.
  const other = { ...connected([{ id: OTHER, name: "Other", role: "member" }]), landing: { teamId: OTHER } };
  landing.opened(OTHER);
  landing.changed(other);
  await settle();
  assert.deepEqual(opened, [ACME]);
});

test("the session's landing is read only for a team the same session lists", async () => {
  const { parseCloudLanding } = await import("./cloud-home.mjs");
  const teams = [{ id: ACME, name: "Acme", role: "member", machine: null }];
  assert.deepEqual(parseCloudLanding({ teamId: ACME }, teams), { teamId: ACME });
  assert.equal(parseCloudLanding({ teamId: OTHER }, teams), null);
  for (const value of [null, undefined, {}, { teamId: 3 }, "x"]) assert.equal(parseCloudLanding(value, teams), null);
});

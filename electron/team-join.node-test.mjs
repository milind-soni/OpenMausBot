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

test("an invited person's team opens first only on a sign-in just made, the first on this device, with no place of their own in use; once", async () => {
  const make = (initial = null, own = false) => {
    let kept = initial;
    const opened = [];
    const landing = createTeamLanding({ store: { read: () => kept, write: (value) => { kept = value; } }, open: async (team) => { opened.push(team.id); }, ownPlace: () => own });
    return { landing, opened, kept: () => kept };
  };
  const state = { ...connected([{ id: ACME, name: "Acme", role: "member" }]), landing: { teamId: ACME } };
  // A fresh install: the sign-in, then the team.
  const fresh = make();
  fresh.landing.changed({ status: "signed-out" });
  fresh.landing.changed({ status: "connecting" });
  fresh.landing.changed(state);
  fresh.landing.changed({ status: "signed-out" });
  fresh.landing.changed(state);
  await settle();
  assert.deepEqual(fresh.opened, [ACME]);
  assert.deepEqual(fresh.kept(), { teams: [ACME], accounts: ["u1"] });
  // Already signed in when the app started (a session read, not a sign-in): the team is in the rail, the window stays.
  const restored = make();
  restored.landing.changed({ status: "signed-out", message: "restoring" });
  restored.landing.changed(state);
  await settle();
  assert.deepEqual(restored.opened, []);
  // A sign-in on a device another account used before, or with My Cloud on screen: no move either.
  const used = make({ teams: [], accounts: ["someone-else"] });
  used.landing.changed({ status: "connecting" }); used.landing.changed(state);
  const own = make(null, true);
  own.landing.changed({ status: "connecting" }); own.landing.changed(state);
  // A team the session doesn't list is never a landing.
  const unlisted = make();
  unlisted.landing.changed({ status: "connecting" }); unlisted.landing.changed({ ...state, teams: [] });
  await settle();
  assert.deepEqual([used.opened, own.opened, unlisted.opened], [[], [], []]);
});

test("the link's own sign-in finishing as an address the team isn't listed for says so, instead of nothing", async () => {
  const h = harness({ status: "signed-out" });
  await h.join.ready();
  h.join.request(ACME);
  await settle();
  h.join.changed(connected([], "other@home.test"));
  await settle();
  assert.deepEqual(h.calls.slice(-2), [["ask", { kind: "other-account", email: "other@home.test" }], "addAccount"]);
});

test("the session's landing is read only for a team the same session lists", async () => {
  const { parseCloudLanding } = await import("./cloud-home.mjs");
  const teams = [{ id: ACME, name: "Acme", role: "member", machine: null }];
  assert.deepEqual(parseCloudLanding({ teamId: ACME }, teams), { teamId: ACME });
  assert.equal(parseCloudLanding({ teamId: OTHER }, teams), null);
  for (const value of [null, undefined, {}, { teamId: 3 }, "x"]) assert.equal(parseCloudLanding(value, teams), null);
});

test("main's wiring: a team URL or command line is taken, anything else is left to the other handlers, and main's own dialog asks", async () => {
  const { installTeamJoin } = await import("./team-join-main.mjs");
  const asked = [];
  let state = connected([], "me@home.test");
  const client = { state: () => state, refresh: async () => state, begin: async () => state, signInAgain: async () => state };
  const argv = ["/app", LINK];
  const links = installTeamJoin({ argv, account: () => client, addAccount: async () => {}, openTeam: async () => {}, t: (key, params) => `${key}${params ? JSON.stringify(params) : ""}`,
    confirm: async (message, detail, button) => { asked.push([message, detail, button]); return false; }, reveal: () => {}, store: { read: () => null, write: () => {} }, ownPlace: () => false, log: () => {} });
  assert.deepEqual(argv, ["/app"]);
  assert.equal(links.fromUrl("openmausbot://cloud"), false);
  assert.equal(links.fromArgs(["/app", "openmausbot://cloud"]), false);
  await links.ready();
  await settle();
  assert.deepEqual(asked, [["native.teamLink.otherTitle", 'native.teamLink.otherDetail{"email":"me@home.test"}', "native.teamLink.signIn"]]);
  state = connected([{ id: ACME, name: "Acme", role: "member" }]);
  assert.equal(links.fromUrl(LINK), true);
});

test("main makes the team link's wiring before most of main exists: nothing it is given is read until later, so the app starts", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const at = main.indexOf("installTeamJoin({");
  assert.ok(at > 0);
  // The call's own arguments, to its closing brace.
  let depth = 0, end = at + "installTeamJoin(".length;
  for (; end < main.length; end++) { const c = main[end]; if ("({[".includes(c)) depth++; else if (")}]".includes(c) && --depth === 0) break; }
  const args = main.slice(at + "installTeamJoin({".length, end);
  // Split into its top-level `key: value` pairs.
  const pairs = []; let start = 0; depth = 0;
  for (let i = 0; i <= args.length; i++) { const c = args[i]; if (c && "({[".includes(c)) depth++; else if (c && ")}]".includes(c)) depth--; else if ((c === "," && depth === 0) || i === args.length) { pairs.push(args.slice(start, i).trim()); start = i + 1; } }
  const imported = new Set([...main.matchAll(/^import \{([^}]*)\}/gm)].flatMap((match) => match[1].split(",").map((name) => name.trim().split(/\s+as\s+/).pop())));
  const before = main.slice(0, at);
  for (const pair of pairs.filter(Boolean)) {
    const value = pair.slice(pair.indexOf(":") + 1).trim();
    if (/^(async\s+)?(\([^)]*\)|[\w$]+)\s*=>/.test(value)) continue;
    const head = /^([A-Za-z_$][\w$]*)/.exec(value)?.[1];
    if (!head || ["process", "path", "app"].includes(head)) continue;
    assert.ok(imported.has(head) || new RegExp(`(?:const|let|var|function)\\s+${head}\\b`).test(before), `${pair.split(":")[0]}: ${head} is read before main declares it`);
  }
});

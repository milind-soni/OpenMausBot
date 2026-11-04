// A team's own page bringing a bot in from My Cloud: the team is the page's own by the Admin's word, the bots and their
// names come from My Cloud, and nothing moves until the person says so in main's own confirm.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bringableBots, installTeamMove, teamMoveConfirmWords } from "./team-move-main.mjs";

const HOME = "https://home.example.test", TEAM = "https://acme.example.test", OTHER = "https://other.example.test";
const state = { status: "connected", teams: [
  { id: "team-acme", name: "Acme", machine: { origin: TEAM, status: "ready" } },
  { id: "team-waiting", name: "Waiting", machine: { origin: OTHER, status: "provisioning" } },
] };
const BOTS = [
  { id: "maus-bot-1", name: "MausBot", defaultBot: {} },
  { id: "atlas-bot-1", name: "Atlas" },
  { id: "chief-bot-1", name: "Luna", chiefOfStaff: true },
  { id: "old-bot-01", name: "Hidden", hidden: true },
  { id: "gone-bot-01", name: "Gone", movedTo: { state: "moved", team: { id: "team-acme", name: "Acme" } } },
];

function fixture({ agrees = false, home = true, bots = BOTS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-bring-"));
  const handlers = new Map(), asked = [], pairs = [];
  const journal = { value: null, read() { return this.value; }, write(next) { this.value = next; } };
  const move = installTeamMove({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    cloudPage: () => null,
    pageOrigin: (event) => event.origin ?? null,
    confirmMove: async (words) => { asked.push(words); return agrees; },
    home: () => (home ? { origin: HOME, grant: async () => { pairs.push("grant"); return { origin: HOME, code: "C" }; } } : null),
    account: () => ({ state: () => state, pairTeam: async () => { throw new Error("no team pairing in this test"); } }),
    file: () => join(dir, "send.json"), journalFile: () => join(dir, "moves.json"), journal,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/auth/pair")) return new Response(JSON.stringify({ token: "omb_sess_fixture" }), { status: 200 });
      if (String(url).endsWith("/api/bots?messages=0")) return new Response(JSON.stringify({ bots }), { status: 200 });
      if (String(url).endsWith("/api/auth/logout")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ url, method: init?.method }), { status: 503 });
    },
  });
  return { handlers, asked, pairs, journal, move, done: () => { move.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const OWN = { origin: TEAM };

test("lists My Cloud's bots to that team's own page, each with why it can't go, and to nobody else", async () => {
  const { handlers, done } = fixture();
  try {
    const list = handlers.get("cloud-send:team-bring");
    assert.deepEqual(await list(OWN), { team: { id: "team-acme", name: "Acme", ready: true }, bots: [
      { id: "maus-bot-1", name: "MausBot", stays: "default" }, { id: "atlas-bot-1", name: "Atlas" }, { id: "chief-bot-1", name: "Luna", stays: "chief" },
    ] });
    assert.deepEqual(await list({ origin: "https://stranger.example.test" }), { bots: [] }, "a page that isn't one of the person's teams");
    assert.deepEqual(await list({}), { bots: [] }, "a sender that isn't the window's own page");
  } finally { done(); }
});

test("nothing to list without a My Cloud, and a My Cloud that can't answer says nothing", async () => {
  const none = fixture({ home: false });
  try { assert.deepEqual((await none.handlers.get("cloud-send:team-bring")(OWN)).bots, []); } finally { none.done(); }
  const broken = fixture({ bots: null });
  try { assert.deepEqual((await broken.handlers.get("cloud-send:team-bring")(OWN)).bots, []); } finally { broken.done(); }
});

test("reads My Cloud once while the list is fresh: every read is one of the Admin's codes", async () => {
  const { handlers, pairs, done } = fixture();
  try {
    await handlers.get("cloud-send:team-bring")(OWN);
    await handlers.get("cloud-send:team-bring")(OWN);
    assert.equal(pairs.length, 1);
  } finally { done(); }
});

test("moves nothing until the person agrees in main's own confirm, which says there's no way back and what stays", async () => {
  const { handlers, asked, journal, done } = fixture({ agrees: false });
  try {
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, "atlas-bot-1");
    assert.deepEqual(answer, { started: false, move: null });
    assert.equal(journal.value, null);
    assert.equal(asked[0].message, "Move Atlas to Acme?");
    assert.match(asked[0].detail, /no way back/);
    assert.match(asked[0].detail, /what Atlas remembers, your connections, and MausBot/);
    assert.deepEqual(asked[0].buttons, ["Move to Acme", "Cancel"]);
  } finally { done(); }
});

test("moves the bot once they agree, into the page's own team, under the name My Cloud has", async () => {
  const { handlers, journal, done } = fixture({ agrees: true });
  try {
    const answer = await handlers.get("cloud-send:team-bring-move")(OWN, "atlas-bot-1", "a name from the page");
    assert.equal(answer.started, true);
    assert.deepEqual(journal.value.moves.map((move) => [move.bot.id, move.bot.name, move.team.id]), [["atlas-bot-1", "Atlas", "team-acme"]]);
    assert.deepEqual(await handlers.get("cloud-send:team-bring-status")(OWN), { bot: { id: "atlas-bot-1", name: "Atlas" }, team: { id: "team-acme", name: "Acme" }, phase: "moving" });
    assert.equal(await handlers.get("cloud-send:team-bring-status")({ origin: OTHER }), null, "another team's page reads nothing of it");
  } finally { done(); }
});

test("refuses what can't go, a bot My Cloud doesn't have, a team not ready and a page that isn't the team's, before asking", async () => {
  const { handlers, asked, journal, done } = fixture({ agrees: true });
  try {
    const move = handlers.get("cloud-send:team-bring-move");
    await assert.rejects(move(OWN, "maus-bot-1"), /Choose one of your bots/);
    await assert.rejects(move(OWN, "chief-bot-1"), /Choose one of your bots/);
    await assert.rejects(move(OWN, "elsewhere-1"), /Choose one of your bots/);
    await assert.rejects(move({ origin: OTHER }, "atlas-bot-1"), /Open the team/);
    await assert.rejects(move({}, "atlas-bot-1"), /Open the team/);
    assert.deepEqual(asked, []);
    assert.equal(journal.value, null);
  } finally { done(); }
});

test("keeps the last bot on My Cloud, and leaves out what already left", () => {
  assert.deepEqual(bringableBots([{ id: "atlas-bot-1", name: "Atlas" }]), [{ id: "atlas-bot-1", name: "Atlas", stays: "last" }]);
  assert.deepEqual(bringableBots([{ id: "gone-bot-01", name: "Gone", movedTo: {} }, { id: "atlas-bot-1", name: "Atlas" }, { id: "x y", name: "Bad id" }]), [{ id: "atlas-bot-1", name: "Atlas", stays: "last" }]);
  assert.deepEqual(bringableBots(null), []);
});

test("its confirm says what the page's confirm says, word for word", () => {
  const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8"));
  const fill = (key) => en[key].replaceAll("{bot}", "Atlas").replaceAll("{team}", "Acme");
  const words = teamMoveConfirmWords({ bot: "Atlas", team: "Acme" });
  assert.equal(words.message, fill("teamMove.title"));
  assert.equal(words.buttons[0], fill("teamMove.confirm"));
  for (const key of ["teamMove.everyone", "teamMove.goes", "teamMove.private", "teamMove.staysOnMyCloud", "teamMove.noWayBack"]) assert.ok(words.detail.includes(fill(key)), key);
});

// A team bot is its maker's until they share it, on a real Team Cloud: Acme's Owner (Olive), an Admin (Ada) and two
// Users (Rui, Marta), each paired with the Admin's signed claim. Every way a bot comes to exist there is tried: New bot,
// a preset, a copy, a package, a backup and a bot a User moves in. Each starts as Only people added with nobody added,
// another User gets 404 for it by id and never sees it in a list, a request that says who can use it still wins, and
// sharing it with one person puts one line in that person's inbox. Off a team nothing changes.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const RUI = { email: "rui@acme.test", role: "member" as const };
const MARTA = { email: "marta@acme.test", role: "member" as const };
const PRIVATE = { everyone: "none", people: {} };

type Access = { everyone: string; people: Record<string, string> };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; yourAccess?: string; access?: Access; visibility?: unknown; createdBy?: string; onlyPeopleAdded?: true };
type Row = { kind: string; text: string; from: { name: string; email?: string }; origin?: { botId: string; threadId: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
const token: Record<string, string> = {};

const as = (who: string, method: string, path: string, body?: unknown) => team.as(token[who]!, method, path, body);
const bots = async (who: string) => (await as(who, "GET", "/api/bots?messages=0")).body.bots as Bot[];
const botOf = async (who: string, id: string) => (await bots(who)).find((bot) => bot.id === id);
const inbox = async (who: string) => ((await as(who, "GET", "/api/inbox")).body.rows ?? []) as Row[];
const made = async (who: string, body: Record<string, unknown>) => {
  const created = await as(who, "POST", "/api/bots", body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};

/** Nobody but whoever looks after it and the admins: not in a User's list, and 404 on every route that names it. */
async function hiddenFrom(who: string, bot: Bot): Promise<void> {
  expect((await bots(who)).some((listed) => listed.id === bot.id), `${who} lists ${bot.name}`).toBe(false);
  const main = bot.mainThreadId ?? bot.threadId;
  for (const [method, path, body] of [
    ["GET", `/api/threads/${main}/messages?limit=5`, undefined],
    ["GET", `/api/bots/${bot.id}/memory/mine`, undefined],
    ["POST", `/api/bots/${bot.id}/tasks`, {}],
    ["POST", `/api/bots/${bot.id}/messages`, { text: "hello" }],
    ["PATCH", `/api/bots/${bot.id}`, { name: "Mine now" }],
    ["PUT", `/api/bots/${bot.id}/access`, { everyone: "chat", people: {} }],
    ["POST", `/api/bots/${bot.id}/access-request`, {}],
  ] as const) {
    const answer = await as(who, method, path, body);
    expect(answer.status, `${who} ${method} ${path}: ${JSON.stringify(answer.body)}`).toBe(404);
  }
  const search = await as(who, "GET", `/api/search?q=${encodeURIComponent(bot.name)}`);
  expect(JSON.stringify(search.body), `${who} finds ${bot.name} by searching`).not.toContain(bot.id);
}

/** As private as a team bot starts: its maker and the admins edit it, and no User reaches it. */
async function startsPrivate(bot: Bot, owner: string, others: string[]): Promise<void> {
  const mine = (await botOf(owner, bot.id))!;
  expect(mine.access, `${bot.name} as ${owner} has it`).toEqual(PRIVATE);
  expect(mine.yourAccess).toBe("edit");
  expect(mine.onlyPeopleAdded).toBe(true);
  for (const admin of ["olive", "ada"]) expect((await botOf(admin, bot.id))?.yourAccess, `${admin} reaches ${bot.name}`).toBe("edit");
  for (const who of others) await hiddenFrom(who, bot);
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-private-default-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-private", name: "Acme" } });
  team = fx.team!;
  for (const [who, member] of Object.entries({ olive: OLIVE, ada: ADA, rui: RUI, marta: MARTA })) {
    const paired = await team.pair(member);
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    token[who] = paired.token!;
  }
  for (const who of ["rui", "marta"]) await as(who, "GET", "/api/inbox");
}, hostTimeout(240_000));

afterAll(async () => { await fx?.close(); }, hostTimeout(60_000));

describe("a team bot is its maker's until they share it", () => {
  it("the team's first bot, which nobody made, stays everyone's", async () => {
    const seed = (await bots("ada")).find((bot) => bot.name === "Seedling")!;
    expect(seed.access).toEqual({ everyone: "chat", people: {} });
    expect((await botOf("marta", seed.id))?.yourAccess).toBe("chat");
  });

  it("New bot: only its maker and the admins reach it", async () => {
    const quotes = await made("ada", { name: "Quotes" });
    expect(quotes.access).toEqual(PRIVATE);
    expect(quotes.createdBy).toBe(ADA.email);
    await startsPrivate(quotes, "ada", ["rui", "marta"]);
  });

  it("New bot looked after by someone else is that person's", async () => {
    const desk = await made("ada", { name: "Rui's desk", reportsTo: RUI.email });
    expect((await botOf("rui", desk.id))?.yourAccess).toBe("edit");
    expect((await botOf("rui", desk.id))?.access).toEqual(PRIVATE);
    await hiddenFrom("marta", desk);
  });

  it("a request that says who can use it still wins", async () => {
    const open = await made("ada", { name: "Open", visibility: "everyone" });
    expect(open.access).toEqual({ everyone: "chat", people: {} });
    for (const who of ["rui", "marta"]) expect((await botOf(who, open.id))?.yourAccess, who).toBe("chat");

    const listed = await made("ada", { name: "Listed", visibility: { people: [MARTA.email] } });
    expect((await botOf("marta", listed.id))?.yourAccess).toBe("chat");
    await hiddenFrom("rui", listed);

    const closed = await made("ada", { name: "Closed", visibility: "admins" });
    for (const who of ["rui", "marta"]) await hiddenFrom(who, closed);
  });

  it("a copy of a shared bot is its maker's, as the app's Duplicate asks for it", async () => {
    const copy = await made("olive", { name: "Open copy" });
    await startsPrivate(copy, "olive", ["rui", "marta"]);
  });

  it("a preset's bot starts private too", async () => {
    const defaults = await as("ada", "PATCH", "/api/config", { newBotDefaults: { profile: { name: "Sky", soul: "Be kind.\n" }, memory: {}, skills: [], routines: [] } });
    expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
    const saved = await as("ada", "POST", "/api/teams/export", { format: "package", version: 2, kind: "library", presetName: "Support agent" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const library = await as("ada", "POST", "/api/teams/import", saved.body.document);
    expect(library.status, JSON.stringify(library.body)).toBe(201);
    const preset = library.body.presets[0].id as string;
    const agent = await made("ada", { name: "Agent", preset, useDefaults: false });
    await startsPrivate(agent, "ada", ["rui", "marta"]);
  });

  it("a package and a backup: the bots are the importer's, unless the admin says who sees them", async () => {
    const manifest = { format: "openmaus.team", version: 2, team: { name: "Desk", members: [{ key: "helper", name: "Desk helper", appearance: { color: "blue" } }] } };
    const imported = await as("ada", "POST", "/api/teams/import?mode=add", manifest);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const helper = imported.body.bots[0] as Bot;
    expect(helper.createdBy).toBe(ADA.email);
    await startsPrivate(helper, "ada", ["rui", "marta"]);

    const shared = await as("ada", "POST", "/api/teams/import?mode=add&visibility=everyone", { ...manifest, team: { ...manifest.team, name: "Open desk" } });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    for (const who of ["rui", "marta"]) expect((await botOf(who, shared.body.bots[0].id))?.yourAccess, who).toBe("chat");

    const backup = await as("olive", "POST", "/api/teams/export", { format: "backup", name: "Acme copy" });
    expect(backup.status, JSON.stringify(backup.body)).toBe(200);
    const before = new Set((await bots("olive")).map((bot) => bot.id));
    const restored = await as("olive", "POST", "/api/teams/import?mode=add", backup.body);
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    const fresh = (restored.body.bots as Bot[]).filter((bot) => !before.has(bot.id));
    expect(fresh.length).toBeGreaterThan(0);
    const seenByMarta = new Set((await bots("marta")).map((bot) => bot.id));
    for (const bot of fresh) {
      expect((await botOf("olive", bot.id))?.access, bot.name).toEqual(PRIVATE);
      expect(seenByMarta.has(bot.id), `Marta sees ${bot.name}`).toBe(false);
    }
    await hiddenFrom("marta", fresh[0]!);
  });

  it("a bot a User moves in from My Cloud is theirs: no other User reaches it", async () => {
    const id = `moved-${randomBytes(6).toString("hex")}`;
    const begun = await as("rui", "POST", "/api/team-move-in", { v: 1, bot: { id, name: "Atlas" }, label: "Rui" });
    expect(begun.status, JSON.stringify(begun.body)).toBe(200);
    const moving = await team.as(begun.body.token, "POST", "/api/bots", { id, name: "Atlas", useDefaults: false });
    expect(moving.status, JSON.stringify(moving.body)).toBe(201);
    const done = await team.as(begun.body.token, "POST", `/api/team-move-in/${id}/done`, { v: 1, on: [] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const atlas = (await botOf("rui", id))!;
    expect(atlas.createdBy).toBe(RUI.email);
    await startsPrivate(atlas, "rui", ["marta"]);
  });

  it("sharing it with one person tells that person once; sharing with everyone tells nobody", async () => {
    const ledger = await made("ada", { name: "Ledger" });
    await hiddenFrom("marta", ledger);
    const notices = async (who: string) => (await inbox(who)).filter((row) => row.kind === "notice" && row.text.includes("Ledger"));

    expect((await as("ada", "PUT", `/api/bots/${ledger.id}/access`, { everyone: "none", people: { [MARTA.email]: "chat" } })).status).toBe(200);
    const told = await notices("marta");
    expect(told.map((row) => row.text)).toEqual(["Ada shared Ledger with you."]);
    expect(told[0]!.origin).toMatchObject({ botId: ledger.id, threadId: ledger.mainThreadId ?? ledger.threadId });
    expect(await notices("rui")).toEqual([]);
    expect((await botOf("marta", ledger.id))?.yourAccess).toBe("chat");
    expect((await botOf("marta", ledger.id))?.access, "someone who can only chat is never sent who else was added").toBeUndefined();
    await hiddenFrom("rui", ledger);
    const sent = await as("marta", "POST", `/api/bots/${ledger.id}/messages`, { text: "What's the total?" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);

    expect((await as("ada", "PUT", `/api/bots/${ledger.id}/access`, { everyone: "chat", people: { [MARTA.email]: "chat" } })).status).toBe(200);
    expect((await botOf("rui", ledger.id))?.yourAccess).toBe("chat");
    expect(await notices("rui"), "sharing with everyone sends nothing").toEqual([]);
    expect((await notices("marta")).length, "and nothing more to someone already added").toBe(1);

    expect((await as("ada", "PUT", `/api/bots/${ledger.id}/access`, { everyone: "chat", people: { [MARTA.email]: "chat", [RUI.email]: "edit" } })).status).toBe(200);
    expect(await notices("rui"), "adding someone who could already use it sends nothing").toEqual([]);
  });

  it("what was shared before stays shared across a restart, and what was private stays private", async () => {
    const before = Object.fromEntries((await bots("olive")).map((bot) => [bot.id, bot.access]));
    const martas = (await bots("marta")).map((bot) => bot.id).sort();
    await team.relaunch();
    for (const [who, member] of Object.entries({ olive: OLIVE, marta: MARTA })) token[who] = (await team.pair(member)).token!;
    expect(Object.fromEntries((await bots("olive")).map((bot) => [bot.id, bot.access]))).toEqual(before);
    expect((await bots("marta")).map((bot) => bot.id).sort()).toEqual(martas);
  }, hostTimeout(120_000));
});

describe("anywhere but a team", () => {
  it("a new bot on this computer and on My Cloud is as it always was: no sharing, everyone who signs in", async () => {
    for (const place of [fx.local, fx.onCloud]) {
      const created = await place("POST", "/api/bots", { name: "Plain" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.bot.access).toBeUndefined();
      expect(created.body.bot.visibility).toBeUndefined();
      expect(created.body.bot.createdBy).toBeUndefined();
    }
  });
});

// A skill on "all my bots" on a real Team Cloud: Ada (an Admin) puts one of her skills on all of her bots, and it reaches
// each bot she owns, one she makes later too, and never the Owner's; the Owner can neither put it on nor take it off
// Ada's bots, and a User cannot reach these routes at all (skills stay an admin's on a team, as before). Ada's switch on
// one bot is that bot's only, and one removal takes it off every bot of hers. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const SKILL = "---\nname: client-onboarding\ndescription: Sets up a new client the way Ada does.\n---\n\n# Client onboarding\n\nMake the folder, then the intake sheet.\n";

type Bot = { id: string; name: string };
let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", ada = "", bob = "";

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  ada = (await team.pair(ADA)).token!;
  bob = (await team.pair(BOB)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

const create = async (token: string, name: string) => {
  const created = await team.as(token, "POST", "/api/bots", { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as Bot;
};
const skillsOf = async (bot: Bot) => {
  const listed = await team.as(olive, "GET", `/api/bots/${bot.id}/skills`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.skills as Array<{ name: string; enabled: boolean; allBots?: boolean }>).filter((skill) => skill.name === "client-onboarding");
};
const allBots = (token: string, bot: Bot) => team.as(token, "POST", `/api/bots/${bot.id}/skills/client-onboarding/all-bots`);

it("reaches only the person's own bots, and only that person can put it on or take it off", async () => {
  const adasWriter = await create(ada, "Ada's Writer");
  const adasResearcher = await create(ada, "Ada's Researcher");
  const olivesBot = await create(olive, "Olive's Helper");
  const adasKeeper = await create(ada, "Ada's Keeper");
  const different = SKILL.replace("Make the folder", "Ask first, then make the folder");
  expect((await team.as(ada, "POST", `/api/bots/${adasKeeper.id}/skill-template`, { name: "client-onboarding", description: "", source: "test", text: different, enabled: true })).status).toBe(201);
  const added = await team.as(ada, "POST", `/api/bots/${adasWriter.id}/skill-template`, { name: "client-onboarding", description: "", source: "test", text: SKILL, enabled: true });
  expect(added.status, JSON.stringify(added.body)).toBe(201);

  expect((await allBots(olive, adasWriter)).status).toBe(403);
  expect((await allBots(bob, adasWriter)).status).toBe(403);
  const put = await allBots(ada, adasWriter);
  expect(put.status, JSON.stringify(put.body)).toBe(200);

  const later = await create(ada, "Ada's Later Bot");
  for (const bot of [adasWriter, adasResearcher, later]) {
    expect(await skillsOf(bot)).toEqual([expect.objectContaining({ enabled: true, allBots: true })]);
  }
  expect(await skillsOf(olivesBot)).toEqual([]);

  // A bot with a different copy of its own keeps it, and cannot silently replace the one on all of Ada's bots.
  expect(await skillsOf(adasKeeper)).toEqual([expect.not.objectContaining({ allBots: true })]);
  expect((await allBots(ada, adasKeeper)).status).toBe(409);
  expect((await team.as(ada, "DELETE", `/api/bots/${adasKeeper.id}/skills/client-onboarding`)).status).toBe(200);
  expect(await skillsOf(adasKeeper)).toEqual([expect.objectContaining({ allBots: true })]);

  expect((await team.as(olive, "DELETE", `/api/bots/${adasResearcher.id}/skills/client-onboarding/all-bots`)).status).toBe(403);
  expect(await skillsOf(adasResearcher)).toHaveLength(1);
  // A plain delete of one bot's shared copy, as a send, a move or a team file replaces a skill with, takes it off no bot.
  expect((await team.as(ada, "DELETE", `/api/bots/${adasResearcher.id}/skills/client-onboarding`)).status).toBe(409);
  for (const bot of [adasWriter, adasResearcher, later, adasKeeper]) expect(await skillsOf(bot)).toEqual([expect.objectContaining({ allBots: true })]);

  expect((await team.as(ada, "PATCH", `/api/bots/${adasResearcher.id}/skills/client-onboarding`, { enabled: false })).status).toBe(200);
  expect(await skillsOf(adasResearcher)).toEqual([expect.objectContaining({ enabled: false })]);
  expect(await skillsOf(adasWriter)).toEqual([expect.objectContaining({ enabled: true })]);

  expect((await team.as(ada, "DELETE", `/api/bots/${adasWriter.id}/skills/client-onboarding/all-bots`)).status).toBe(200);
  for (const bot of [adasResearcher, later, adasKeeper]) expect(await skillsOf(bot)).toEqual([]);
  // The bot whose own skill it was keeps it.
  expect(await skillsOf(adasWriter)).toEqual([expect.not.objectContaining({ allBots: true })]);
}, hostTimeout(120_000));

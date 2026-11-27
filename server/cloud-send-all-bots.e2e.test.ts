// A skill on all of the person's bots, moved to their own Cloud: each bot's copy is one of its own skills, so the move
// carries it with that bot's switch, and My Cloud, which has no record of the person's all-bots skills yet, keeps it as
// the bot's own. Two real servers with main's own wiring between them (scripts/testing/cloud-send-fixture.ts); no network.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const SKILL = "---\nname: client-onboarding\ndescription: Sets up a new client the way this person does.\n---\n\n# Client onboarding\n\nMake the folder, then the intake sheet.\n";
let fx: CloudSendFixture;

beforeAll(async () => { fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-allbots-${randomBytes(8).toString("hex")}` }); }, hostTimeout(60_000));
afterAll(async () => { await fx?.close(); });

type Skill = { name: string; enabled: boolean; allBots?: boolean };
const skillsOn = async (side: CloudSendFixture["local"], botId: string) =>
  ((await side("GET", `/api/bots/${botId}/skills`)).body.skills as Skill[]).filter((skill) => skill.name === "client-onboarding");

it("carries each bot's copy of a skill on all bots, with its switch, and My Cloud keeps it as the bot's own", async () => {
  const { local, onCloud } = fx;
  const newBot = async (name: string) => (await local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string };
  const writer = await newBot("Writer"), researcher = await newBot("Researcher");
  // Both bots have a conversation of their own, so the move does not pass them by as unused.
  for (const bot of [writer, researcher]) await local("PATCH", `/api/bots/${bot.id}`, { soul: `You are ${bot.id}.` });
  expect((await local("POST", `/api/bots/${writer.id}/skill-template`, { name: "client-onboarding", description: "", source: "test", text: SKILL, enabled: true })).status).toBe(201);
  expect((await local("POST", `/api/bots/${writer.id}/skills/client-onboarding/all-bots`)).status).toBe(200);
  expect((await local("PATCH", `/api/bots/${researcher.id}/skills/client-onboarding`, { enabled: false })).status).toBe(200);
  expect(await skillsOn(local, researcher.id)).toEqual([expect.objectContaining({ enabled: false, allBots: true })]);

  await fx.move();
  expect(await skillsOn(onCloud, writer.id)).toEqual([expect.objectContaining({ enabled: true })]);
  expect(await skillsOn(onCloud, researcher.id)).toEqual([expect.objectContaining({ enabled: false })]);
  expect((await onCloud("GET", `/api/bots/${writer.id}/skills/client-onboarding`)).body.text).toBe(SKILL);
}, hostTimeout(180_000));

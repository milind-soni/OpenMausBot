// A real Team Cloud with no AI: what a User reads when they press Send, what stays theirs, and what reaches the owner.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const USER = { email: "dana@acme.test", role: "member" as const };
const WORDS = "Our private numbers for the launch";
let fx: CloudSendFixture, team: CloudTeamFixture;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", noAi: true } });
  team = fx.team!;
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

const ownBot = async (token: string, email: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; threadId: string; defaultBot?: { person?: string }; modelSelection?: { instanceId?: string } }>).find((bot) => bot.defaultBot?.person === email)!;
const inboxRows = async (token: string) => ((await team.as(token, "GET", "/api/inbox")).body.rows ?? []) as Array<{ kind: string; text: string; from: { name: string } }>;

it("tells a User who connects the AI, sends nothing, and really tells the owner once they can be told", async () => {
  const dana = (await team.pair(USER)).token!;
  const maus = await ownBot(dana, USER.email);
  expect(maus.modelSelection?.instanceId, "this team has no AI").toBeFalsy();
  const send = () => team.as(dana, "POST", `/api/bots/${maus.id}/messages`, { text: WORDS, threadId: maus.threadId });

  const early = await send();
  expect(early).toMatchObject({ status: 409, body: { code: "no_ai", error: "The team's owner needs to connect an AI before bots can answer. I'll tell them when they first open the team." } });

  const olive = (await team.pair(OWNER)).token!;
  expect((await team.as(olive, "POST", "/api/presence/active", { source: "desktop" })).status).toBe(200);
  const lines = await inboxRows(olive);
  expect(lines.map((row) => [row.kind, row.from.name])).toEqual([["notice", "Dana"]]);
  expect(lines[0]!.text).toBe("Dana tried to use a bot in Acme, but no AI is connected yet. Connect one so bots can answer.");

  const later = await send();
  expect(later).toMatchObject({ status: 409, body: { code: "no_ai", error: "Olive needs to connect an AI before bots can answer. I've told them." } });
  expect(await inboxRows(olive), "not told twice in a day").toHaveLength(1);

  expect(JSON.stringify(lines), "the person's words stay theirs").not.toContain(WORDS);
  const after = await team.as(dana, "GET", "/api/bots?messages=50");
  const said = (after.body.bots as Array<{ id: string; messages?: Array<{ text?: string }> }>).find((bot) => bot.id === maus.id)!.messages;
  expect(Array.isArray(said), JSON.stringify(after.status)).toBe(true);
  expect(said!.some((line) => line.text === WORDS), "nothing was sent: the app keeps it in the box").toBe(false);
}, hostTimeout(120_000));

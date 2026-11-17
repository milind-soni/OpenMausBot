// A real Team Cloud (OMB_CLOUD_ROLE=team): each person's first screen is theirs alone. Who invited them comes from the
// Admin's signed claim only; whether they saw it, and the steps they finished, are kept per person, never team-wide.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { TEAM_LEFT_REFUSAL } from "../shared/cloud-hints.ts";

const ADA = { email: "ada@acme.test", role: "owner" as const };
const BOB = { email: "bob@acme.test", role: "admin" as const };
const CLEO = { email: "cleo@acme.test", role: "member" as const };

let fx: CloudSendFixture, team: CloudTeamFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-welcome-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
}, hostTimeout(60_000));

type Welcome = { invitedBy: string | null; welcomedAt: number | null; hints: string[] };
const welcomeOf = async (token: string) => (await team.as(token, "GET", "/api/me")).body.welcome as Welcome;

it("names who invited a member as the Admin signed it, never as the member says it; the Owner's names nobody", async () => {
  const ada = (await team.pair(ADA)).token!;
  expect(await welcomeOf(ada)).toEqual({ invitedBy: null, welcomedAt: null, hints: [] });
  const cleo = (await team.pair({ ...CLEO, invitedBy: "Bob@Acme.test" } as never)).token!;
  expect((await welcomeOf(cleo)).invitedBy).toBe("bob@acme.test");
  // A later pairing that says someone else keeps the first: it is who invited them.
  const again = (await team.pair({ ...CLEO, invitedBy: "ada@acme.test" } as never)).token!;
  expect((await welcomeOf(again)).invitedBy).toBe("bob@acme.test");
  // Nothing a member sends changes it.
  expect((await team.as(cleo, "PUT", "/api/me/welcome", { invitedBy: "eve@evil.test", welcomed: true })).status).toBe(200);
  expect((await welcomeOf(cleo)).invitedBy).toBe("bob@acme.test");
});

it("keeps whether each person saw the welcome, and the steps they finished, for that person alone", async () => {
  const bob = (await team.pair(BOB)).token!, ada = (await team.pair(ADA)).token!;
  const saved = await team.as(bob, "PUT", "/api/me/welcome", { welcomed: true, hints: ["cloud-welcome-done"] });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.welcome).toMatchObject({ hints: ["cloud-welcome-done"] });
  expect((await welcomeOf(bob)).welcomedAt).toEqual(expect.any(Number));
  expect(await welcomeOf(ada), "one admin's welcome ends nobody else's").toMatchObject({ welcomedAt: null, hints: [] });
  expect((await team.as(bob, "PUT", "/api/me/welcome", { hints: ["Not a step!"] })).status).toBe(400);
  expect((await team.as(bob, "PUT", "/api/me/welcome", { welcomed: false })).status).toBe(400);
  expect((await team.as(bob, "PUT", "/api/me/welcome", {})).status).toBe(400);
});

it("the Cloud's own welcome for admins: one admin finishing it ends it for that admin alone; its steps stay the team's", async () => {
  const ada = (await team.pair(ADA)).token!, bob = (await team.pair(BOB)).token!;
  const hints = async (token: string) => ((await team.as(token, "GET", "/api/config")).body.onboarding as { hintsSeen: string[] }).hintsSeen;
  const saved = await team.as(bob, "PUT", "/api/config", { onboarding: { hintsSeen: ["cloud-welcome-shown", "cloud-welcome-engine", "cloud-welcome-done"] } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(await hints(bob)).toEqual(expect.arrayContaining(["cloud-welcome-shown", "cloud-welcome-engine", "cloud-welcome-done"]));
  const adas = await hints(ada);
  expect(adas, "a step is a fact about the team's Cloud").toContain("cloud-welcome-engine");
  expect(adas).not.toContain("cloud-welcome-done");
  expect(adas).not.toContain("cloud-welcome-shown");
});

it("tells a signed-in member, never anyone before sign-in, where their team page on MausBot Cloud is", async () => {
  const cleo = (await team.pair(CLEO)).token!;
  expect((await team.as(cleo, "GET", "/api/auth/session")).body.teamSignIn).toMatch(/\/cloud\/team\/team-acme-1$/);
  const descriptor = await (await fetch(`${team.base}/.well-known/openmausbot/environment`, { headers: fx.edge })).json() as Record<string, unknown>;
  expect(JSON.stringify(descriptor)).not.toContain("/cloud/team/");
});

it("the welcome's one action, a chat with a bot, is the person's own private chat: the new conversation is marked private on the wire at once", async () => {
  const ada = (await team.pair(ADA)).token!, cleo = (await team.pair(CLEO)).token!;
  const made = await team.as(ada, "POST", "/api/bots", { name: "Research", description: "Briefs before a call.", visibility: "everyone" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const botId = made.body.bot.id as string;
  const opened = await team.as(cleo, "POST", `/api/bots/${botId}/tasks`, {});
  expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
  const threadId = opened.body.task.threadId as string;
  expect(threadId).not.toBe(made.body.bot.mainThreadId);
  expect(opened.body.bot.threadId).toBe(threadId);
  expect((opened.body.bot.tasks as Array<{ threadId: string; private?: boolean }>).find((task) => task.threadId === threadId)?.private).toBe(true);
});

it("a User's copy of a team bot carries what the welcome's one line reads, and a removed person's page is told why", async () => {
  const ada = (await team.pair(ADA)).token!;
  const made = await team.as(ada, "POST", "/api/bots", { name: "Seedling", visibility: "everyone" });
  await team.as(ada, "PATCH", `/api/bots/${made.body.bot.id}`, { soul: "You look after the team's plants." });
  const dee = (await team.pair({ email: "dee@acme.test", role: "member" })).token!;
  const copy = ((await team.as(dee, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; soul?: string }>).find((bot) => bot.id === made.body.bot.id);
  expect(copy?.soul).toBe("You look after the team's plants.");
  expect((await team.signed("POST", "/api/cloud/team/member-left", { email: "dee@acme.test" })).status).toBe(200);
  const after = await team.as(dee, "GET", "/api/auth/session");
  expect(after.status).toBe(401);
  expect(after.body.error).toBe(TEAM_LEFT_REFUSAL);
  // A session that simply ended says what it always said.
  const expired = await team.as("omb_sess_" + "x".repeat(43), "GET", "/api/auth/session");
  expect(expired.body.error).not.toBe(TEAM_LEFT_REFUSAL);
});

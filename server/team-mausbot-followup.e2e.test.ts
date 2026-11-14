// A real Team Cloud: what a User's own MausBot says about connecting an AI, and that it names the owner once the owner has
// opened the team.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture, team: CloudTeamFixture;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

async function followUp(email: string, role: "owner" | "admin" | "member") {
  const token = (await team.pair({ email, role })).token!;
  const mine = ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; threadId: string; defaultBot?: { person?: string } }>).find((bot) => bot.defaultBot?.person === email)!;
  const written = await team.as(token, "POST", `/api/bots/${mine.id}/helper-followup`, { ai: "none", threadId: mine.threadId });
  expect(written.status, JSON.stringify(written.body)).toBe(201);
  return written.body.message as { text: string; helperFollowup: { connects?: string } };
}

it("tells a User who connects the AI, never to sign in, and an admin still to sign in", async () => {
  const before = await followUp("dana@acme.test", "member");
  expect(before.text).toContain("The team's owner connects that");
  expect(before.helperFollowup.connects).toBe("");
  expect((await followUp("olive@acme.test", "owner")).text).toContain("Sign in with an account you already have");
  const after = await followUp("mara@acme.test", "member");
  expect(after.text).toContain("Olive connects that for the team");
  expect(after.text).not.toMatch(/sign in/i);
  expect((await followUp("ben@acme.test", "admin")).text).toContain("Sign in with an account you already have");
}, hostTimeout(120_000));

// A new member's first look at a Team Cloud: the list that makes their own MausBot shows it whole, its main chat
// included, the first time. Disposable homes and a synthetic Claude CLI; nothing leaves this machine.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Bot = { id: string; threadId?: string; mainThreadId?: string; defaultBot?: { person?: string }; tasks?: Array<{ threadId: string }>; messages?: Array<{ text?: string }> };

let fx: CloudSendFixture, team: CloudTeamFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-7", name: "Acme", engine: "" } });
  team = fx.team!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("the first list a new member asks for shows their own MausBot with its main chat and its hello", async () => {
  const mira = (await team.pair({ email: "mira@acme.test", role: "member" })).token!;
  const first = await team.as(mira, "GET", "/api/bots?messages=20");
  expect(first.status).toBe(200);
  const own = (first.body.bots as Bot[]).find((bot) => bot.defaultBot?.person === "mira@acme.test");
  expect(own, "their own MausBot is in the first list").toBeDefined();
  expect(own!.threadId).toBeTruthy();
  expect(own!.tasks?.map((task) => task.threadId)).toContain(own!.threadId);
  expect(own!.messages?.length, "its hello is there").toBeGreaterThan(0);
  expect((await team.as(mira, "GET", `/api/threads/${own!.threadId}/messages?limit=5`)).status).toBe(200);
}, hostTimeout(60_000));

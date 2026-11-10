// A conversation a person opens on a Team Cloud is private to them from its first frame: another member and an admin,
// listening on their streams while it is made, never get its id or its title, live or replayed, and no list or count
// carries it.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "admin" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const TITLE = "Kumquat salary talks";

type Bot = { id: string; threadId: string; unread?: boolean; tasks?: Array<{ threadId: string; title: string }> };

let fx: CloudSendFixture, team: CloudTeamFixture;
let ada = "", mira = "", ben = "";
let scout: Bot;

async function listen(token: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream", ...headers }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await expect.poll(() => text.includes("\"hello\""), { timeout: 10_000 }).toBe(true);
  return { text: () => text, cursor: /"cursor":"([^"]+)"/.exec(text)![1]!, close: async () => { controller.abort(); await done; } };
}
const scoutOf = async (token: string) => ((await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Bot[]).find((bot) => bot.id === scout.id)!;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-8", name: "Acme" } });
  team = fx.team!;
  ada = (await team.pair(ADA)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
  const created = await team.as(ada, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot as Bot;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("never shows another member or an admin a conversation someone opens, from its first frame on", async () => {
  const before = { ada: (await scoutOf(ada)).unread, ben: (await scoutOf(ben)).unread };
  const streams = { ada: await listen(ada), ben: await listen(ben) };
  const own = await listen(mira);
  const opened = await team.as(mira, "POST", `/api/bots/${scout.id}/tasks`, { title: TITLE });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const threadId = opened.body.task.threadId as string;
  await expect.poll(() => own.text().includes(threadId), { timeout: 10_000 }).toBe(true);
  expect((await scoutOf(mira)).tasks!.find((task) => task.threadId === threadId)?.title).toBe(TITLE);

  for (const [who, token] of [["ada", ada], ["ben", ben]] as const) {
    expect(streams[who].text(), `${who}: live stream`).not.toContain(threadId);
    expect(streams[who].text(), `${who}: live stream`).not.toContain(TITLE);
    const replayed = await listen(token, { "last-event-id": streams[who].cursor });
    expect(replayed.text(), `${who}: replayed stream`).not.toContain(threadId);
    expect(replayed.text(), `${who}: replayed stream`).not.toContain(TITLE);
    await replayed.close();
    const copy = await scoutOf(token);
    expect(copy.tasks!.map((task) => task.threadId), `${who}: list`).not.toContain(threadId);
    expect(copy.unread, `${who}: unread mark`).toBe(before[who]);
    expect(JSON.stringify((await team.as(token, "GET", "/api/bots")).body), `${who}: /api/bots`).not.toContain(TITLE);
  }
  for (const stream of [...Object.values(streams), own]) await stream.close();
}, hostTimeout(90_000));

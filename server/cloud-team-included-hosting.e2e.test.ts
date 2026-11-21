// The plan's included app hosting on a real Team Cloud (OMB_CLOUD_ROLE=team), tried as the people the rules must hold
// against: two members, an Admin and the Owner. A bot publishes folders of its own through its tool's route; the relay
// is a loopback stand-in, wired as the Admin wires a home. An app from a member's own chat is that member's alone, the
// team's app is everyone's to see and an Admin's or its bot's person's to delete, and the count is the team's.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { PublishedAppsList } from "../shared/published-apps.ts";
import { SITE_FILE } from "./host/netlify-sites.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeAppHosting, type FakeAppHosting } from "./testing/fake-app-hosting.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const GONE = { status: 404, body: { error: "No such published app.", code: "gone" } };
const TOKEN = "omb_host_team_fixture_token_0123456789abcdef";

type Bot = { id: string; name: string; threadId: string; mainThreadId?: string };

let fx: CloudSendFixture, team: CloudTeamFixture, fake: FakeAppHosting;
let scratch = "", replyFile = "", data = "";
let owner = "", admin = "", ada = "", ben = "";
let mira: Bot;
let adaThread = "", benThread = "", mainThread = "";
let portfolio = { key: "", url: "" }, teamSite = { key: "", url: "" };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(150);
  }
}
/** One turn in a conversation, answered by the bot with `reply`. */
async function turn(token: string, bot: Bot, threadId: string, reply: string): Promise<void> {
  const ended = async () => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as Array<{ turnTerminal?: boolean }>).filter((message) => message.turnTerminal).length;
  const before = await ended();
  writeFileSync(replyFile, reply);
  expect((await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text: "publish it", threadId })).status).toBe(202);
  await until(async () => (await ended()) > before);
}
/** publish_app's route, as a turn of `bot` in `threadId` calls it. */
async function tool(bot: Bot, threadId: string, input: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const answer = await fetch(`${team.base}/api/internal/apps/publish`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await team.capability(bot.id, threadId)}` }, body: JSON.stringify(input) });
  return { status: answer.status, body: await answer.json() as Record<string, any> };
}
function build(folder: string, title: string): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.html"), `<!doctype html><title>${title}</title><h1>${title}</h1>`);
  return folder;
}
const listOf = async (token: string) => {
  const answer = await team.as(token, "GET", "/api/published-apps");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as PublishedAppsList;
};
const titles = async (token: string) => (await listOf(token)).apps.map((app) => app.title).sort();

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "included-hosting-team-"));
  replyFile = join(scratch, "reply.txt");
  writeFileSync(replyFile, "Hello.");
  fake = await startFakeAppHosting(TOKEN, { apps: 20 });
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`,
    team: { id: "team-acme-hosting", name: "Acme", env: { OMB_CLOUD_HOSTING_URL: fake.url, OMB_CLOUD_HOSTING_TOKEN: TOKEN }, engine: `process.env.FAKE_CLAUDE_REPLY_FILE = ${JSON.stringify(replyFile)};` } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  ben = (await team.pair(BEN)).token!;
  mira = (await team.as(owner, "POST", "/api/bots", { name: "Mira", visibility: "everyone" })).body.bot;
  mainThread = mira.mainThreadId ?? mira.threadId;
  adaThread = (await team.as(ada, "POST", `/api/bots/${mira.id}/tasks`, { title: "Ada's portfolio" })).body.task.threadId;
  benThread = (await team.as(ben, "POST", `/api/bots/${mira.id}/tasks`, { title: "Ben's plan" })).body.task.threadId;
  await turn(ada, mira, adaThread, "I'll build your portfolio.");
  await turn(ben, mira, benThread, "I'll draft your plan.");
  data = join(team.home, ".openmausbot");
  expect(existsSync(join(data, "task-workspaces", mira.id, adaThread)), "a conversation's turns work in its own folder").toBe(true);
}, hostTimeout(300_000));

afterAll(async () => {
  await fx?.close();
  await fake?.stop();
  if (scratch) await removeTempDir(scratch);
});

it("publishes from a member's own chat and from the team's chat, each from the bot's own folder for that conversation", async () => {
  const adasFolder = build(join(data, "task-workspaces", mira.id, adaThread, "portfolio"), "Ada's portfolio");
  const published = await tool(mira, adaThread, { path: adasFolder, title: "Ada's portfolio" });
  expect(published, JSON.stringify(published)).toMatchObject({ status: 200, body: { ok: true, live: true, created: true, apps: "1 of 20" } });
  portfolio = { key: JSON.parse(readFileSync(join(adasFolder, SITE_FILE), "utf8")).appKey, url: published.body.url };

  // Ben's conversation with the same bot asks for Ada's folder: it is not one of that turn's own.
  const stolen = await tool(mira, benThread, { path: adasFolder, title: "Mine now" });
  expect(stolen).toEqual({ status: 400, body: { error: "Only a folder inside your own working folder can be published. Build the app there first.", code: "failed" } });
  expect((await tool(mira, benThread, { action: "delete", path: adasFolder })).status).toBe(400);
  expect((await tool(mira, benThread, { action: "status", path: adasFolder })).status).toBe(400);
  expect(fake.apps.size).toBe(1);

  const teamFolder = build(join(data, "workspaces", mira.id, "team-site"), "Team site");
  const shared = await tool(mira, mainThread, { path: teamFolder, title: "Team site" });
  expect(shared.body).toMatchObject({ ok: true, live: true, apps: "2 of 20" });
  teamSite = { key: JSON.parse(readFileSync(join(teamFolder, SITE_FILE), "utf8")).appKey, url: shared.body.url };
  await turn(owner, mira, mainThread, `The team site is live: ${teamSite.url}`);
  expect(fake.refused).toEqual([]);
  await sleep(2_100);
}, hostTimeout(120_000));

it("shows each person the apps from conversations they can read, and everyone the team's count", async () => {
  expect(await titles(ada)).toEqual(["Ada's portfolio", "Team site"]);
  for (const token of [ben, admin, owner]) {
    const seen = await listOf(token);
    expect(seen.apps.map((app) => app.title)).toEqual(["Team site"]);
    expect(JSON.stringify(seen)).not.toContain(portfolio.key);
    expect(JSON.stringify(seen)).not.toContain(portfolio.url);
  }
  for (const token of [ada, ben, admin, owner]) expect((await listOf(token)).included).toEqual({ used: 2, max: 20 });
  expect((await listOf(ada)).apps.find((app) => app.title === "Ada's portfolio")).toMatchObject({ id: `included-${portfolio.key}`, source: "included", url: portfolio.url,
    bot: { id: mira.id, name: "Mira" }, threadId: adaThread, access: "public", canDelete: true });
  expect((await listOf(ben)).apps[0]).toMatchObject({ id: `included-${teamSite.key}`, source: "included", threadId: mainThread, canDelete: false });
  expect((await listOf(admin)).apps[0]).toMatchObject({ canDelete: true });
});

it("answers another member, an Admin and the Owner guessing at a member's private app as if it did not exist", async () => {
  for (const [who, token] of [["Ben", ben], ["an Admin", admin], ["the Owner", owner]] as const) {
    expect(await team.as(token, "POST", "/api/published-apps/delete", { id: `included-${portfolio.key}` }), who).toEqual(GONE);
    const framing = await team.as(token, "GET", `/api/published-apps/framing?url=${encodeURIComponent(portfolio.url)}&origin=${encodeURIComponent("https://acme.mausbot.cloud")}`);
    expect(framing.status, who).toBe(404);
  }
  expect(fake.apps.has(portfolio.key)).toBe(true);
});

it("deletes through the relay for whoever may delete, and never for someone else's app", async () => {
  expect(await team.as(ben, "POST", "/api/published-apps/delete", { id: `included-${teamSite.key}` })).toEqual({ status: 403, body: { error: "This app isn't yours to delete.", code: "forbidden" } });
  expect(fake.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);

  const byAda = await team.as(ada, "POST", "/api/published-apps/delete", { id: `included-${portfolio.key}` });
  const byAdmin = await team.as(admin, "POST", "/api/published-apps/delete", { id: `included-${teamSite.key}` });
  expect([byAda, byAdmin]).toEqual([{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }]);
  expect(fake.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /apps/${portfolio.key}`, `DELETE /apps/${teamSite.key}`]);
  expect(fake.apps.size).toBe(0);
  expect(existsSync(join(data, "task-workspaces", mira.id, adaThread, "portfolio", SITE_FILE))).toBe(false);
  expect(existsSync(join(data, "task-workspaces", mira.id, adaThread, "portfolio", "index.html"))).toBe(true);
  expect(await listOf(ada)).toEqual({ apps: [], included: { used: 0, max: 20 } });
  expect(fake.refused).toEqual([]);
  expect(JSON.stringify([byAda, byAdmin, await team.as(owner, "GET", "/api/config")])).not.toContain(TOKEN);
});

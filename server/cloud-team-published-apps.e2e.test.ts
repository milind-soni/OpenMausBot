// Published apps on a real Team Cloud (OMB_CLOUD_ROLE=team) with the synthetic Claude CLI, tried as the people the
// rule must hold against: two members, an Admin and the Owner. A shared bot's Netlify site is listed for whoever can
// read the conversation it was published in (the conversation's own folder holds its record, or the bot's own message
// carries its link), a member's own MausBot's site for that member alone, and nobody's private project for anyone
// else, by list, by id or by address.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { PublishedApp } from "../shared/published-apps.ts";
import { SITE_FILE } from "./host/netlify-sites.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const GONE = { status: 404, body: { error: "No such published app.", code: "gone" } };

type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; defaultBot?: { person?: string }; tasks?: Array<{ threadId: string }> };

let fx: CloudSendFixture, team: CloudTeamFixture;
let scratch = "", replyFile = "";
let owner = "", admin = "", ada = "", ben = "";
let mira: Bot, adaMaus: Bot;
let adaThread = "", benThread = "", mainThread = "";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const botsOf = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
/** One turn in a conversation, answered by the bot with `reply`. */
async function turn(token: string, bot: Bot, threadId: string, reply: string): Promise<void> {
  const ended = async () => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as Array<{ turnTerminal?: boolean }>).filter((message) => message.turnTerminal).length;
  const before = await ended();
  writeFileSync(replyFile, reply);
  expect((await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text: "publish it", threadId })).status).toBe(202);
  await until(async () => (await ended()) > before);
}
const site = (name: string) => ({ version: 1, siteId: `id-${name}`, name, url: `https://${name}.netlify.app`, adminUrl: `https://app.netlify.com/projects/${name}`, title: `${name} site`,
  createdAt: "2026-11-10T10:00:00.000Z", publishedAt: "2026-11-10T10:05:00.000Z", access: "public" });
function record(folder: string, name: string): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, SITE_FILE), JSON.stringify(site(name)));
  return join(folder, SITE_FILE);
}
const listOf = async (token: string) => {
  const answer = await team.as(token, "GET", "/api/published-apps");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.apps as PublishedApp[];
};
const titles = async (token: string) => (await listOf(token)).map((app) => app.title).sort();

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "published-apps-team-"));
  replyFile = join(scratch, "reply.txt");
  writeFileSync(replyFile, "Hello.");
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`,
    team: { id: "team-acme-apps", name: "Acme", engine: `process.env.FAKE_CLAUDE_REPLY_FILE = ${JSON.stringify(replyFile)};` } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  ben = (await team.pair(BEN)).token!;
  mira = (await team.as(owner, "POST", "/api/bots", { name: "Mira" })).body.bot;
  adaMaus = (await botsOf(ada)).find((bot) => bot.defaultBot?.person === ADA.email)!;
  expect(adaMaus, "Ada has a MausBot of her own").toBeTruthy();
  mainThread = mira.mainThreadId ?? mira.threadId;
  adaThread = (await team.as(ada, "POST", `/api/bots/${mira.id}/tasks`, { title: "Ada's shop" })).body.task.threadId;
  benThread = (await team.as(ben, "POST", `/api/bots/${mira.id}/tasks`, { title: "Ben's plan" })).body.task.threadId;

  // Each conversation's turn says its own link, as the publish guide has the bot do.
  await turn(ada, mira, adaThread, "Published: https://adas-notes.netlify.app The link is public.");
  await turn(ben, mira, benThread, "Published: https://bens-plan.netlify.app The link is public.");
  await turn(owner, mira, mainThread, "The team site is live: https://team-site.netlify.app");
  await turn(ada, adaMaus, adaMaus.threadId, "Your diary is at https://adas-diary.netlify.app");

  const data = join(team.home, ".openmausbot");
  // Ada's shop was published from her conversation's own folder; the bot never wrote its link anywhere.
  expect(existsSync(join(data, "task-workspaces", mira.id, adaThread)), "a conversation's turns work in its own folder").toBe(true);
  record(join(data, "task-workspaces", mira.id, adaThread, "shop"), "adas-shop");
  // The rest sit in folders every conversation of the bot shares: the bot's message says whose they are.
  record(join(data, "workspaces", mira.id, "notes"), "adas-notes");
  record(join(data, "workspaces", mira.id, "plan"), "bens-plan");
  record(join(data, "workspaces", mira.id, "team-site"), "team-site");
  record(join(data, "workspaces", mira.id, "unsaid"), "never-mentioned");
  record(join(data, "workspaces", adaMaus.id, "diary"), "adas-diary");
  await sleep(2_100);
}, hostTimeout(300_000));

afterAll(async () => {
  await fx?.close();
  if (scratch) await removeTempDir(scratch);
});

it("shows each member their own projects and the team's, and none of another member's", async () => {
  expect(await titles(ada)).toEqual(["adas-diary site", "adas-notes site", "adas-shop site", "team-site site"]);
  expect(await titles(ben)).toEqual(["bens-plan site", "team-site site"]);
  const toldBen = JSON.stringify(await listOf(ben));
  for (const secret of ["adas-", adaThread, adaMaus.id, adaMaus.threadId]) expect(toldBen, secret).not.toContain(secret);
  const toldAda = JSON.stringify(await listOf(ada));
  for (const secret of ["bens-plan", benThread]) expect(toldAda, secret).not.toContain(secret);
  expect((await listOf(ada)).find((app) => app.title === "adas-shop site")).toMatchObject({ source: "netlify", bot: { id: mira.id, name: "Mira" }, threadId: adaThread, canDelete: true });
});

it("shows an Admin and the Owner what the shared bot published in the shared chat, and nobody's private project", async () => {
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner]] as const) {
    const seen = await listOf(token);
    expect(seen.map((app) => app.title), who).toEqual(["team-site site"]);
    expect(seen[0], who).toMatchObject({ threadId: mainThread, canDelete: true });
    expect(JSON.stringify(seen), who).not.toMatch(/adas-|bens-|never-mentioned/);
  }
});

it("lists nothing the bot never said in a conversation, for anyone", async () => {
  for (const token of [owner, admin, ada, ben]) expect(await titles(token)).not.toContain("never-mentioned site");
});

it("answers another member, an Admin and the Owner guessing at a private project as if it did not exist", async () => {
  for (const [who, token] of [["Ben", ben], ["an Admin", admin], ["the Owner", owner]] as const) {
    for (const id of [`netlify-${mira.id}-id-adas-shop`, `netlify-${mira.id}-id-adas-notes`, `netlify-${adaMaus.id}-id-adas-diary`]) {
      expect(await team.as(token, "POST", "/api/published-apps/delete", { id }), `${who}: ${id}`).toEqual(GONE);
    }
  }
  const data = join(team.home, ".openmausbot");
  expect(existsSync(join(data, "task-workspaces", mira.id, adaThread, "shop", SITE_FILE))).toBe(true);
  expect(existsSync(join(data, "workspaces", adaMaus.id, "diary", SITE_FILE))).toBe(true);
  expect(await titles(ada)).toEqual(["adas-diary site", "adas-notes site", "adas-shop site", "team-site site"]);
});

it("refuses a member who only chats with the shared bot for what it published in the shared chat", async () => {
  expect((await listOf(ben)).find((app) => app.title === "team-site site")?.canDelete).toBe(false);
  expect(await team.as(ben, "POST", "/api/published-apps/delete", { id: `netlify-${mira.id}-id-team-site` }))
    .toEqual({ status: 403, body: { error: "This app isn't yours to delete.", code: "forbidden" } });
});

it("uses nobody's saved Netlify token on a Team Cloud yet: Delete says so and offers the site's Netlify page", async () => {
  const saved = await team.as(owner, "POST", "/api/vault/secrets", { name: "Netlify personal access token", value: "nfp_team_token_that_must_not_be_used_000000", bots: "all" });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  for (const [token, id, name] of [[ada, `netlify-${mira.id}-id-adas-shop`, "adas-shop"], [admin, `netlify-${mira.id}-id-team-site`, "team-site"], [owner, `netlify-${mira.id}-id-team-site`, "team-site"]] as const) {
    const answer = await team.as(token, "POST", "/api/published-apps/delete", { id });
    expect(answer, id).toEqual({ status: 409, body: { error: expect.stringContaining("can't be deleted from here"), code: "no_token", manageUrl: `https://app.netlify.com/projects/${name}` } });
    expect(JSON.stringify(answer)).not.toContain("nfp_team_token");
  }
  expect(await titles(ada)).toEqual(["adas-diary site", "adas-notes site", "adas-shop site", "team-site site"]);
});

it("checks framing only for an address the asker is shown or a public hosting address, and refuses anything else", async () => {
  const framing = (token: string, url: string) => team.as(token, "GET", `/api/published-apps/framing?url=${encodeURIComponent(url)}&origin=${encodeURIComponent("https://acme.mausbot.cloud")}`);
  for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8799/api/bots", "https://example.com/", `${team.base}/api/bots`]) {
    expect((await framing(ben, url)).status, url).toBe(404);
  }
  expect(await team.as(ben, "GET", "/api/web-panels/framing?url=https%3A%2F%2Fexample.com&origin=https%3A%2F%2Facme.mausbot.cloud")).toMatchObject({ status: 403 });
});

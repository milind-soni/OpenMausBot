// Phone push on a Team Cloud, on by default (docs/phone-push.md): a stand-in Admin records what the Cloud asks it to relay.
// Acme's Owner Cleo and a member Ben each pair a phone and register it for closed-app alerts, with no switch set anywhere
// on the Cloud. A reply that finishes in one person's own private chat wakes only that person's phone, signed as this
// Cloud's machine, with names only and never the words. Live Activities are not offered on a Team Cloud (a bot's state
// there is everyone's, not one person's): a phone's activity tokens are neither kept nor registered, and no activity is
// ever pushed. Disposable homes; nothing leaves this machine.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { CLOUD_HOME_PUSH_ADMIN_PATH } from "./phone-push-admin.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CLEO = { email: "cleo@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const TEAM_MACHINE = "0d9e8f7a-6b5c-4d3e-9f8a-7b6c5d4e3f2a";
const CLEO_TOKEN = "c1".repeat(32);
const BEN_TOKEN = "b2".repeat(32);
const START_TOKEN = "5a".repeat(40);
const ACTIVITY_TOKEN = "ac".repeat(40);
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_REPLY_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/reply.txt";`;

type Bot = { id: string; name: string; threadId: string; busy?: boolean; activity?: string };
type Relayed = { action: string; raw: string; body: Record<string, any>; signed: boolean };
const relayed: Relayed[] = [];
let adminServer: Server, fx: CloudSendFixture, team: CloudTeamFixture;
let cleo = "", ben = "", scout: Bot;

const sends = () => relayed.filter((call) => call.action === "send");
const file = (name: string) => join(team.home, name);
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** One finished reply in `token`'s own private chat with Scout; its thread id. */
async function privateTurn(token: string, title: string, text: string, reply: string): Promise<string> {
  const own = await team.as(token, "POST", `/api/bots/${scout.id}/tasks`, { title });
  expect(own.status, JSON.stringify(own.body)).toBe(201);
  const threadId = own.body.task.threadId as string;
  writeFileSync(file("reply.txt"), reply);
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(token, "POST", `/api/bots/${scout.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => existsSync(file("dump.json")));
  await until(async () => (await bots(cleo)).every((bot) => !bot.busy && bot.activity !== "working")
    && ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as { role: string; text?: string }[]).some((row) => row.role === "bot" && row.text === reply));
  return threadId;
}

beforeAll(async () => {
  adminServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      if (!url.startsWith(CLOUD_HOME_PUSH_ADMIN_PATH)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Not found." })); return; }
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers = req.headers as Record<string, string>;
      const action = url.slice(CLOUD_HOME_PUSH_ADMIN_PATH.length);
      relayed.push({ action, raw, body: JSON.parse(raw), signed: (headers["x-omb-cloud-signature"] ?? "").startsWith("v1=") && headers["x-omb-cloud-machine"] === TEAM_MACHINE });
      if (action === "unregister") { res.writeHead(204); res.end(); return; }
      res.writeHead(action === "register" ? 200 : 202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => adminServer.listen(0, "127.0.0.1", resolve));
  fx = await launchCloudSendFixture({ onePasswordToken: "ops_fake-team-push", team: { id: "team-acme-push", name: "Acme", engine: ENGINE, env: {
    OMB_BOT_BOX: "0", FIXTURE_ADMIN_STAND_IN: `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`,
  } } });
  team = fx.team!;
  cleo = (await team.pair(CLEO)).token!;
  ben = (await team.pair(BEN)).token!;
  await bots(ben);
  const created = await team.as(cleo, "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot as Bot;
  expect((await team.as(cleo, "PATCH", `/api/bots/${scout.id}`, { notifications: true })).status).toBe(200);
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
  await new Promise((resolve) => adminServer?.close(resolve));
});

it("with no switch set, both phones register through the Admin, signed as this Cloud", async () => {
  expect(relayed).toEqual([]);
  for (const [token, device] of [[cleo, CLEO_TOKEN], [ben, BEN_TOKEN]] as const) {
    const put = await team.as(token, "PUT", "/api/push/device", { platform: "apns", token: device });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ push: "on", relay: "registered", device: { platform: "apns" } });
  }
  expect(relayed.map(({ action, body, signed }) => ({ action, token: body.token, signed }))).toEqual([
    { action: "register", token: CLEO_TOKEN, signed: true },
    { action: "register", token: BEN_TOKEN, signed: true },
  ]);
}, hostTimeout(60_000));

it("offers no Live Activities: a phone's activity tokens are neither kept nor registered", async () => {
  for (const token of [cleo, ben]) {
    const put = await team.as(token, "PUT", "/api/push/activity", {
      scheme: "openmausbot", headlines: { needsYou: "{name} needs you", working: "{name} is working" },
      startToken: START_TOKEN, activities: [{ botId: scout.id, token: ACTIVITY_TOKEN }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toEqual({ push: "on", activity: null });
  }
  expect(relayed.filter((call) => call.action !== "register" || call.body.purpose !== undefined)).toEqual([]);
}, hostTimeout(60_000));

it("a reply finishing in one person's private chat wakes only that person's phone, with names and never the words", async () => {
  const bensThread = await privateTurn(ben, "Ben and Scout", "Draft my resignation letter for Globex", "Here is the letter.");
  await until(() => sends().length >= 1, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(sends().map(({ body, signed }) => ({ token: body.token, kind: body.notification.kind, threadId: body.notification.threadId, signed }))).toEqual([
    { token: BEN_TOKEN, kind: "done", threadId: bensThread, signed: true },
  ]);

  const cleosThread = await privateTurn(cleo, "Cleo and Scout", "Summarise the salary review for the board", "Here is the summary.");
  await until(() => sends().length >= 2, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(sends().slice(1).map(({ body }) => ({ token: body.token, threadId: body.notification.threadId }))).toEqual([
    { token: CLEO_TOKEN, threadId: cleosThread },
  ]);
  expect(sends()[0]!.body.notification).toEqual({ kind: "done", title: "Scout finished", botId: scout.id, botName: "Scout", threadId: bensThread });
  expect(relayed.map((call) => call.raw).join("")).not.toMatch(/resignation|Globex|letter|salary|summary|board|Ben and Scout|Cleo and Scout/);
  // Neither person's phone was sent another's work, or anyone's, as a Live Activity.
  expect(relayed.filter((call) => call.action === "activity")).toEqual([]);
}, hostTimeout(120_000));

// Why each line is in a person's inbox on a Team Cloud, end to end: Acme's Owner Cleo and a member Ben, with the fake
// Claude CLI. Cleo's @Ben lands in Ben's inbox saying it mentioned him, in For you, counted; a routine Ben runs lands as
// Finished, in Activity, never counted. A line read can be made new again.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { InboxRow, InboxView } from "../shared/inbox.ts";
import { countsForYou, inboxGroup, inboxReason } from "../shared/inbox-reason.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; busy?: boolean; activity?: string };

let fx: CloudSendFixture, team: CloudTeamFixture;
let cleo = "", ben = "";
let scout: Bot, reporter: Bot;

async function until(done: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${fx.logs().slice(-4_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const inbox = async (token: string) => (await team.as(token, "GET", "/api/inbox")).body as InboxView;
const rows = async (token: string) => (await inbox(token)).rows ?? [];
const idle = async () => ((await team.as(cleo, "GET", "/api/bots")).body.bots as Bot[]).every((bot) => !bot.busy && bot.activity !== "working");

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-reasons-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-reasons", name: "Acme" } });
  team = fx.team!;
  cleo = (await team.pair({ email: "cleo@acme.test", role: "owner" })).token!;
  ben = (await team.pair({ email: "ben@acme.test", role: "member" })).token!;
  const create = async (body: Record<string, unknown>) => {
    const created = await team.as(cleo, "POST", "/api/bots", { visibility: "everyone", ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  scout = await create({ name: "Scout" });
  const chief = await create({ name: "Ben's Chief", reportsTo: "ben@acme.test" });
  expect((await team.as(cleo, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
  reporter = await create({ name: "Reporter", reportsTo: "ben@acme.test" });
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it("lands a teammate's @Ben in For you, saying it mentioned him, and counts it", async () => {
  const sent = await team.as(cleo, "POST", `/api/bots/${scout.id}/messages`, { text: "@Ben can you look at the new header?", threadId: scout.mainThreadId ?? scout.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => (await rows(ben)).some((row) => row.kind === "message"), "the mention in Ben's inbox");
  const line = (await rows(ben)).find((row) => row.kind === "message")!;
  expect(line).toMatchObject({ reason: "mentioned", from: { name: "Cleo" }, tab: "info", unread: true });
  expect(inboxReason(line)).toBe("mentioned");
  expect(inboxGroup(line)).toBe("for-you");
  expect(countsForYou(line)).toBe(true);
  await until(idle, "Scout to settle");
}, hostTimeout(120_000));

it("lands a bot's finished routine in Activity, never counted, and lets a read line be new again", async () => {
  const made = await team.as(ben, "POST", "/api/routines", { name: "Weekly report", prompt: "Sum up this week's leads.", botId: reporter.id, resultsThreadId: null,
    schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect((await team.as(ben, "POST", `/api/routines/${made.body.routine.id}/run`)).status).toBe(201);
  await until(async () => (await rows(ben)).some((row) => row.kind === "result"), "the routine's report in Ben's inbox", 90_000);
  const report = (await rows(ben)).find((row) => row.kind === "result")!;
  expect(report.from.name).toBe("Reporter");
  expect(inboxReason(report)).toBe("finished");
  expect(inboxGroup(report)).toBe("activity");
  expect(countsForYou(report)).toBe(false);
  const forYou = (list: InboxRow[]) => list.filter((row) => inboxGroup(row) === "for-you").map((row) => row.kind);
  expect(forYou(await rows(ben))).toEqual(["message"]);

  const read = await team.as(ben, "POST", `/api/inbox/${report.id}/read`);
  expect(read.status).toBe(200);
  expect((read.body as InboxView).rows.find((row) => row.id === report.id)).toMatchObject({ unread: false, tab: "done" });
  const again = await team.as(ben, "POST", `/api/inbox/${report.id}/unread`);
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect((again.body as InboxView).rows.find((row) => row.id === report.id)).toMatchObject({ unread: true, tab: "info" });
  expect((await team.as(cleo, "POST", `/api/inbox/${report.id}/unread`)).status, "only Ben's own lines").toBe(404);
}, hostTimeout(180_000));

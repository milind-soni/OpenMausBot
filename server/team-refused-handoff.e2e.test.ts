// A real Team Cloud with the fake engine: a routine that hands work to a bot shared with different people says so to the
// person who owns it, and nothing arrives. The engine's tool call is scripted, so this proves the rule and the report, not
// that a model would write that call.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const }, MEMBER = { email: "mara@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";`;
const REFUSED = "Rooms couldn't hand this to Bookkeeping, because they're shared with different people. Nothing was sent.";
const ONLY_MARA = { everyone: "none", people: { [MEMBER.email]: "chat" } };
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string };
let fx: CloudSendFixture, team: CloudTeamFixture, owner = "", member = "";
let rooms: Bot, hours: Bot, books: Bot;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const script = (calls: unknown[] | null) => { const file = join(team.home, "tool-calls.json"); if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true }); };
const handOff = (to: string, extra: Record<string, unknown> = {}) => ({ name: "coordinate_bots", server: "agents", input: { bot_ids: [to], message: "Rooms 12, Staff hours 86.", ...extra } });
const make = async (name: string, access: unknown) => {
  const made = await team.as(owner, "POST", "/api/bots", { name });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect((await team.as(owner, "PUT", `/api/bots/${made.body.bot.id}/access`, access)).status).toBe(200);
  return made.body.bot as Bot;
};
async function runRoutine(token: string, bot: Bot, name: string, calls: unknown[]) {
  const made = await team.as(token, "POST", "/api/routines", { name, prompt: "Send today's numbers on.", botId: bot.id, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  script(calls);
  const ran = await team.as(token, "POST", `/api/routines/${made.body.routine.id}/run`);
  const end = Date.now() + 90_000;
  for (;;) {
    const run = ((await team.as(token, "GET", "/api/routines")).body.runs as Array<{ id: string; status: string; error?: string; partial?: boolean; threadId?: string }>).find((candidate) => candidate.id === ran.body.run.id);
    if (run && ["completed", "failed"].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`the run did not end: ${JSON.stringify(run)}`);
    await sleep(200);
  }
}
const inbox = async (token: string) => ((await team.as(token, "GET", "/api/inbox")).body.rows ?? []) as Array<{ kind: string; text: string }>;
const lines = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ role: string; text?: string }>;
const refusedLine = (rows: Array<{ text: string }>) => rows.filter((row) => row.text.includes(REFUSED));

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  member = (await team.pair(MEMBER)).token!;
  rooms = await make("Rooms", ONLY_MARA);
  hours = await make("Staff Hours", ONLY_MARA);
  books = await make("Bookkeeping", { everyone: "none", people: {} });
}, hostTimeout(180_000));
afterAll(async () => { await fx?.close(); });

it("an owner's routine says the hand-off was refused, never completed, and the owner reads it in their inbox", async () => {
  const run = await runRoutine(owner, rooms, "Evening numbers", [handOff(books.id)]);
  expect(run).toMatchObject({ status: "failed", error: REFUSED, partial: true });
  await expect.poll(async () => refusedLine(await inbox(owner)).length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect((await lines(owner, books.threadId)).filter((line) => line.role === "user"), "nothing arrived").toEqual([]);
}, hostTimeout(120_000));

it("a member's routine, naming the bot, says so to the member", async () => {
  const run = await runRoutine(member, rooms, "Mara's numbers", [handOff("Bookkeeping")]);
  expect(run).toMatchObject({ status: "failed", error: REFUSED });
  await expect.poll(async () => refusedLine(await inbox(member)).length, { timeout: 10_000 }).toBeGreaterThan(0);
}, hostTimeout(120_000));

it("reaches who wrote the routine when the bot's failures go to someone else", async () => {
  expect((await team.as(owner, "PUT", `/api/bots/${hours.id}/reports-to`, { email: MEMBER.email })).status).toBe(200);
  const before = refusedLine(await inbox(owner)).length;
  const run = await runRoutine(owner, hours, "Hours", [handOff(books.id)]);
  expect(run).toMatchObject({ status: "failed" });
  await expect.poll(async () => (await inbox(owner)).filter((row) => row.text.includes("Staff Hours couldn't hand this to Bookkeeping")).length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(refusedLine(await inbox(owner)).length).toBe(before);
}, hostTimeout(120_000));

it("leaves a routine alone when its hand-off went through", async () => {
  const run = await runRoutine(owner, rooms, "Within the studio", [handOff(hours.id, { reply: "none" })]);
  expect(run.status).toBe("completed");
  expect(run.error).toBeUndefined();
}, hostTimeout(120_000));

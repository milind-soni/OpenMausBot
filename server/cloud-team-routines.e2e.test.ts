// A routine is where it lives (docs/team-cloud.md "Routines"). A real Team Cloud (OMB_CLOUD_ROLE=team) with the Owner,
// an Admin and two members, Bob and Ben: a routine Bob makes from his private chat, or points at it, is his alone in
// every list, stream, file, export and bot tool, and its runs land in his audience; one he makes for the shared chat
// stays the team's. When Bob leaves, his private routines go with his chats, the shared ones he wrote are handed to whoever
// looks after their bot (the Admins when nobody does), he is taken off every bot's sharing and "Looked after by", and
// the admins' Activity says so in counts. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const LATER = { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 };
type Routine = { id: string; name: string; enabled: boolean };
type Run = { id: string; routineId: string; status: string; threadId?: string; resultsThreadId?: string };
type Bot = { id: string; name: string; threadId: string; mainThreadId: string };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", bob = "", ben = "";
let scout: Bot, ledger: Bot;
let bobThread = "", benThread = "", fileName = "";
let kumquat = "", quince = "", standup = "", tally = "";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(100);
  }
}
const raw = (token: string, path: string) => fetch(`${team.base}${path}`, { headers: { ...fx.edge, authorization: `Bearer ${token}` } });
const routinesOf = async (token: string) => (await team.as(token, "GET", "/api/routines")).body as { routines: Routine[]; runs: Run[] };
const botsOf = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Array<Bot & { tasks: Array<{ threadId: string }>; reportsTo?: string; access?: { people: Record<string, string> } }>;
async function listen(token: string) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => text.includes("\"hello\""), 10_000);
  return { text: () => text, close: async () => { controller.abort(); await done; } };
}
/** A bot's own trigger tools, as its turn in that conversation calls them. */
async function tools(botId: string, threadId: string) {
  const token = await team.capability(botId, threadId);
  const call = (path: string, body?: unknown) => fetch(`${team.base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    list: async () => (await (await call(`/api/internal/triggers?fromBotId=${botId}`)).json()) as { triggers?: Array<{ id: string; name: string }> },
    change: (action: string, triggerId: string) => call("/api/internal/trigger-requests", { fromBotId: botId, fromThreadId: threadId, action, triggerId }),
    create: (name: string, instructions: string) => call("/api/internal/trigger-requests", { fromBotId: botId, fromThreadId: threadId, action: "create", kind: "schedule",
      routine: { name, instructions, schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } } }),
  };
}
async function runToEnd(token: string, routineId: string): Promise<Run> {
  const ran = await team.as(token, "POST", `/api/routines/${routineId}/run`);
  expect(ran.status, JSON.stringify(ran.body)).toBe(201);
  let run: Run | undefined;
  await until(async () => {
    run = (await routinesOf(token)).runs.find((candidate) => candidate.id === ran.body.run.id);
    return Boolean(run && ["completed", "failed"].includes(run.status));
  }, 90_000);
  return run!;
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  bob = (await team.pair(BOB)).token!;
  ben = (await team.pair(BEN)).token!;
  scout = (await team.as(owner, "POST", "/api/bots", { name: "Scout" })).body.bot;
  bobThread = (await team.as(bob, "POST", `/api/bots/${scout.id}/tasks`, { title: "Bob's plans" })).body.task.threadId;
  benThread = (await team.as(ben, "POST", `/api/bots/${scout.id}/tasks`, { title: "Ben's notes" })).body.task.threadId;
  const upload = await fetch(`${team.base}/api/attachments`, { method: "POST", headers: { ...fx.edge, authorization: `Bearer ${bob}`, "content-type": "image/png" }, body: PNG });
  expect(upload.status).toBe(201);
  const uploaded = ((await upload.json()) as { path: string }).path;
  fileName = uploaded.split(/[\\/]/).pop()!;
  // From the Automations page, reporting into his private chat, with a file.
  const made = await team.as(bob, "POST", "/api/routines", { name: "Kumquat follow-up", prompt: "Ask Kumquat Labs about my offer", botId: scout.id, schedule: LATER,
    resultsThreadId: bobThread, attachments: [{ id: "offer", kind: "image", name: "offer.png", path: uploaded, size: PNG.length }] });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  kumquat = made.body.routine.id;
  // The bot makes one in his private chat, as its trigger tool does.
  const proposed = await (await tools(scout.id, bobThread)).create("Quince reminder", "Remind Bob about the quince jam interview");
  expect(proposed.status).toBe(201);
  quince = ((await proposed.json()) as { result: { resultId: string } }).result.resultId;
  // One from the Automations page for the bot itself ("The bot's main thread"), which everyone who sees the bot sees.
  const shared = await team.as(bob, "POST", "/api/routines", { name: "Shared standup", prompt: "Post the standup summary", botId: scout.id, schedule: LATER, resultsThreadId: null });
  expect(shared.status, JSON.stringify(shared.body)).toBe(201);
  standup = shared.body.routine.id;
  // Ledger: only Bob and Ben added, and Bob looks after it.
  ledger = (await team.as(owner, "POST", "/api/bots", { name: "Ledger" })).body.bot;
  expect((await team.as(owner, "PUT", `/api/bots/${ledger.id}/access`, { everyone: "none", people: { [BOB.email]: "chat", [BEN.email]: "chat" } })).status).toBe(200);
  expect((await team.as(owner, "PUT", `/api/bots/${ledger.id}/reports-to`, { email: BOB.email })).status).toBe(200);
  const tallied = await team.as(bob, "POST", "/api/routines", { name: "Ledger tally", prompt: "Add up the week", botId: ledger.id, schedule: LATER, resultsThreadId: null });
  expect(tallied.status, JSON.stringify(tallied.body)).toBe(201);
  tally = tallied.body.routine.id;
}, hostTimeout(240_000));

afterAll(async () => {
  await fx?.close();
});

it("Bob's private routines are his: listed, changed and run by him, and a bot sees them only in his chat", async () => {
  const mine = await routinesOf(bob);
  expect(mine.routines.map((routine) => routine.id)).toEqual(expect.arrayContaining([kumquat, quince, standup, tally]));
  expect((await raw(bob, `/api/attachments/${fileName}`)).status).toBe(200);
  expect((await team.as(bob, "PATCH", `/api/routines/${kumquat}`, { name: "Kumquat follow-up" })).status).toBe(200);
  const inHisChat = (await (await tools(scout.id, bobThread)).list()).triggers!.map((trigger) => trigger.id);
  expect(inHisChat).toEqual(expect.arrayContaining([kumquat, quince, standup]));
}, hostTimeout(60_000));

it("nobody else sees, opens, changes, runs or fetches the file of Bob's private routines: not Ben, not an Admin, not the Owner", async () => {
  for (const [who, token] of [["Ben", ben], ["Admin", admin], ["Owner", owner]] as const) {
    const label = (what: string) => `${who}: ${what}`;
    for (const route of ["/api/routines", `/api/bots/${scout.id}/overview`, "/api/today"]) {
      const answer = JSON.stringify((await team.as(token, "GET", route)).body);
      expect(answer, label(route)).not.toContain("Kumquat");
      expect(answer, label(route)).not.toContain("Quince");
      expect(answer, label(route)).not.toContain(bobThread);
      expect(answer, label(route)).not.toContain(fileName);
    }
    const listed = (await routinesOf(token)).routines;
    expect(listed.map((routine) => routine.id), label("list")).toContain(standup);
    expect(listed.find((routine) => routine.id === standup), label("the chat it reports to is Bob's")).not.toHaveProperty("resultsThreadId");
    expect((await raw(token, `/api/attachments/${fileName}`)).status, label("file")).toBe(404);
    for (const id of [kumquat, quince]) {
      expect((await team.as(token, "PATCH", `/api/routines/${id}`, { enabled: false })).status, label("PATCH")).toBe(404);
      expect((await team.as(token, "POST", `/api/routines/${id}/run`)).status, label("run")).toBe(404);
      expect((await team.as(token, "DELETE", `/api/routines/${id}`)).status, label("DELETE")).toBe(404);
    }
  }
  for (const token of [owner, admin]) {
    const backup = await team.as(token, "POST", "/api/teams/export", { format: "backup" });
    expect(backup.status).toBe(200);
    expect(JSON.stringify(backup.body)).not.toContain("Kumquat");
    expect(JSON.stringify(backup.body)).not.toContain("Quince");
  }
  // A bot's tools in any other conversation neither list them nor reach them by id.
  for (const threadId of [benThread, scout.mainThreadId]) {
    const bot = await tools(scout.id, threadId);
    const ids = (await bot.list()).triggers!.map((trigger) => trigger.id);
    expect(ids).toContain(standup);
    expect(ids).not.toContain(kumquat);
    expect(ids).not.toContain(quince);
    for (const id of [kumquat, quince]) expect((await bot.change("pause", id)).status).toBe(404);
  }
  expect((await routinesOf(bob)).routines.filter((routine) => [kumquat, quince].includes(routine.id)).map((routine) => routine.enabled)).toEqual([true, true]);
}, hostTimeout(90_000));

it("never streams Bob's private routine to Ben or an Admin, while Bob's stream has it", async () => {
  const benStream = await listen(ben), adminStream = await listen(admin), bobStream = await listen(bob);
  expect((await team.as(bob, "PATCH", `/api/routines/${kumquat}`, { prompt: "Ask Kumquat Labs about the salary" })).status).toBe(200);
  await until(() => bobStream.text().includes("about the salary"), 10_000);
  await sleep(500);
  for (const [who, stream] of [["Ben", benStream], ["Admin", adminStream]] as const) {
    expect(stream.text(), who).not.toContain("Kumquat");
    expect(stream.text(), who).not.toContain(bobThread);
  }
  for (const stream of [benStream, adminStream, bobStream]) await stream.close();
}, hostTimeout(60_000));

it("a run of the routine the bot made in Bob's chat works and lands in his audience, never a chat the team reads", async () => {
  const run = await runToEnd(bob, quince);
  expect(run.status).toBe("completed");
  const where = [run.threadId, run.resultsThreadId].filter((id): id is string => Boolean(id));
  expect(where.length).toBeGreaterThan(0);
  for (const threadId of where) expect((await team.as(bob, "GET", `/api/threads/${threadId}/messages`)).status).toBe(200);
  expect(JSON.stringify((await team.as(bob, "GET", `/api/threads/${run.threadId}/messages`)).body)).toContain("quince jam");
  for (const token of [ben, admin, owner]) {
    const tasks = (await botsOf(token)).find((bot) => bot.id === scout.id)!.tasks.map((task) => task.threadId);
    for (const threadId of where) {
      expect(tasks).not.toContain(threadId);
      expect((await team.as(token, "GET", `/api/threads/${threadId}/messages`)).status).toBe(404);
    }
    expect(JSON.stringify((await routinesOf(token)).runs)).not.toContain(run.id);
  }
}, hostTimeout(120_000));

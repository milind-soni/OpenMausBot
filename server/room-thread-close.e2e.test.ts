// Closing a room's thread on a real Team Cloud: Ada (an Admin) makes a room of one bot that Bob may chat with, Vic may
// only view and Eve cannot see. Anyone who may post there closes or reopens any thread, the record says who and when,
// a new line opens a closed thread again, and closing leaves each person's unread mark alone. The engine is the
// synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { GroupTask } from "../shared/wire.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const VIC = { email: "vic@acme.test", role: "member" as const };
const EVE = { email: "eve@acme.test", role: "member" as const };

let fx: CloudSendFixture, team: CloudTeamFixture;
const token: Record<string, string> = {};
let room = "";

const as = (who: string, method: string, path: string, body?: unknown) => team.as(token[who]!, method, path, body);
const taskFor = async (who: string, threadId: string): Promise<GroupTask | undefined> =>
  ((await as(who, "GET", "/api/bots")).body.groups as Array<{ id: string; tasks?: GroupTask[] }>).find((group) => group.id === room)?.tasks?.find((task) => task.threadId === threadId);

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function answeredThread(who: string, text: string): Promise<string> {
  const created = await as(who, "POST", `/api/groups/${room}/tasks`, { activate: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const thread = created.body.task.threadId as string;
  expect((await as(who, "POST", `/api/groups/${room}/messages`, { text, threadId: thread })).status).toBeLessThan(300);
  await until(async () => {
    const task = await taskFor("ada", thread);
    return Boolean(task && !task.working && !task.busyBotId && (task.updatedAt ?? 0) > task.createdAt);
  });
  await until(async () => ((await as(who, "GET", `/api/threads/${thread}/messages`)).body.messages as Array<{ role: string; kind?: string }>)
    .some((message) => message.role === "bot" && (message.kind ?? "text") === "text"));
  return thread;
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-close", name: "Acme" } });
  team = fx.team!;
  for (const [who, member] of Object.entries({ ada: ADA, bob: BOB, vic: VIC, eve: EVE })) {
    const paired = await team.pair(member);
    expect(paired.token, JSON.stringify(paired.body)).toBeTruthy();
    token[who] = paired.token!;
  }
  const created = await as("ada", "POST", "/api/bots", { name: "Writer" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot.id as string;
  expect((await as("ada", "PUT", `/api/bots/${bot}/access`, { everyone: "none", people: { [BOB.email]: "chat", [VIC.email]: "view" } })).status).toBe(200);
  const made = await as("ada", "POST", "/api/groups", { memberIds: [bot], name: "Launch", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = made.body.group.id;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

describe("closing a room thread", () => {
  it("lets anyone who may post close and reopen any thread, and keeps who closed it and when", async () => {
    const thread = await answeredThread("ada", "Write the launch post");
    const before = Date.now();
    const closed = await as("bob", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.task).toMatchObject({ closedAt: expect.any(Number), closedBy: { kind: "person", id: expect.any(String), name: expect.any(String) } });
    expect(closed.body.task.closedAt).toBeGreaterThanOrEqual(before);
    expect(closed.body.task.closedBy.name).toMatch(/bob/i);
    expect((await taskFor("ada", thread))?.closedBy).toEqual(closed.body.task.closedBy);
    const summary = await as("ada", "GET", `/api/groups/${room}/threads/summary`);
    expect((summary.body.threads as Array<{ threadId: string }>).map((row) => row.threadId)).toContain(thread);

    const again = await as("ada", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: true });
    expect(again.body.task.closedBy).toEqual(closed.body.task.closedBy);
    const reopened = await as("ada", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: false });
    expect(reopened.status).toBe(200);
    expect(reopened.body.task).not.toHaveProperty("closedAt");
    expect(await taskFor("bob", thread)).not.toHaveProperty("closedBy");
  });

  it("refuses someone who may only view the room, and answers someone who cannot see it as if it did not exist", async () => {
    const thread = await answeredThread("ada", "Check the press list");
    expect((await as("vic", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: true })).status).toBe(403);
    expect((await as("eve", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: true })).status).toBe(404);
    expect((await as("bob", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: "yes" })).status).toBe(400);
    expect((await as("bob", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closedBy: { kind: "bot", id: "x", name: "x" } })).status).toBe(400);
    expect(await taskFor("ada", thread)).not.toHaveProperty("closedAt");
  });

  it("opens a closed thread again when a new line arrives in it", async () => {
    const thread = await answeredThread("bob", "Draft the FAQ");
    expect((await as("ada", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: true })).status).toBe(200);
    expect((await as("bob", "POST", `/api/groups/${room}/messages`, { text: "One more question for the FAQ", threadId: thread })).status).toBeLessThan(300);
    await until(async () => (await taskFor("ada", thread))?.closedAt === undefined);
    expect(await taskFor("bob", thread)).not.toHaveProperty("closedBy");
  });

  it("leaves a person's unread mark until they read the thread", async () => {
    const thread = await answeredThread("ada", "Summarise the launch feedback");
    await until(async () => (await taskFor("bob", thread))?.unread === true);
    expect((await as("ada", "PATCH", `/api/groups/${room}/tasks/${thread}`, { closed: true })).status).toBe(200);
    const bobs = await taskFor("bob", thread);
    expect(bobs).toMatchObject({ unread: true, closedAt: expect.any(Number) });
    expect((await as("bob", "POST", `/api/groups/${room}/read`, { threadId: thread })).status).toBe(200);
    await until(async () => (await taskFor("bob", thread))?.unread !== true);
    expect((await taskFor("bob", thread))?.closedAt).toEqual(bobs?.closedAt);
  });
});

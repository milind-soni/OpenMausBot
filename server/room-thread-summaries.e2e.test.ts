// A room's feed on a real Team Cloud: Ada (an Admin) makes a room of two bots shared with Bob, and Eve, who is not
// added to either bot, cannot see it. A thread made for the feed leaves the room's current thread where it was, and
// the summaries answer each person who can see the room and nobody else. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { RoomThreadSummary } from "../shared/room-threads.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const EVE = { email: "eve@acme.test", role: "member" as const };

let fx: CloudSendFixture, team: CloudTeamFixture;
const token: Record<string, string> = {};
let room = "", roomThread = "";
const roomBots: string[] = [];

const as = (who: string, method: string, path: string, body?: unknown) => team.as(token[who]!, method, path, body);

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
  for (const [who, member] of Object.entries({ ada: ADA, bob: BOB, eve: EVE })) {
    const paired = await team.pair(member);
    expect(paired.token, JSON.stringify(paired.body)).toBeTruthy();
    token[who] = paired.token!;
  }
  const levels = { everyone: "none", people: { [BOB.email]: "chat" } };
  for (const name of ["Kiwi", "Pip"]) {
    const created = await as("ada", "POST", "/api/bots", { name });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    roomBots.push(created.body.bot.id);
    expect((await as("ada", "PUT", `/api/bots/${created.body.bot.id}/access`, levels)).status).toBe(200);
  }
  const made = await as("ada", "POST", "/api/groups", { memberIds: roomBots, name: "Launch", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = made.body.group.id;
  roomThread = made.body.group.threadId;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

describe("a room's thread summaries", () => {
  it("starts a thread without moving the room's current one, and summarises it once a line lands there", async () => {
    const created = await as("bob", "POST", `/api/groups/${room}/tasks`, { activate: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const thread = created.body.task.threadId as string;
    expect(thread).not.toBe(roomThread);
    expect(created.body.group.threadId).toBe(roomThread);

    const sent = await as("bob", "POST", `/api/groups/${room}/messages`, { text: "Where are we on the launch?", threadId: thread });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await until(async () => {
      const summary = await as("bob", "GET", `/api/groups/${room}/threads/summary`);
      return (summary.body.threads as RoomThreadSummary[]).some((row) => row.threadId === thread && row.replies > 0);
    });
    const after = await as("ada", "GET", `/api/groups/${room}/threads/summary`);
    expect(after.status).toBe(200);
    const row = (after.body.threads as RoomThreadSummary[]).find((candidate) => candidate.threadId === thread)!;
    expect(row.first).toMatchObject({ text: "Where are we on the launch?", speaker: { person: { name: expect.any(String) } } });
    expect(row.repliers.length).toBeGreaterThan(0);
    expect((await as("ada", "POST", `/api/groups/${room}/read`, { threadId: thread })).body.group.threadId).toBe(roomThread);
  });

  it("leaves out an archived thread unless asked for archived ones", async () => {
    const created = await as("ada", "POST", `/api/groups/${room}/tasks`, { activate: false });
    const thread = created.body.task.threadId as string;
    expect((await as("ada", "POST", `/api/groups/${room}/messages`, { text: "Old idea", threadId: thread })).status).toBeLessThan(300);
    await until(async () => ((await as("ada", "GET", `/api/groups/${room}/threads/summary`)).body.threads as RoomThreadSummary[]).some((row) => row.threadId === thread && row.first));
    expect((await as("ada", "PATCH", `/api/groups/${room}/tasks/${thread}`, { archivedAt: Date.now() })).status).toBe(200);
    const after = (await as("ada", "GET", `/api/groups/${room}/threads/summary`)).body.threads as RoomThreadSummary[];
    expect(after.map((row) => row.threadId)).not.toContain(thread);
    expect(after.map((row) => row.threadId)).toContain(roomThread);
    const shown = (await as("ada", "GET", `/api/groups/${room}/threads/summary?archived=1`)).body.threads as RoomThreadSummary[];
    expect(shown.find((row) => row.threadId === thread)?.first?.text).toBe("Old idea");
  });

  it("reads several of the room's threads for one person in one request", async () => {
    const threads: string[] = [];
    for (const text of ["First question", "Second question"]) {
      const thread = (await as("bob", "POST", `/api/groups/${room}/tasks`, { activate: false })).body.task.threadId as string;
      expect((await as("bob", "POST", `/api/groups/${room}/messages`, { text, threadId: thread })).status).toBeLessThan(300);
      threads.push(thread);
    }
    const bobsTasks = async () => ((await as("bob", "GET", "/api/bots")).body.groups as Array<{ id: string; tasks: Array<{ threadId: string; unread?: boolean; working?: boolean }> }>)
      .find((group) => group.id === room)!.tasks.filter((task) => threads.includes(task.threadId));
    // Settled before the read: each of the room's bots has answered in both threads and no turn is running, so no reply
    // lands after the read (one that did would rightly mark its thread unread again).
    await until(async () => {
      const rows = ((await as("bob", "GET", `/api/groups/${room}/threads/summary`)).body.threads as RoomThreadSummary[]).filter((row) => threads.includes(row.threadId));
      const answered = rows.length === 2 && rows.every((row) => roomBots.every((bot) => row.repliers.some((speaker) => "botId" in speaker && speaker.botId === bot)));
      const tasks = await bobsTasks();
      return answered && tasks.length === 2 && tasks.every((task) => task.unread && !task.working);
    });
    expect((await as("bob", "POST", `/api/groups/${room}/read`, { threadIds: [threads[0], 7] })).status).toBe(400);
    expect((await as("eve", "POST", `/api/groups/${room}/read`, { threadIds: threads })).status).toBe(404);
    const read = await as("bob", "POST", `/api/groups/${room}/read`, { threadIds: [...threads, "no-such-thread"] });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.read).toBe(2);
    expect((await bobsTasks()).map((task) => task.unread ?? false)).toEqual([false, false]);
  }, hostTimeout(90_000));

  it("answers someone who cannot see the room as if it did not exist", async () => {
    expect((await as("eve", "GET", `/api/groups/${room}/threads/summary`)).status).toBe(404);
    expect((await as("bob", "GET", "/api/groups/no-such-room/threads/summary")).status).toBe(404);
  });
});
